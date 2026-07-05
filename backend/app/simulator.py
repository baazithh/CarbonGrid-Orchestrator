import time
import random
import httpx
from datetime import datetime

API_URL = "http://127.0.0.1:8000/api"

# Helper list of regional labels
SOURCE_REGIONS = ["US-East", "US-West", "EU-Central", "AP-Northeast", "SA-East"]

WORKLOAD_NAMES = [
  "GIS Spatial Map Res4 Grid Aggregation",
  "Satellite Image Segmentation Run",
  "Climate Time-Series Spark Compute",
  "Oceanic Flow Model Simulation",
  "Atmospheric Vapor Density Plot",
  "Telemetry Density Clustering Job",
  "Forest Canopy Biomass Grid",
  "Global Decoupling Delta Solver",
  "Grid Load Balance Optimizer Model",
  "Agritech Sensor Telemetry Merge"
]

def generate_mock_workloads(n=20):
    workloads = []
    for i in range(n):
        name = f"{random.choice(WORKLOAD_NAMES)} #{i+1}"
        payload = round(random.uniform(5.0, 500.0), 1)
        compute = round(random.uniform(1.0, 6.0), 1)
        # deadline must be >= compute
        deadline = round(compute + random.uniform(0.0, 16.0), 1)
        
        # Priority Weightings configuration
        scenario = random.choice(["carbon", "cost", "balanced", "delay-sensitive"])
        if scenario == "carbon":
            w_carbon, w_cost, w_delay = 0.8, 0.1, 0.1
        elif scenario == "cost":
            w_carbon, w_cost, w_delay = 0.1, 0.8, 0.1
        elif scenario == "delay-sensitive":
            w_carbon, w_cost, w_delay = 0.1, 0.1, 0.8
        else: # balanced
            w_carbon, w_cost, w_delay = 0.4, 0.4, 0.2
            
        workloads.append({
            "name": name,
            "payload_size": payload,
            "compute_hours": compute,
            "deadline_hours": deadline,
            "weight_carbon": w_carbon,
            "weight_cost": w_cost,
            "weight_delay": w_delay,
            "source_region": random.choice(SOURCE_REGIONS)
        })
    return workloads

def run_simulation():
    print("====================================================")
    print(" CARBONGRID ORCHESTRATOR: E2E SIMULATOR SYSTEM      ")
    print("====================================================")
    
    # 1. Warm-up checks: verify if FastAPI is online
    try:
        r = httpx.get(f"{API_URL}/regions")
        if r.status_code == 200:
            print("[+] CarbonGrid FastAPI backend server detected on port 8000.")
            use_api = True
        else:
            print("[-] API returned unexpected status code. Running direct imports instead.")
            use_api = False
    except httpx.ConnectError:
        print("[!] FastAPI API offline. We will invoke scheduler methods directly via Python.")
        use_api = False

    workloads = generate_mock_workloads(20)
    submitted_ids = []

    if use_api:
        # Submit jobs via API
        print(f"\n[1/3] Submitting {len(workloads)} workloads to API...")
        for j in workloads:
            try:
                res = httpx.post(f"{API_URL}/jobs", json=j, timeout=10.0)
                if res.status_code == 200:
                    job_id = res.json().get("job_id")
                    submitted_ids.append(job_id)
                    print(f"  -> Submitted: '{j['name']}' | Source: {j['source_region']} "
                          f"| Carbon W: {j['weight_carbon']} -> ID: {job_id}")
                else:
                    print(f"  [X] Failed submitting {j['name']}: {res.text}")
            except Exception as e:
                print(f"  [X] Error: {e}")
                
        # Retrieve scheduled jobs and identify RUNNING ones to complete
        print("\n[2/3] Querying active state job scheduler registry...")
        try:
            active_jobs_res = httpx.get(f"{API_URL}/jobs")
            if active_jobs_res.status_code == 200:
                active_jobs = active_jobs_res.json()
                running_ids = [job["job_id"] for job in active_jobs if job["status"] == "RUNNING"]
                
                print(f"  -> Detected {len(running_ids)} jobs currently RUNNING. Triggering completion mutations...")
                for job_id in running_ids:
                    comp_res = httpx.post(f"{API_URL}/jobs/complete", json={"job_id": job_id})
                    if comp_res.status_code == 200:
                        print(f"    - Completed Job UUID: {job_id}")
                    else:
                        print(f"    [X] Failed completing job {job_id}: {comp_res.text}")
            else:
                print("  [X] Failed to fetch active scheduled jobs list.")
        except Exception as e:
            print(f"  [X] Error completing jobs: {e}")

        # Summary reports
        print("\n[3/3] Analyzing scheduling performance savings report...")
        try:
            summary_jobs_res = httpx.get(f"{API_URL}/jobs")
            if summary_jobs_res.status_code == 200:
                all_jobs = summary_jobs_res.json()
                print_performance_report(all_jobs)
            else:
                print("  [X] Failed retrieving final job metrics.")
        except Exception as e:
            print(f"  [X] Error computing summary: {e}")
            
    else:
        # Standalone Python imports fallback
        print("\nRunning in Direct Protocol Mode...")
        from app import scheduler, datastore
        
        # Initialize DB structures in case it's not setup yet
        datastore.init_db()
        
        print(f"\n[1/3] Direct Scheduling {len(workloads)} workloads...")
        for j in workloads:
            try:
                job_id = scheduler.schedule_job(
                    name=j["name"],
                    payload_size=j["payload_size"],
                    compute_hours=j["compute_hours"],
                    deadline_hours=j["deadline_hours"],
                    weight_carbon=j["weight_carbon"],
                    weight_cost=j["weight_cost"],
                    weight_delay=j["weight_delay"],
                    source_region=j["source_region"]
                )
                submitted_ids.append(job_id)
                print(f"  -> Direct Scheduled: '{j['name']}' -> ID: {job_id}")
            except Exception as e:
                print(f"  [X] Direct Execution Error: {e}")
                
        print("\n[2/3] Mutating simulated running statuses...")
        jobs_list = datastore.get_jobs(limit=100)
        running_ids = [job["job_id"] for job in jobs_list if job["status"] == "RUNNING"]
        for job_id in running_ids:
            scheduler.complete_job(job_id)
            print(f"    - Closed Active Job UUID: {job_id}")
            
        print("\n[3/3] Scheduling performance metrics results: ")
        updated_jobs = datastore.get_jobs(limit=100)
        print_performance_report(updated_jobs)

def print_performance_report(all_jobs):
    if not all_jobs:
        print("  [-] No scheduled records retrieved. Performance matrix is empty.")
        return
        
    total_savings_g = 0.0
    total_jobs = len(all_jobs)
    region_counts = {}
    
    print("\n====================================================")
    print(" SCHEDULE PERFORMANCE DASHBOARD REPORT               ")
    print("====================================================")
    print(f" Total Workloads Processed: {total_jobs}")
    
    for job in all_jobs:
        total_savings_g += float(job.get("carbon_savings_g", 0.0))
        region = job.get("target_region", "N/A")
        region_counts[region] = region_counts.get(region, 0) + 1
        
    print(f" Cumulative CO2 Offset Savings: {total_savings_g:.2f} grams")
    print(" Workload Distribution by Target Region:")
    for reg, cnt in region_counts.items():
        print(f"  - {reg}: {cnt} jobs ({(cnt/total_jobs)*100:.1f}%)")
    print("====================================================\n")

if __name__ == "__main__":
    run_simulation()
