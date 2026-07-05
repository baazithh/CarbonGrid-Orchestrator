import os
import uuid
import json
from datetime import datetime
import clickhouse_connect

CLICKHOUSE_HOST = os.getenv("CLICKHOUSE_HOST", "localhost")
CLICKHOUSE_PORT = int(os.getenv("CLICKHOUSE_PORT", "8123"))
CLICKHOUSE_USER = os.getenv("CLICKHOUSE_USER", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "carbongridpassword")

def get_client():
    return clickhouse_connect.get_client(
        host=CLICKHOUSE_HOST,
        port=CLICKHOUSE_PORT,
        username=CLICKHOUSE_USER,
        password=CLICKHOUSE_PASSWORD
    )

def init_db():
    client = get_client()

    # Create grid_metrics table (using ReplacingMergeTree to ensure idempotency and deduplication)
    client.command("""
        CREATE TABLE IF NOT EXISTS grid_metrics (
            h3_index String,
            region String,
            timestamp DateTime,
            carbon_intensity Float32,
            cost_per_kwh Float32,
            renewable_ratio Float32
        ) ENGINE = ReplacingMergeTree()
        ORDER BY (region, h3_index, timestamp)
    """)

    # Create jobs table
    client.command("""
        CREATE TABLE IF NOT EXISTS jobs (
            job_id UUID,
            name String,
            payload_size Float64,
            compute_hours Float32,
            deadline_hours Float32,
            weight_carbon Float32,
            weight_cost Float32,
            weight_delay Float32,
            status String,
            target_region String,
            target_h3 String,
            scheduled_time DateTime,
            carbon_savings_g Float32,
            created_at DateTime
        ) ENGINE = MergeTree()
        ORDER BY (job_id, created_at)
    """)

    # Create audit_logs table for OpenLineage-compliant lifecycle audit
    client.command("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            log_id UUID,
            job_id UUID,
            event_type String,
            metadata String,
            timestamp DateTime
        ) ENGINE = MergeTree()
        ORDER BY (timestamp)
    """)
    
    print("Database structures initialized successfully.")

def insert_metrics(metrics: list[dict]):
    client = get_client()
    data = []
    for m in metrics:
        # Convert timestamp to datetime if string or integer
        ts = m.get("timestamp")
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        elif isinstance(ts, (int, float)):
            ts = datetime.utcfromtimestamp(ts)
        
        data.append([
            m["h3_index"],
            m["region"],
            ts,
            float(m["carbon_intensity"]),
            float(m["cost_per_kwh"]),
            float(m["renewable_ratio"])
        ])
    
    if data:
        client.insert(
            "grid_metrics",
            data,
            column_names=["h3_index", "region", "timestamp", "carbon_intensity", "cost_per_kwh", "renewable_ratio"]
        )

def insert_job(job: dict):
    client = get_client()
    job_id = job.get("job_id") or uuid.uuid4()
    if isinstance(job_id, str):
        job_id = uuid.UUID(job_id)
        
    created_at = job.get("created_at") or datetime.utcnow()
    scheduled_time = job.get("scheduled_time") or datetime.utcnow()
    
    client.insert(
        "jobs",
        [[
            job_id,
            job["name"],
            float(job["payload_size"]),
            float(job["compute_hours"]),
            float(job["deadline_hours"]),
            float(job["weight_carbon"]),
            float(job["weight_cost"]),
            float(job["weight_delay"]),
            job["status"],
            job["target_region"],
            job["target_h3"],
            scheduled_time,
            float(job["carbon_savings_g"]),
            created_at
        ]],
        column_names=[
            "job_id", "name", "payload_size", "compute_hours", "deadline_hours",
            "weight_carbon", "weight_cost", "weight_delay", "status",
            "target_region", "target_h3", "scheduled_time", "carbon_savings_g", "created_at"
        ]
    )
    return job_id

def update_job_status(job_id: uuid.UUID, status: str, scheduled_time: datetime, target_region: str, target_h3: str, carbon_savings_g: float):
    # ClickHouse mutations are heavy, but for a single-node prototype, ALTER TABLE UPDATE is fine.
    client = get_client()
    query = f"""
        ALTER TABLE jobs UPDATE
            status = '{status}',
            scheduled_time = '{scheduled_time.strftime('%Y-%m-%d %H:%M:%S')}',
            target_region = '{target_region}',
            target_h3 = '{target_h3}',
            carbon_savings_g = {carbon_savings_g}
        WHERE job_id = '{job_id}'
    """
    client.command(query)

def insert_audit_log(job_id: uuid.UUID, event_type: str, metadata: dict):
    client = get_client()
    log_id = uuid.uuid4()
    meta_str = json.dumps(metadata)
    
    client.insert(
        "audit_logs",
        [[
            log_id,
            job_id,
            event_type,
            meta_str,
            datetime.utcnow()
        ]],
        column_names=["log_id", "job_id", "event_type", "metadata", "timestamp"]
    )

def get_latest_metrics():
    client = get_client()
    # Deduplicate using ReplacingMergeTree rollup or argMax
    result = client.query("""
        SELECT h3_index, region, timestamp, carbon_intensity, cost_per_kwh, renewable_ratio
        FROM (
            SELECT *, row_number() OVER (PARTITION BY region ORDER BY timestamp DESC) as rn
            FROM grid_metrics
        )
        WHERE rn = 1
    """)
    cols = ["h3_index", "region", "timestamp", "carbon_intensity", "cost_per_kwh", "renewable_ratio"]
    return [dict(zip(cols, row)) for row in result.result_rows]

def get_historical_metrics(limit: int = 150):
    client = get_client()
    result = client.query(f"""
        SELECT h3_index, region, timestamp, carbon_intensity, cost_per_kwh, renewable_ratio
        FROM grid_metrics
        ORDER BY timestamp DESC
        LIMIT {limit}
    """)
    cols = ["h3_index", "region", "timestamp", "carbon_intensity", "cost_per_kwh", "renewable_ratio"]
    return [dict(zip(cols, row)) for row in result.result_rows]

def get_jobs(limit: int = 50):
    client = get_client()
    result = client.query(f"""
        SELECT job_id, name, payload_size, compute_hours, deadline_hours, weight_carbon, weight_cost, weight_delay, status, target_region, target_h3, scheduled_time, carbon_savings_g, created_at
        FROM jobs
        ORDER BY created_at DESC
        LIMIT {limit}
    """)
    cols = [
        "job_id", "name", "payload_size", "compute_hours", "deadline_hours",
        "weight_carbon", "weight_cost", "weight_delay", "status",
        "target_region", "target_h3", "scheduled_time", "carbon_savings_g", "created_at"
    ]
    formatted_jobs = []
    for row in result.result_rows:
        job_dict = dict(zip(cols, row))
        # convert UUID and DateTime objects to strings
        job_dict["job_id"] = str(job_dict["job_id"])
        job_dict["scheduled_time"] = job_dict["scheduled_time"].isoformat() if hasattr(job_dict["scheduled_time"], "isoformat") else str(job_dict["scheduled_time"])
        job_dict["created_at"] = job_dict["created_at"].isoformat() if hasattr(job_dict["created_at"], "isoformat") else str(job_dict["created_at"])
        formatted_jobs.append(job_dict)
    return formatted_jobs

def get_audit_logs(job_id: str = None, limit: int = 100):
    client = get_client()
    if job_id:
        query = f"""
            SELECT log_id, job_id, event_type, metadata, timestamp
            FROM audit_logs
            WHERE job_id = '{job_id}'
            ORDER BY timestamp DESC
            LIMIT {limit}
        """
    else:
        query = f"""
            SELECT log_id, job_id, event_type, metadata, timestamp
            FROM audit_logs
            ORDER BY timestamp DESC
            LIMIT {limit}
        """
    result = client.query(query)
    cols = ["log_id", "job_id", "event_type", "metadata", "timestamp"]
    formatted_logs = []
    for row in result.result_rows:
        log_dict = dict(zip(cols, row))
        log_dict["log_id"] = str(log_dict["log_id"])
        log_dict["job_id"] = str(log_dict["job_id"])
        log_dict["timestamp"] = log_dict["timestamp"].isoformat() if hasattr(log_dict["timestamp"], "isoformat") else str(log_dict["timestamp"])
        try:
            log_dict["metadata"] = json.loads(log_dict["metadata"])
        except Exception:
            pass
        formatted_logs.append(log_dict)
    return formatted_logs
