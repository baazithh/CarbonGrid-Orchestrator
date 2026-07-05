import uuid
from datetime import datetime, timedelta
from app import datastore, forecast

POWER_DRAW_KW = 0.250  # 250 Watts standard server node power
NETWORK_CARBON_PER_GB = 0.05  # gCO2 per GB transferred across regions
NETWORK_COST_PER_GB = 0.01  # USD per GB egress fee across regions

def optimize_schedule(
    payload_size: float,
    compute_hours: float,
    deadline_hours: float,
    weight_carbon: float,
    weight_cost: float,
    weight_delay: float,
    source_region: str = "US-East"
) -> dict:
    
    # 1. Fetch the 24-hour predictions for all regions
    now = datetime.utcnow()
    forecasts = forecast.get_24h_forecast(now)
    
    best_score = float('inf')
    best_region = source_region
    best_offset = 0 # Schedule immediately
    
    # Track metrics for the optimal path
    optimal_metrics = {
        "carbon_intensity": 0.0,
        "cost_per_kwh": 0.0,
        "emissions_g": 0.0,
        "cost_usd": 0.0,
        "start_time": now
    }
    
    # Baseline: Run immediately in source region (US-East)
    # We find first N hours of forecast for the source region
    source_forecast = forecasts.get(source_region, [])
    source_carbon_sum = 0
    source_cost_sum = 0
    
    # Number of hourly slots to aggregate
    slots_needed = max(1, int(round(compute_hours)))
    
    for i in range(min(slots_needed, len(source_forecast))):
        source_carbon_sum += source_forecast[i]["carbon_intensity"]
        source_cost_sum += source_forecast[i]["cost_per_kwh"]
        
    baseline_avg_carbon = source_carbon_sum / min(slots_needed, len(source_forecast)) if source_forecast else 500
    baseline_avg_cost = source_cost_sum / min(slots_needed, len(source_forecast)) if source_forecast else 0.10
    
    baseline_emissions = (baseline_avg_carbon * POWER_DRAW_KW) * compute_hours
    baseline_cost = (baseline_avg_cost * POWER_DRAW_KW) * compute_hours
    
    # Search space: offsets from 0 to floor(deadline - compute_hours)
    max_offset = int(math.floor(max(0.0, deadline_hours - compute_hours)))
    # Cap at 23 to ensure we stay within the 24-hour forecast matrix
    max_offset = min(max_offset, 24 - slots_needed)
    
    for region, region_forecast in forecasts.items():
        for offset in range(max_offset + 1):
            # Calculate metrics for running at this offset
            carbon_sum = 0
            cost_sum = 0
            
            for j in range(offset, min(offset + slots_needed, len(region_forecast))):
                carbon_sum += region_forecast[j]["carbon_intensity"]
                cost_sum += region_forecast[j]["cost_per_kwh"]
                
            runs = min(slots_needed, len(region_forecast) - offset)
            avg_carbon = carbon_sum / max(1, runs)
            avg_cost = cost_sum / max(1, runs)
            
            compute_emissions = (avg_carbon * POWER_DRAW_KW) * compute_hours
            compute_cost = (avg_cost * POWER_DRAW_KW) * compute_hours
            
            # Spatial egress penalties if scheduled to a different region
            transfer_carbon = 0.0
            transfer_cost = 0.0
            if region != source_region:
                transfer_carbon = payload_size * NETWORK_CARBON_PER_GB
                transfer_cost = payload_size * NETWORK_COST_PER_GB
                
            total_emissions = compute_emissions + transfer_carbon
            total_cost = compute_cost + transfer_cost
            
            # Normalization bounds (typical range representation)
            # Max expected intensity is 600, cost is 0.35, delay is deadline_hours
            norm_carbon = total_emissions / ((600.0 * POWER_DRAW_KW * compute_hours) + (payload_size * NETWORK_CARBON_PER_GB) + 1e-5)
            norm_cost = total_cost / ((0.35 * POWER_DRAW_KW * compute_hours) + (payload_size * NETWORK_COST_PER_GB) + 1e-5)
            norm_delay = offset / max(1.0, deadline_hours)
            
            score = (
                weight_carbon * norm_carbon +
                weight_cost * norm_cost +
                weight_delay * norm_delay
            )
            
            if score < best_score:
                best_score = score
                best_region = region
                best_offset = offset
                optimal_metrics = {
                    "carbon_intensity": avg_carbon,
                    "cost_per_kwh": avg_cost,
                    "emissions_g": total_emissions,
                    "cost_usd": total_cost,
                    "start_time": now + timedelta(hours=offset)
                }

    carbon_savings = max(0.0, baseline_emissions - optimal_metrics["emissions_g"])
    cost_savings = max(0.0, baseline_cost - optimal_metrics["cost_usd"])
    
    return {
        "target_region": best_region,
        "target_h3": forecast.REGIONS[best_region], # Will fetch lat/lng coordinates to convert to H3 index
        "start_offset_hours": best_offset,
        "scheduled_time": optimal_metrics["start_time"],
        "predicted_carbon_intensity": optimal_metrics["carbon_intensity"],
        "predicted_cost_per_kwh": optimal_metrics["cost_per_kwh"],
        "predicted_emissions_g": optimal_metrics["emissions_g"],
        "predicted_cost_usd": optimal_metrics["cost_usd"],
        "carbon_savings_g": carbon_savings,
        "cost_savings_usd": cost_savings,
        "baseline_emissions_g": baseline_emissions,
        "baseline_cost_usd": baseline_cost
    }

