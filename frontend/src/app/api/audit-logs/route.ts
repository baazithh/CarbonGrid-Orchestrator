import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get("job_id");
    
    let url = "http://127.0.0.1:8000/api/audit-logs";
    if (jobId) {
      url += `?job_id=${encodeURIComponent(jobId)}`;
    }

    const res = await fetch(url, {
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Backend returned status ${res.status}`);
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to retrieve OpenLineage audit logs" },
      { status: 500 }
    );
  }
}
