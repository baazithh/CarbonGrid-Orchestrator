import time
import random
import math
import threading
from datetime import datetime, timedelta
import h3

from app import datastore

REGIONS = {
    "US-East": {"lat": 38.9072, "lng": -77.0369},
    "US-West": {"lat": 45.8283, "lng": -120.3089},
    "EU-Central": {"lat": 50.1109, "lng": 8.6821},
    "AP-Northeast": {"lat": 35.6764, "lng": 139.6500},
    "SA-East": {"lat": -23.5505, "lng": -46.6333}
}

H3_RESOLUTION = 4

def get_h3_index(lat, lng, resolution=H3_RESOLUTION):
    try:
        return h3.latlng_to_cell(lat, lng, resolution)
    except AttributeError:
        return h3.geo_to_h3(lat, lng, resolution)

# Precalculate H3 cells
REGION_H3 = {r: get_h3_index(info["lat"], info["lng"]) for r, info in REGIONS.items()}

def generate_metrics_for_time(dt: datetime, add_noise=True) -> list[dict]:
    metrics = []
    hour = dt.hour + dt.minute / 60.0 + dt.second / 3600.0
    
    for region, h3_idx in REGION_H3.items():
        noise = random.uniform(-2.0, 2.0) if add_noise else 0
        
        if region == "US-East":
            # Coal/Gas heavy, high carbon, stable price
            carbon = 480.0 + 20.0 * math.sin(hour * math.pi / 12) + noise * 3
            cost = 0.10 + 0.015 * math.sin(hour * math.pi / 12) + (noise / 200)
            renewables = 0.12 + 0.03 * math.sin(hour * math.pi / 12)
        elif region == "US-West":
            # Hydro base, very clean & cheap
            carbon = 95.0 + 10.0 * math.sin(hour * math.pi / 12) + noise
            cost = 0.065 + 0.008 * math.sin(hour * math.pi / 12) + (noise / 300)
            renewables = 0.81 + 0.04 * math.sin(hour * math.pi / 12)
        elif region == "EU-Central":
            # Wind/solar heavy, highly volatile carbon and price
            # Solar peak at noon (hour 12)
            solar_factor = max(0.0, math.cos((hour - 12) * math.pi / 6))
            # Wind fluctuation is simulated using a sine wave with a shorter period (e.g. 8h)
            wind_factor = 0.4 + 0.3 * math.sin(hour * math.pi / 4)
            
            renewables = 0.25 + 0.45 * solar_factor + 0.20 * wind_factor
            renewables = max(0.05, min(0.95, renewables))
            
            # Carbon moves inversely to renewable ratio
            carbon = 420.0 - 320.0 * renewables + noise * 5
            # Cost spikes when renewable generation is low
            cost = 0.28 - 0.18 * renewables + (noise / 50)
            cost = max(0.05, cost)
        elif region == "AP-Northeast":
            # Expensive energy profile with peak/off-peak daytime pricing
            is_peak = 1.0 if 9 <= hour <= 19 else 0.0
            carbon = 380.0 + 40.0 * math.sin((hour - 9) * math.pi / 6) + noise * 4
            cost = 0.22 + 0.05 * is_peak + 0.02 * math.cos(hour * math.pi / 12)
            renewables = 0.18 + 0.06 * math.sin(hour * math.pi / 12)
        elif region == "SA-East":
            # Clean hydro baseline, medium cost
            carbon = 85.0 + 12.0 * math.sin(hour * math.pi / 12) + noise
            cost = 0.11 + 0.01 * math.sin(hour * math.pi / 12) + (noise / 200)
            renewables = 0.86 + 0.05 * math.sin(hour * math.pi / 12)
        
        # Guard rails
        carbon = max(10, carbon)
        cost = max(0.02, cost)
        renewables = max(0.0, min(1.0, renewables))
        
        metrics.append({
            "h3_index": h3_idx,
            "region": region,
            "timestamp": dt,
            "carbon_intensity": round(carbon, 2),
            "cost_per_kwh": round(cost, 4),
            "renewable_ratio": round(renewables, 3)
        })
    
    return metrics

def backfill_history():
    print("Checking database for historical metrics backfill...")
    client = datastore.get_client()
    try:
        # Check if table has data
        res = client.query("SELECT count() FROM grid_metrics")
        count = res.result_rows[0][0]
    except Exception as e:
        print(f"Error querying table size: {e}. Attempting DB init.")
        datastore.init_db()
        count = 0

    if count < 100:
        print("Seeding 48 hours of historical grid metrics...")
        now = datetime.utcnow()
        batch_metrics = []
        # Backfill hourly data for the last 48 hours
        for hours_back in range(48, -1, -1):
            time_stamp = now - timedelta(hours=hours_back)
            batch_metrics.extend(generate_metrics_for_time(time_stamp, add_noise=True))
            
        datastore.insert_metrics(batch_metrics)
        print(f"Backfill complete. Seeding done. Inserted {len(batch_metrics)} records.")
    else:
        print(f"Database already contains {count} metrics. Skipping backfill.")

def run_daemon_loop(stop_event: threading.Event, interval_seconds: int = 10):
    print("Ingestion Daemon loop started.")
    backfill_history()
    
    while not stop_event.is_set():
        try:
            now = datetime.utcnow()
            metrics = generate_metrics_for_time(now, add_noise=True)
            datastore.insert_metrics(metrics)
            # Log briefly
            # print(f"Ingested metrics for {len(metrics)} cells at {now.isoformat()}")
        except Exception as e:
            print(f"Daemon insertion error: {e}")
            
        # Sleep with checks for termination event
        for _ in range(interval_seconds):
            if stop_event.is_set():
                break
            time.sleep(1)
            
    print("Ingestion Daemon loop terminated.")

class GridDaemon:
    def __init__(self, interval_seconds: int = 10):
        self.interval_seconds = interval_seconds
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is not None:
            return
        self.stop_event.clear()
        self.thread = threading.Thread(
            target=run_daemon_loop,
            args=(self.stop_event, self.interval_seconds),
            daemon=True
        )
        self.thread.start()
        print("Ingestion Daemon thread started.")

    def stop(self):
        if self.thread is None:
            return
        self.stop_event.set()
        self.thread.join(timeout=5)
        self.thread = None
        print("Ingestion Daemon thread stopped.")

if __name__ == "__main__":
    # Test execution
    daemon = GridDaemon(2)
    daemon.start()
    try:
        time.sleep(5)
    finally:
        daemon.stop()