import math

def schedule_job(
    name: str,
    payload_size: float,
    compute_hours: float,
    deadline_hours: float,
    weight_carbon: float,
    weight_cost: float,
    weight_delay: float,
    source_region: str = "US-East"
) -> str:
    
    # 1. Run optimization
    opt = optimize_schedule(
        payload_size=payload_size,
        compute_hours=compute_hours,
        deadline_hours=deadline_hours,
        weight_carbon=weight_carbon,
        weight_cost=weight_cost,
        weight_delay=weight_delay,
        source_region=source_region
    )
    
    target_region = opt["target_region"]
    # Get H3 index
    lat = forecast.REGIONS[target_region]["lat"]
    lng = forecast.REGIONS[target_region]["lng"]
    target_h3 = forecast.get_h3_index(lat, lng)
    
    job_id = uuid.uuid4()
    
    # 2. Write Job record
    job_record = {
        "job_id": job_id,
        "name": name,
        "payload_size": payload_size,
        "compute_hours": compute_hours,
        "deadline_hours": deadline_hours,
        "weight_carbon": weight_carbon,
        "weight_cost": weight_cost,
        "weight_delay": weight_delay,
        "status": "SCHEDULED" if opt["start_offset_hours"] > 0 else "RUNNING",
        "target_region": target_region,
        "target_h3": target_h3,
        "scheduled_time": opt["scheduled_time"],
        "carbon_savings_g": opt["carbon_savings_g"],
        "created_at": datetime.utcnow()
    }
    datastore.insert_job(job_record)
    
    # 3. Create OpenLineage logs
    # Log 1: Job submission (START event proxy)
    submit_metadata = {
        "eventTime": datetime.utcnow().isoformat() + "Z",
        "eventType": "START",
        "producer": "https://github.com/carbongrid/orchestrator",
        "schemaURL": "https://openlineage.io/spec/1-0-5/OpenLineage.json",
        "job": {
            "namespace": "carbongrid-scheduler",
            "name": name
        },
        "inputs": [
            {
                "namespace": f"h3:resolution_{H3_RESOLUTION}",
                "name": f"source_dataset:{forecast.get_h3_index(forecast.REGIONS[source_region]['lat'], forecast.REGIONS[source_region]['lng'])}",
                "facets": {
                    "dataSource": {
                        "uri": f"h3://{source_region}"
                    },
                    "schema": {
                        "fields": [
                            {"name": "payload_size_gb", "type": "float"}
                        ]
                    }
                }
            }
        ],
        "outputs": [
            {
                "namespace": f"h3:resolution_{H3_RESOLUTION}",
                "name": f"target_execution:{target_h3}",
                "facets": {
                    "dataSource": {
                        "uri": f"h3://{target_region}"
                    }
                }
            }
        ],
        "run": {
            "runId": str(job_id),
            "facets": {
                "scheduler_parameters": {
                    "weights": {
                        "carbon": weight_carbon,
                        "cost": weight_cost,
                        "delay": weight_delay
                    },
                    "constraints": {
                        "deadline_hours": deadline_hours,
                        "compute_hours": compute_hours
                    }
                },
                "routing_optimizations": {
                    "destination_region": target_region,
                    "offset_hours": opt["start_offset_hours"],
                    "scheduled_iso": opt["scheduled_time"].isoformat() + "Z",
                    "baseline_emissions_g": opt["baseline_emissions_g"],
                    "baseline_cost_usd": opt["baseline_cost_usd"],
                    "predicted_emissions_g": opt["predicted_emissions_g"],
                    "predicted_cost_usd": opt["predicted_cost_usd"],
                    "predicted_carbon_savings_g": opt["carbon_savings_g"],
                    "predicted_cost_savings_usd": opt["cost_savings_usd"]
                }
            }
        }
    }
    datastore.insert_audit_log(job_id, "START", submit_metadata)
    
    # If starting immediately, write RUNNING status audit log
    if job_record["status"] == "RUNNING":
        running_metadata = submit_metadata.copy()
        running_metadata["eventType"] = "RUNNING"
        running_metadata["eventTime"] = datetime.utcnow().isoformat() + "Z"
        datastore.insert_audit_log(job_id, "RUNNING", running_metadata)
        
    return str(job_id)

