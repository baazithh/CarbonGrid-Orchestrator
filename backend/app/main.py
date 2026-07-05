from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from datetime import datetime

from app import datastore, forecast, scheduler
from app.daemon import GridDaemon, REGIONS

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup lifecycle
    print("Starting CarbonGrid Orchestrator backend...")
    datastore.init_db()
    
    # Instantiate and start the grid simulation daemon (runs every 10 seconds)
    daemon = GridDaemon(interval_seconds=10)
    daemon.start()
    
    yield
    
    # Shutdown lifecycle
    print("Stopping CarbonGrid Orchestrator backend...")
    daemon.stop()

app = FastAPI(
    title="CarbonGrid Orchestrator API",
    description="Spatial H3-indexed carbon-aware workload scheduler engine.",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS for local development cockpit integrations
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class JobSubmitRequest(BaseModel):
    name: str = Field(..., example="H3 Spatial Geo-tile computation")
    payload_size: float = Field(..., description="Data size in GB", gt=0)
    compute_hours: float = Field(..., description="Estimated compute runtime hours", gt=0)
    deadline_hours: float = Field(..., description="Deadline constraint in hours", gt=0)
    weight_carbon: float = Field(0.5, ge=0.0, le=1.0)
    weight_cost: float = Field(0.3, ge=0.0, le=1.0)
    weight_delay: float = Field(0.2, ge=0.0, le=1.0)
    source_region: str = Field("US-East", description="Submission source region")

class JobCompleteRequest(BaseModel):
    job_id: str

@app.get("/api/regions")
def get_regions():
    return REGIONS

@app.get("/api/metrics")
def get_metrics():
    try:
        latest = datastore.get_latest_metrics()
        historical = datastore.get_historical_metrics(limit=150)
        return {
            "latest": latest,
            "historical": historical
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/forecast")
def get_forecasts():
    try:
        now = datetime.utcnow()
        return forecast.get_24h_forecast(now)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/jobs")
def get_jobs(limit: int = 50):
    try:
        return datastore.get_jobs(limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/jobs")
def submit_job(req: JobSubmitRequest):
    try:
        # Check deadline vs compute constraint
        if req.deadline_hours < req.compute_hours:
            raise HTTPException(
                status_code=400,
                detail="Deadline hours constraint cannot be less than compute runtime hours."
            )
            
        job_id = scheduler.schedule_job(
            name=req.name,
            payload_size=req.payload_size,
            compute_hours=req.compute_hours,
            deadline_hours=req.deadline_hours,
            weight_carbon=req.weight_carbon,
            weight_cost=req.weight_cost,
            weight_delay=req.weight_delay,
            source_region=req.source_region
        )
        return {
            "status": "success",
            "message": "Job scheduled successfully",
            "job_id": job_id
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/jobs/complete")
def complete_job(req: JobCompleteRequest):
    try:
        scheduler.complete_job(req.job_id)
        return {
            "status": "success",
            "message": f"Job {req.job_id} status updated to COMPLETED"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/audit-logs")
def get_audit_logs(job_id: str = None, limit: int = 100):
    try:
        return datastore.get_audit_logs(job_id=job_id, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
