import math
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from sklearn.tree import DecisionTreeRegressor

from app import datastore
from app.daemon import REGIONS, generate_metrics_for_time

def get_24h_forecast(now: datetime = None) -> dict[str, list[dict]]:
    if now is None:
        now = datetime.utcnow()
        
    # Get historical data for training
    # Pull up to 2000 metrics (about 400 per region)
    metrics_list = datastore.get_historical_metrics(limit=2000)
    
    forecasts = {}
    
    # Check if we have enough data to train a model
    use_ml = len(metrics_list) >= 50
    
    df = None
    if use_ml:
        df = pd.DataFrame(metrics_list)
        # Ensure timestamp is datetime
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df["hour_float"] = df["timestamp"].dt.hour + df["timestamp"].dt.minute / 60.0 + df["timestamp"].dt.second / 3600.0
        df["sin_hour"] = np.sin(df["hour_float"] * 2 * np.pi / 24.0)
        df["cos_hour"] = np.cos(df["hour_float"] * 2 * np.pi / 24.0)
        
    for region in REGIONS.keys():
        region_forecast = []
        
        region_df = None
        has_region_data = False
        if use_ml and df is not None:
            region_df = df[df["region"] == region]
            has_region_data = len(region_df) >= 10
            
        if use_ml and has_region_data and region_df is not None:
            # We train DecisionTreeRegressors for carbon, cost, renewable ratio
            X = region_df[["sin_hour", "cos_hour"]].values
            
            y_carbon = region_df["carbon_intensity"].values
            y_cost = region_df["cost_per_kwh"].values
            y_renewables = region_df["renewable_ratio"].values
            
            model_carbon = DecisionTreeRegressor(max_depth=4)
            model_cost = DecisionTreeRegressor(max_depth=4)
            model_renew = DecisionTreeRegressor(max_depth=4)
            
            model_carbon.fit(X, y_carbon)
            model_cost.fit(X, y_cost)
            model_renew.fit(X, y_renewables)
            
            # Predict for the next 24 hours
            for h in range(1, 25):
                future_time = now + timedelta(hours=h)
                future_hour = future_time.hour + future_time.minute / 60.0
                future_sin = math.sin(future_hour * 2 * math.pi / 24.0)
                future_cos = math.cos(future_hour * 2 * math.pi / 24.0)
                
                pred_X = np.array([[future_sin, future_cos]])
                
                pred_carbon = float(model_carbon.predict(pred_X)[0])
                pred_cost = float(model_cost.predict(pred_X)[0])
                pred_renew = float(model_renew.predict(pred_X)[0])
                
                # Apply bounds
                pred_carbon = max(10.0, pred_carbon)
                pred_cost = max(0.01, pred_cost)
                pred_renew = max(0.0, min(1.0, pred_renew))
                
                region_forecast.append({
                    "timestamp": future_time.isoformat(),
                    "carbon_intensity": round(pred_carbon, 2),
                    "cost_per_kwh": round(pred_cost, 4),
                    "renewable_ratio": round(pred_renew, 3),
                    "is_ml_forecast": True
                })
        else:
            # Fall back to simulation curves (which represent true physical expected curves)
            for h in range(1, 25):
                future_time = now + timedelta(hours=h)
                # Generate without random noise to represent the clean mathematical forecast curve
                metrics_at_time = generate_metrics_for_time(future_time, add_noise=False)
                # Find current region
                region_metric = next(m for m in metrics_at_time if m["region"] == region)
                
                region_forecast.append({
                    "timestamp": future_time.isoformat(),
                    "carbon_intensity": region_metric["carbon_intensity"],
                    "cost_per_kwh": region_metric["cost_per_kwh"],
                    "renewable_ratio": region_metric["renewable_ratio"],
                    "is_ml_forecast": False
                })
                
        forecasts[region] = region_forecast
        
    return forecasts

if __name__ == "__main__":
    # Test forecasting script
    print("Testing ML forecast...")
    res = get_24h_forecast()
    for region, forecast in res.items():
        print(f"Region: {region}, Length of forecast: {len(forecast)}")
        print(f"  First forecasted hour: Carbon={forecast[0]['carbon_intensity']}, Cost={forecast[0]['cost_per_kwh']}, ML={forecast[0]['is_ml_forecast']}")