def complete_job(job_id: str):
    # Retrieve job parameter and complete it
    client = datastore.get_client()
    res = client.query(f"SELECT name, target_region, target_h3, carbon_savings_g, scheduled_time FROM jobs WHERE job_id = '{job_id}'")
    if not res.result_rows:
        return
    name, region, h3_idx, savings, sched_time = res.result_rows[0]
    
    uuid_id = uuid.UUID(job_id)
    datastore.update_job_status(
        job_id=uuid_id,
        status="COMPLETED",
        scheduled_time=sched_time,
        target_region=region,
        target_h3=h3_idx,
        carbon_savings_g=savings
    )
    
    complete_metadata = {
        "eventTime": datetime.utcnow().isoformat() + "Z",
        "eventType": "COMPLETE",
        "producer": "https://github.com/carbongrid/orchestrator",
        "schemaURL": "https://openlineage.io/spec/1-0-5/OpenLineage.json",
        "job": {
            "namespace": "carbongrid-scheduler",
            "name": name
        },
        "inputs": [],
        "outputs": [],
        "run": {
            "runId": job_id,
            "facets": {
                "operation_summary": {
                    "execution_status": "COMPLETED",
                    "carbon_savings_g": savings
                }
            }
        }
    }
    datastore.insert_audit_log(uuid_id, "COMPLETE", complete_metadata)

if __name__ == "__main__":
    print("Testing Multi-Objective Scheduler...")
    j_id = schedule_job(
        name="Telemetry GIS aggregation run",
        payload_size=100.0,
        compute_hours=2.0,
        deadline_hours=12.0,
        weight_carbon=0.8,
        weight_cost=0.1,
        weight_delay=0.1
    )
    print(f"Scheduled Job ID: {j_id}")
    complete_job(j_id)
    print("Job completed and lineage log captured.")
