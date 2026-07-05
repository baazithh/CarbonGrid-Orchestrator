"use client";

import React, { useState, useEffect } from "react";
import { 
  Activity, Cpu, ShieldAlert, Database, Clock, Zap, MapPin, 
  Sliders, Layers, RefreshCw, Send, CheckCircle, BarChart3, 
  Search, Terminal, ArrowRight, Sun, Layers3
} from "lucide-react";

// Standard Regions Config
const REGIONS_DETAILS: Record<string, { lat: number; lng: number; desc: string; type: string }> = {
  "US-East": { lat: 38.9072, lng: -77.0369, desc: "Virginia - Stable Coal/Gas power mix", type: "Fossil Dominant" },
  "US-West": { lat: 45.8283, lng: -120.3089, desc: "Oregon - Clean Hydro base load", type: "Low Carbon Hydro" },
  "EU-Central": { lat: 50.1109, lng: 8.6821, desc: "Frankfurt - Volatile Wind/Solar mix", type: "Variable Renewable" },
  "AP-Northeast": { lat: 35.6764, lng: 139.6500, desc: "Tokyo - High baseline cost fossil grid", type: "Premium Fossil" },
  "SA-East": { lat: -23.5505, lng: -46.6333, desc: "São Paulo - Clean Hydro/Solar mix", type: "Hydro/Solar Heavy" }
};

const POWER_DRAW_KW = 0.25; // 250W node
const NET_CO2_GB = 0.05;
const NET_USD_GB = 0.01;

// Client-side Scheduler preview function
function getClientOptimizationPreview(
  forecastData: Record<string, any[]>,
  payload: number,
  runtime: number,
  deadline: number,
  wCarbon: number,
  wCost: number,
  wDelay: number,
  sourceReg: string
) {
  if (!forecastData || Object.keys(forecastData).length === 0) return null;
  
  const slots = Math.max(1, Math.round(runtime));
  const maxOffset = Math.min(Math.floor(Math.max(0, deadline - runtime)), 24 - slots);
  
  let bestScore = Infinity;
  let bestRegion = sourceReg;
  let bestOffset = 0;
  let bestMetrics = { carbon: 0, cost: 0, emission: 0, price: 0 };
  
  // Base case: US-East (US-East is a good proxy or use source)
  const sourceForecast = forecastData[sourceReg] || [];
  let baseCar = 0, baseCos = 0;
  for (let i = 0; i < Math.min(slots, sourceForecast.length); i++) {
    baseCar += sourceForecast[i].carbon_intensity;
    baseCos += sourceForecast[i].cost_per_kwh;
  }
  const baseAvgCar = baseCar / Math.min(slots, sourceForecast.length || 1);
  const baseAvgCos = baseCos / Math.min(slots, sourceForecast.length || 1);
  const baseEmissions = baseAvgCar * POWER_DRAW_KW * runtime;
  const basePrice = baseAvgCos * POWER_DRAW_KW * runtime;

  Object.entries(forecastData).forEach(([region, hrs]) => {
    for (let offset = 0; offset <= maxOffset; offset++) {
      let carbonSum = 0;
      let costSum = 0;
      for (let j = offset; j < Math.min(offset + slots, hrs.length); j++) {
        carbonSum += hrs[j].carbon_intensity;
        costSum += hrs[j].cost_per_kwh;
      }
      const avgCar = carbonSum / slots;
      const avgCos = costSum / slots;
      
      const compEmissions = avgCar * POWER_DRAW_KW * runtime;
      const compCost = avgCos * POWER_DRAW_KW * runtime;
      
      const egressCO2 = region !== sourceReg ? payload * NET_CO2_GB : 0;
      const egressUSD = region !== sourceReg ? payload * NET_USD_GB : 0;
      
      const totalCO2 = compEmissions + egressCO2;
      const totalUSD = compCost + egressUSD;
      
      const normCarbon = totalCO2 / (600 * POWER_DRAW_KW * runtime + payload * NET_CO2_GB + 1e-5);
      const normCost = totalUSD / (0.35 * POWER_DRAW_KW * runtime + payload * NET_USD_GB + 1e-5);
      const normDelay = offset / Math.max(1, deadline);
      
      const score = wCarbon * normCarbon + wCost * normCost + wDelay * normDelay;
      
      if (score < bestScore) {
        bestScore = score;
        bestRegion = region;
        bestOffset = offset;
        bestMetrics = { carbon: avgCar, cost: avgCos, emission: totalCO2, price: totalUSD };
      }
    }
  });

  return {
    region: bestRegion,
    offset: bestOffset,
    emissions: bestMetrics.emission,
    cost: bestMetrics.price,
    carbonSavings: Math.max(0, baseEmissions - bestMetrics.emission),
    costSavings: Math.max(0, basePrice - bestMetrics.price),
    baseEmissions,
    baseCost: basePrice
  };
}

export default function CarbonGridCockpit() {
  const [activeTab, setActiveTab] = useState<"deck" | "scheduler" | "forecast" | "audit">("deck");
  const [metrics, setMetrics] = useState<any>(null);
  const [forecast, setForecast] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [form, setForm] = useState({
    name: "Quantum GIS Tile Aggregator",
    payloadSize: 120.0,
    computeHours: 4.0,
    deadlineHours: 12.0,
    weightCarbon: 0.6,
    weightCost: 0.3,
    weightDelay: 0.1,
    sourceRegion: "US-East"
  });

  const [submitting, setSubmitting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<any>(null);
  const [searchLogQuery, setSearchLogQuery] = useState("");

  const fetchData = async (showRefIndicator = false) => {
    if (showRefIndicator) setRefreshing(true);
    else setLoading(true);
    
    setError(null);
    try {
      const [resMetrics, resForecast, resJobs, resLogs] = await Promise.all([
        fetch("/api/metrics"),
        fetch("/api/forecast"),
        fetch("/api/jobs"),
        fetch("/api/audit-logs")
      ]);

      if (!resMetrics.ok || !resForecast.ok || !resJobs.ok || !resLogs.ok) {
        throw new Error("One or more backend routers returned an error status.");
      }

      const rawMetrics = await resMetrics.json();
      const rawForecast = await resForecast.json();
      const rawJobs = await resJobs.json();
      const rawLogs = await resLogs.json();

      setMetrics(rawMetrics);
      setForecast(rawForecast);
      setJobs(rawJobs);
      setAuditLogs(rawLogs);
    } catch (e: any) {
      setError(e.message || "Failed connecting to local engine ports.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Poll metrics every 10 seconds for real-time telemetry updates
    const interval = setInterval(() => {
      fetchData(true);
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.deadlineHours < form.computeHours) {
      alert("Error: Workload deadline constraint cannot be lower than compute execution duration.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          payload_size: Number(form.payloadSize),
          compute_hours: Number(form.computeHours),
          deadline_hours: Number(form.deadlineHours),
          weight_carbon: Number(form.weightCarbon),
          weight_cost: Number(form.weightCost),
          weight_delay: Number(form.weightDelay),
          source_region: form.sourceRegion
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");
      
      // Reset form variables and refresh
      setForm(prev => ({ ...prev, name: "Spatial Tile Computation Run #" + (jobs.length + 1) }));
      await fetchData(true);
    } catch (err: any) {
      alert("Error Submission: " + err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const verifyJobComplete = async (jobId: string) => {
    try {
      const res = await fetch("/api/jobs/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId })
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Task completion mutation failed");
      }
      await fetchData(true);
    } catch (err: any) {
      alert("Verification Completion Error: " + err.message);
    }
  };

  // Preview Optimization Calculations
  const preview = forecast ? getClientOptimizationPreview(
    forecast,
    form.payloadSize,
    form.computeHours,
    form.deadlineHours,
    form.weightCarbon,
    form.weightCost,
    form.weightDelay,
    form.sourceRegion
  ) : null;

  // Filter audit logs
  const filteredLogs = auditLogs.filter(log => {
    if (!searchLogQuery) return true;
    const query = searchLogQuery.toLowerCase();
    return (
      log.job_id.toLowerCase().includes(query) ||
      log.event_type.toLowerCase().includes(query) ||
      (log.metadata?.job?.name && log.metadata.job.name.toLowerCase().includes(query))
    );
  });

  return (
    <div className="flex-1 flex flex-col grid-bg scanline-effect min-h-screen bg-[#03060f]">
      {/* Top Banner Control Workspace */}
      <header className="border-b border-cyber-blue/15 navbar bg-[#050a1b]/98 px-6 py-4 flex flex-col md:flex-row justify-between items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-[#00f0ff]/10 p-2 rounded border border-[#00f0ff]/30 glow-blue animate-pulse">
            <Activity className="w-6 h-6 text-cyber-blue" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              CARBONGRID <span className="text-cyber-blue neon-text-blue font-mono font-normal">ORCHESTRATOR</span>
            </h1>
            <p className="text-xs text-slate-400 font-mono">Autonomous Spatial Scheduling Stack • H3 Res4</p>
          </div>
        </div>

        {/* Global Stats bar */}
        <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
          <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/60 border border-slate-700/40 rounded">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-slate-400">ENGINE:</span>
            <span className="text-white font-semibold">ACTIVE</span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/60 border border-[#00f0ff]/20 rounded">
            <span className="text-slate-400">JOBS:</span>
            <span className="text-cyber-blue font-semibold">{jobs.length} total</span>
          </div>

          <button 
            onClick={() => fetchData(true)}
            className="flex items-center gap-2 hover:bg-slate-800 transition active:scale-95 px-3 py-1.5 rounded bg-slate-900 border border-slate-700 font-semibold cursor-pointer text-slate-200"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-cyber-blue" : ""}`} />
            Refresh
          </button>
        </div>
      </header>

      {/* Workspace Tabs Navigation */}
      <nav className="bg-[#040816]/90 border-b border-white/5 px-6 py-3 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab("deck")}
          className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-mono tracking-wider font-medium cursor-pointer transition ${
            activeTab === "deck" 
              ? "bg-[#00f0ff]/10 text-cyber-blue border border-[#00f0ff]/30 glow-blue" 
              : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
          }`}
        >
          <Layers3 className="w-4 h-4" />
          [1. OBSERVATION DECK]
        </button>

        <button
          onClick={() => setActiveTab("scheduler")}
          className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-mono tracking-wider font-medium cursor-pointer transition ${
            activeTab === "scheduler" 
              ? "bg-[#05ffb0]/10 text-cyber-green border border-[#05ffb0]/30 glow-green" 
              : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
          }`}
        >
          <Sliders className="w-4 h-4" />
          [2. SCHEDULER ENGINE]
        </button>

        <button
          onClick={() => setActiveTab("forecast")}
          className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-mono tracking-wider font-medium cursor-pointer transition ${
            activeTab === "forecast" 
              ? "bg-[#c084fc]/10 text-cyber-purple border border-[#c084fc]/30 glow-purple" 
              : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
          }`}
        >
          <Clock className="w-4 h-4" />
          [3. FORECAST STUDIO]
        </button>

        <button
          onClick={() => setActiveTab("audit")}
          className={`flex items-center gap-2 px-4 py-2 rounded text-sm font-mono tracking-wider font-medium cursor-pointer transition ${
            activeTab === "audit" 
              ? "bg-amber-400/10 text-amber-400 border border-amber-400/30" 
              : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
          }`}
        >
          <Database className="w-4 h-4" />
          [4. AUDIT & LINEAGE]
        </button>
      </nav>

      {/* Main Panel Canvas Area */}
      <main className="flex-1 p-6 flex flex-col max-w-7xl w-full mx-auto">
        {error && (
          <div className="mb-6 p-4 bg-cyber-red/10 border border-cyber-red/30 rounded flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-cyber-red shrink-0 mt-0.5" />
            <div>
              <h3 className="font-bold text-white font-mono">CONNECTION DISRUPTED</h3>
              <p className="text-sm text-slate-300 mt-1">{error}</p>
              <p className="text-xs text-slate-500 font-mono mt-2">Check if clickhouse container and FastAPI process uvicorn are run locally.</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center py-24 gap-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-4 border-cyber-blue/15"></div>
              <div className="absolute inset-0 rounded-full border-4 border-t-cyber-blue animate-spin"></div>
            </div>
            <p className="text-sm text-slate-400 font-mono animate-pulse">Establishing secure handshake matrix with datastores...</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col">
            {/* ==================== SCREEN 1: OBSERVATION DECK ==================== */}
            {activeTab === "deck" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">
                {/* SVG Visual Map Node Indicators */}
                <div className="lg:col-span-2 glass-panel border-white/5 rounded-lg p-5 flex flex-col order-1">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-sm font-mono text-slate-300 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-cyber-blue"></span>
                      GLOBAL SPATIAL REGIONS & H3 TOPOLOGY
                    </h2>
                    <span className="text-[10px] text-slate-500 font-mono">[Uber H3 Res4 - Index Cells Mapping]</span>
                  </div>

                  <div className="flex-1 bg-slate-950/80 border border-slate-900 rounded relative min-h-[350px] flex items-center justify-center p-4">
                    {/* SVG map background */}
                    <svg viewBox="0 0 800 400" className="w-full h-full opacity-60">
                      {/* Grid representation */}
                      <pattern id="dot-pattern" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                        <circle cx="2" cy="2" r="1.2" fill="rgba(0, 240, 255, 0.08)" />
                      </pattern>
                      <rect width="100%" height="100%" fill="url(#dot-pattern)" />
                      
                      {/* Mock Continent outlines built dynamically inside SVG */}
                      <path d="M 120 180 Q 200 120 280 180 T 400 190 T 500 240 T 480 300 Q 300 220 120 180 Z" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)" />
                      <path d="M 450 150 Q 550 100 650 120 T 750 180 T 680 320 Q 550 280 450 150 Z" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)" />

                      {/* Region coordinates pins */}
                      {Object.entries(REGIONS_DETAILS).map(([name, r]) => {
                        // Project Lat Lng to SVG space coordinate math representation
                        const x = ((r.lng + 180) / 360) * 800;
                        const y = ((90 - r.lat) / 180) * 400;
                        const metric = metrics?.latest?.find((m: any) => m.region === name);
                        const intensity = metric?.carbon_intensity || 300;
                        
                        // Select color based on carbon values
                        let glowColor = "rgba(5, 255, 176, 0.4)";
                        let strokeColor = "#05ffb0";
                        if (intensity > 350) {
                          glowColor = "rgba(244, 63, 94, 0.4)";
                          strokeColor = "#f43f5e";
                        } else if (intensity > 200) {
                          glowColor = "rgba(251, 146, 60, 0.4)";
                          strokeColor = "#fb923c";
                        }

                        return (
                          <g key={name}>
                            {/* Pulse rings */}
                            <circle cx={x} cy={y} r="18" fill="none" stroke={strokeColor} strokeWidth="1" opacity="0.3" className="animate-ping" style={{ transformOrigin: `${x}px ${y}px` }} />
                            <circle cx={x} cy={y} r="8" fill={glowColor} stroke={strokeColor} strokeWidth="1.5" />
                            <text x={x + 12} y={y + 4} fill={strokeColor} fontSize="10" fontWeight="bold" fontFamily="monospace" className="neon-text-blue select-none">
                              {name}
                            </text>
                            <text x={x + 12} y={y + 15} fill="#94a3b8" fontSize="8" fontFamily="monospace" className="select-none">
                              {metric?.h3_index || "84268d3ffffffff"}
                            </text>
                          </g>
                        );
                      })}
                    </svg>

                    {/* Operational legend */}
                    <div className="absolute bottom-4 left-4 bg-slate-900/90 border border-white/5 rounded px-3 py-2 text-[10px] font-mono leading-relaxed space-y-1">
                      <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded bg-cyber-green"></span> Low Carbon Grid (&lt; 200 gCO2)</div>
                      <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded bg-cyber-orange"></span> Medium Carbon Grid (200 - 350 gCO2)</div>
                      <div className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded bg-cyber-red"></span> High Carbon Grid (&gt; 350 gCO2)</div>
                    </div>
                  </div>
                </div>

                {/* Right side telemetry widgets */}
                <div className="flex flex-col gap-5 order-2">
                  <div className="glass-panel border-white/5 rounded-lg p-5">
                    <h2 className="text-sm font-mono text-slate-300 mb-4 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-cyber-blue"></span>
                      REAL-TIME REGION FEEDER REGISTRY
                    </h2>
                    
                    <div className="space-y-4">
                      {Object.keys(REGIONS_DETAILS).map((name) => {
                        const m = metrics?.latest?.find((item: any) => item.region === name);
                        const desc = REGIONS_DETAILS[name];
                        
                        let carbonColor = "text-cyber-green";
                        if ((m?.carbon_intensity || 0) > 350) carbonColor = "text-cyber-red";
                        else if ((m?.carbon_intensity || 0) > 200) carbonColor = "text-cyber-orange";

                        return (
                          <div key={name} className="p-3 bg-slate-950/70 border border-slate-900 rounded relative group overflow-hidden">
                            {/* Decorative cyber corner */}
                            <div className="absolute top-0 right-0 w-2 h-2 bg-cyber-blue/30 group-hover:bg-cyber-blue/60 transition-colors"></div>

                            <div className="flex justify-between items-start">
                              <div>
                                <h3 className="text-sm font-bold font-mono text-white flex items-center gap-1.5">
                                  {name}
                                  <span className="text-[9px] text-slate-500 bg-slate-900 border border-white/5 px-1 rounded-sm uppercase">{desc.type}</span>
                                </h3>
                                <p className="text-[10px] text-slate-400 font-mono mt-0.5">{m?.h3_index || "83268df1fffffff"}</p>
                              </div>
                              <div className="text-right">
                                <span className={`text-sm font-mono font-bold ${carbonColor}`}>
                                  {m ? m.carbon_intensity.toFixed(1) : "---"}
                                </span>
                                <span className="text-[9px] text-slate-500 font-mono block">gCO2/kWh</span>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-white/5 text-[10px] font-mono">
                              <div>
                                <span className="text-slate-500">ENERGY PRICE:</span>
                                <span className="text-white block font-semibold">${m ? m.cost_per_kwh.toFixed(4) : "---"} / kWh</span>
                              </div>
                              <div>
                                <span className="text-slate-500">RENEWABLES RATIO:</span>
                                <span className="text-cyber-green block font-semibold">
                                  {m ? (m.renewable_ratio * 100).toFixed(0) : "---"}%
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== SCREEN 2: SCHEDULER ENGINE ==================== */}
            {activeTab === "scheduler" && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
                {/* Submit workload Form */}
                <form onSubmit={handleCreateJob} className="lg:col-span-5 glass-panel border-white/5 rounded-lg p-5 flex flex-col gap-4">
                  <h2 className="text-sm font-mono text-slate-300 pb-2 border-b border-white/5 flex items-center gap-2">
                    <span className="w-1.5 h-3 bg-cyber-green"></span>
                    SUBMIT AUTONOMOUS WORKLOAD
                  </h2>

                  <div>
                    <label className="text-[10px] text-slate-400 font-mono block mb-1">WORKLOAD NAME</label>
                    <input
                      type="text"
                      className="w-full bg-slate-900 border border-slate-700/60 focus:border-cyber-green/55 focus:outline-none rounded px-3 py-2 text-sm text-white font-mono"
                      value={form.name}
                      onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] text-slate-400 font-mono block mb-1">SOURCE REGION</label>
                      <select
                        className="w-full bg-slate-900 border border-slate-700/60 focus:border-cyber-green/55 focus:outline-none rounded px-2.5 py-2 text-sm text-white font-mono select-none"
                        value={form.sourceRegion}
                        onChange={(e) => setForm(prev => ({ ...prev, sourceRegion: e.target.value }))}
                      >
                        {Object.keys(REGIONS_DETAILS).map(r => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-400 font-mono block mb-1">PAYLOAD VOLUME (GB)</label>
                      <input
                        type="number"
                        step="any"
                        className="w-full bg-slate-900 border border-slate-700/60 focus:border-cyber-green/55 focus:outline-none rounded px-3 py-2 text-sm text-white font-mono"
                        value={form.payloadSize}
                        onChange={(e) => setForm(prev => ({ ...prev, payloadSize: Number(e.target.value) }))}
                        required
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] text-slate-400 font-mono block mb-1">RUNTIME DURATION (HRS)</label>
                      <input
                        type="number"
                        min="1"
                        max="24"
                        step="1"
                        className="w-full bg-slate-900 border border-slate-700/60 focus:border-cyber-green/55 focus:outline-none rounded px-3 py-2 text-sm text-white font-mono"
                        value={form.computeHours}
                        onChange={(e) => setForm(prev => ({ ...prev, computeHours: Number(e.target.value) }))}
                        required
                      />
                    </div>

                    <div>
                      <label className="text-[10px] text-slate-400 font-mono block mb-1">DEADLINE CONSTRAINT (HRS)</label>
                      <input
                        type="number"
                        min={form.computeHours}
                        max="24"
                        step="1"
                        className="w-full bg-slate-900 border border-slate-700/60 focus:border-cyber-green/55 focus:outline-none rounded px-3 py-2 text-sm text-white font-mono"
                        value={form.deadlineHours}
                        onChange={(e) => setForm(prev => ({ ...prev, deadlineHours: Number(e.target.value) }))}
                        required
                      />
                    </div>
                  </div>

                  {/* Priority weight sliders */}
                  <div className="pt-2 border-t border-white/5 space-y-3">
                    <h3 className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">Optimization Weight Matrix</h3>

                    <div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-300 mb-1">
                        <span>CARBON REDUCTION:</span>
                        <span className="text-cyber-green">{(form.weightCarbon * 100).toFixed(0)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        className="w-full accent-cyber-green"
                        value={form.weightCarbon}
                        onChange={(e) => {
                          const wCarbon = Number(e.target.value);
                          // Distribute remainder between cost and delay
                          const rem = 1.0 - wCarbon;
                          const ratio = form.weightCost + form.weightDelay > 0 
                            ? form.weightCost / (form.weightCost + form.weightDelay)
                            : 0.5;
                          setForm(prev => ({
                            ...prev,
                            weightCarbon: wCarbon,
                            weightCost: Number((rem * ratio).toFixed(2)),
                            weightDelay: Number((rem * (1.0 - ratio)).toFixed(2))
                          }));
                        }}
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-300 mb-1">
                        <span>COST MINIMIZATION:</span>
                        <span className="text-amber-400">{(form.weightCost * 100).toFixed(0)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        className="w-full accent-amber-400"
                        value={form.weightCost}
                        onChange={(e) => {
                          const wCost = Number(e.target.value);
                          const rem = 1.0 - wCost;
                          const ratio = form.weightCarbon + form.weightDelay > 0 
                            ? form.weightCarbon / (form.weightCarbon + form.weightDelay)
                            : 0.5;
                          setForm(prev => ({
                            ...prev,
                            weightCost: wCost,
                            weightCarbon: Number((rem * ratio).toFixed(2)),
                            weightDelay: Number((rem * (1.0 - ratio)).toFixed(2))
                          }));
                        }}
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-[10px] font-mono text-slate-300 mb-1">
                        <span>DELAY CONFLICT TOLERANCE:</span>
                        <span className="text-cyber-blue">{(form.weightDelay * 100).toFixed(0)}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        className="w-full accent-cyber-blue"
                        value={form.weightDelay}
                        onChange={(e) => {
                          const wDelay = Number(e.target.value);
                          const rem = 1.0 - wDelay;
                          const ratio = form.weightCarbon + form.weightCost > 0 
                            ? form.weightCarbon / (form.weightCarbon + form.weightCost)
                            : 0.5;
                          setForm(prev => ({
                            ...prev,
                            weightDelay: wDelay,
                            weightCarbon: Number((rem * ratio).toFixed(2)),
                            weightCost: Number((rem * (1.0 - ratio)).toFixed(2))
                          }));
                        }}
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full flex items-center justify-center gap-2 mt-4 bg-cyber-green text-black font-semibold py-2.5 px-4 rounded hover:bg-[#05ffb0]/80 transition cursor-pointer select-none active:scale-95 text-sm"
                  >
                    {submitting ? "CALCULATING MATRICES..." : "SUBMIT OPTIMIZED WORKLOAD"}
                    <Send className="w-4 h-4" />
                  </button>
                </form>

                {/* Scheduler live preview results panel */}
                <div className="lg:col-span-7 flex flex-col gap-5">
                  <div className="glass-panel border-white/5 rounded-lg p-5">
                    <h2 className="text-sm font-mono text-slate-300 mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-cyber-blue"></span>
                      OPTIMIZATION PREVIEW ESTIMATOR
                    </h2>

                    {preview ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div className="p-3 bg-slate-950/60 border border-slate-900 rounded">
                            <span className="text-[10px] text-slate-500 font-mono block">RECOMMENDED REGION</span>
                            <span className="text-sm text-cyber-blue font-bold font-mono uppercase">{preview.region}</span>
                          </div>
                          
                          <div className="p-3 bg-slate-950/60 border border-slate-900 rounded">
                            <span className="text-[10px] text-slate-500 font-mono block">OFFSET DEFERRAL</span>
                            <span className="text-sm text-white font-bold font-mono">{preview.offset === 0 ? "START NOW" : `DELAY +${preview.offset} HR`}</span>
                          </div>

                          <div className="p-3 bg-[#05ffb0]/5 border border-[#05ffb0]/20 rounded">
                            <span className="text-[10px] text-cyber-green font-mono block">PREDICTED CARBON SAVINGS</span>
                            <span className="text-sm text-cyber-green font-bold font-mono">{preview.carbonSavings.toFixed(1)} g</span>
                          </div>

                          <div className="p-3 bg-amber-400/5 border border-amber-400/20 rounded">
                            <span className="text-[10px] text-amber-400 font-mono block">ESTIMATED COST SAVINGS</span>
                            <span className="text-sm text-amber-400 font-bold font-mono">${preview.costSavings.toFixed(2)}</span>
                          </div>
                        </div>

                        {/* Interactive timeline visualization */}
                        <div className="p-4 bg-slate-950/80 border border-slate-900 rounded relative">
                          <h4 className="text-[10px] text-slate-500 font-mono uppercase mb-4">Workload Execution Timeline Comparison Slot</h4>
                          
                          {/* Visual slots flow */}
                          <div className="relative pt-1">
                            <div className="flex mb-2 items-center justify-between text-[10px] font-mono text-slate-400">
                              <span>Now (Hour 0)</span>
                              <span>Target Slot: Hour {preview.offset} to {preview.offset + form.computeHours}</span>
                              <span>Deadline (Hour {form.deadlineHours})</span>
                            </div>
                            <div className="overflow-hidden h-6 text-xs flex rounded bg-slate-900 border border-slate-800 relative">
                              {/* Offset background */}
                              {preview.offset > 0 && (
                                <div 
                                  style={{ width: `${(preview.offset / form.deadlineHours) * 100}%` }}
                                  className="h-full bg-slate-900 border-r border-dashed border-slate-700/60 flex items-center justify-center text-[9px] text-slate-600 font-mono"
                                >
                                  DEFERRED
                                </div>
                              )}
                              {/* Run window */}
                              <div 
                                style={{ width: `${(form.computeHours / form.deadlineHours) * 100}%` }}
                                className="h-full bg-[#05ffb0]/20 border-r border-l border-cyber-green/40 flex items-center justify-center text-[9px] text-[#05ffb0] font-mono font-bold animate-pulse"
                              >
                                EXECUTION
                              </div>
                              {/* Slack space */}
                              <div className="flex-1 h-full bg-transparent"></div>
                            </div>
                          </div>

                          <div className="mt-4 pt-3 border-t border-white/5 flex flex-wrap justify-between items-center text-[10px] font-mono text-slate-400">
                            <div>
                              <span>BASELINE EMISSIONS:</span>
                              <span className="text-slate-200 ml-1 font-bold">{preview.baseEmissions.toFixed(1)} gCO2</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-cyber-green">
                              <ArrowRight className="w-3.5 h-3.5" />
                              <span>OPTIMIZED:</span>
                              <span className="font-bold">{preview.emissions.toFixed(1)} gCO2 ({((preview.carbonSavings / (preview.baseEmissions || 1)) * 100).toFixed(0)}% saved)</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500 font-mono">No simulation data loaded. Wait for forecast handshakes.</p>
                    )}
                  </div>

                  {/* Active running job tracker */}
                  <div className="glass-panel border-white/5 rounded-lg p-5 flex-1">
                    <h2 className="text-sm font-mono text-slate-300 mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-cyber-green"></span>
                      ACTIVE SCHEDULED REGIONAL RUNS
                    </h2>

                    <div className="overflow-y-auto max-h-[220px] pr-2 space-y-2.5">
                      {jobs.length === 0 ? (
                        <div className="h-24 flex items-center justify-center border border-dashed border-slate-800 rounded text-slate-600 font-mono text-xs">
                          No active runs found in Datastore.
                        </div>
                      ) : (
                        jobs.map((job) => (
                          <div key={job.job_id} className="p-3 bg-slate-950/60 border border-slate-900 rounded flex justify-between items-center text-xs font-mono">
                            <div>
                              <h4 className="text-white font-bold text-sm tracking-tight">{job.name}</h4>
                              <div className="flex flex-wrap gap-2 text-[10px] text-slate-500 mt-1 uppercase text-left">
                                <span>SIZE: <b className="text-slate-300">{job.payload_size}GB</b></span>
                                <span>RUN: <b className="text-slate-300">{job.compute_hours}H</b></span>
                                <span>DEST: <b className="text-[#00f0ff]">{job.target_region}</b></span>
                              </div>
                            </div>
                            <div className="flex items-center gap-3">
                              {job.status === "RUNNING" && (
                                <span className="flex h-2 w-2 relative">
                                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyber-green opacity-75"></span>
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyber-green"></span>
                                </span>
                              )}
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                job.status === "COMPLETED" 
                                  ? "bg-slate-800 text-slate-400 border border-slate-700" 
                                  : job.status === "RUNNING"
                                    ? "bg-cyber-green/10 text-cyber-green border border-cyber-green/20 animate-pulse"
                                    : "bg-amber-400/10 text-amber-400 border border-amber-400/20"
                              }`}>
                                {job.status}
                              </span>

                              {job.status === "RUNNING" && (
                                <button
                                  onClick={() => verifyJobComplete(job.job_id)}
                                  className="flex items-center gap-1 bg-[#05ffb0]/15 hover:bg-[#05ffb0]/30 transition text-cyber-green font-semibold py-1 px-2.5 rounded border border-cyber-green/20 text-[10px] cursor-pointer"
                                >
                                  <CheckCircle className="w-3 h-3" />
                                  COMPLETE
                                </button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ==================== SCREEN 3: EMISSIONS FORECASTING STUDIO ==================== */}
            {activeTab === "forecast" && (
              <div className="glass-panel border-white/5 rounded-lg p-5 flex-1 flex flex-col">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <h2 className="text-sm font-mono text-slate-300 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-cyber-purple"></span>
                      24-HOUR REGIONAL FORECASTING STUDIO
                    </h2>
                    <p className="text-xs text-slate-500 font-mono mt-1">Multi-model carbon predictions mapping carbon-intensity curves per hour.</p>
                  </div>
                  {/* ML model flag status */}
                  <div className="flex items-center gap-2 bg-[#c084fc]/5 border border-[#c084fc]/20 rounded px-3 py-1.5 text-[10px] font-mono">
                    <Cpu className="w-3.5 h-3.5 text-cyber-purple" />
                    <span className="text-slate-400">REGRESSOR STATUS:</span>
                    <span className="text-cyber-purple font-bold">
                      {forecast?.["US-East"]?.[0]?.is_ml_forecast ? "DECISION TREE MODEL" : "SIMULATION CURVES"}
                    </span>
                  </div>
                </div>

                {forecast ? (
                  <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1">
                    {/* SVG Chart display space */}
                    <div className="lg:col-span-3 bg-slate-950/80 border border-slate-900 rounded p-4 flex flex-col justify-between">
                      <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 border-b border-white/5 pb-2 mb-2">
                        <span>CARBON INTENSITY (gCO2 / kWh) PER HOUR</span>
                        <span>24-Hour Timeline</span>
                      </div>

                      {/* SVG Line Graph */}
                      <div className="flex-1 w-full min-h-[300px] relative mt-2">
                        <svg className="w-full h-full" viewBox="0 0 600 240">
                          {/* Y-axis markings */}
                          {[100, 200, 300, 400, 500].map((val) => {
                            const y = 220 - (val / 600) * 200;
                            return (
                              <g key={val}>
                                <line x1="40" y1={y} x2="600" y2={y} stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                <text x="5" y={y + 3} fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">
                                  {val}g
                                </text>
                              </g>
                            );
                          })}

                          {/* Hours markings */}
                          {[4, 8, 12, 16, 20, 24].map((hr) => {
                            const x = 40 + (hr / 24) * 540;
                            return (
                              <g key={hr}>
                                <line x1={x} y1="20" x2={x} y2="220" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                                <text x={x - 10} y="235" fill="rgba(255,255,255,0.3)" fontSize="8" fontFamily="monospace">
                                  +{hr}H
                                </text>
                              </g>
                            );
                          })}

                          {/* Draw lines */}
                          {Object.entries(forecast).map(([region, data]: [string, any], index) => {
                            // Assign unique colors
                            const colors = ["#f43f5e", "#05ffb0", "#c084fc", "#fb923c", "#38bdf8"];
                            const color = colors[index % colors.length];
                            
                            // Map coordinates
                            // map X (40 to 580)
                            // map Y (220 to 20)
                            let points = "";
                            data.forEach((d: any, idx: number) => {
                              const x = 40 + ((idx + 1) / 24) * 540;
                              const y = 220 - (Number(d.carbon_intensity) / 600) * 200;
                              points += `${x},${y} `;
                            });

                            return (
                              <g key={region}>
                                <polyline
                                  fill="none"
                                  stroke={color}
                                  strokeWidth="2"
                                  points={points}
                                  className="transition-all hover:stroke-width-3"
                                />
                                {/* Add glowing filter via opacity replication */}
                                <polyline
                                  fill="none"
                                  stroke={color}
                                  strokeWidth="6"
                                  strokeOpacity="0.15"
                                  points={points}
                                />
                              </g>
                            );
                          })}
                        </svg>
                      </div>

                      {/* Legend color map */}
                      <div className="flex flex-wrap gap-4 justify-center pt-3 border-t border-white/5 text-[10px] font-mono">
                        {Object.keys(forecast).map((region, index) => {
                          const colors = ["#f43f5e", "#05ffb0", "#c084fc", "#fb923c", "#38bdf8"];
                          const color = colors[index % colors.length];
                          
                          return (
                            <div key={region} className="flex items-center gap-1.5">
                              <span className="w-3 h-1 inline-block" style={{ backgroundColor: color }}></span>
                              <span className="text-slate-300 uppercase">{region}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Regional detailed predictions statistics */}
                    <div className="lg:col-span-1 space-y-4 max-h-[380px] overflow-y-auto pr-1">
                      {Object.entries(forecast).map(([region, data]: [string, any]) => {
                        // Calculate metrics variables
                        const carbonValues = data.map((d: any) => d.carbon_intensity);
                        const min = Math.min(...carbonValues);
                        const max = Math.max(...carbonValues);
                        const avg = carbonValues.reduce((a: number, b: number) => a + b, 0) / carbonValues.length;

                        return (
                          <div key={region} className="p-3 bg-slate-950/70 border border-slate-900 rounded">
                            <h4 className="text-white font-mono font-bold text-xs border-b border-white/5 pb-1 mb-2">
                              {region} STATS
                            </h4>
                            <div className="space-y-1.5 text-[10px] font-mono">
                              <div className="flex justify-between">
                                <span className="text-slate-500">PEAK MINIMUM:</span>
                                <span className="text-cyber-green font-bold">{min.toFixed(0)} g/kWh</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-500">PEAK MAXIMUM:</span>
                                <span className="text-cyber-red font-bold">{max.toFixed(0)} g/kWh</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="text-slate-500">24H AVERAGE:</span>
                                <span className="text-white font-bold">{avg.toFixed(0)} g/kWh</span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 font-mono">No simulation forecast logs loaded.</p>
                )}
              </div>
            )}

            {/* ==================== SCREEN 4: AUDIT & LINEAGE VAULT ==================== */}
            {activeTab === "audit" && (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
                {/* Audit Logs list panel */}
                <div className="lg:col-span-7 glass-panel border-white/5 rounded-lg p-5 flex flex-col gap-4">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <h2 className="text-sm font-mono text-slate-300 flex items-center gap-2">
                      <span className="w-1.5 h-3 bg-amber-400"></span>
                      OPENLINEAGE COMPLIANCE LIFECYCLE AUDIT LOGS
                    </h2>
                    
                    {/* Search filter */}
                    <div className="relative w-full md:w-48">
                      <input
                        type="text"
                        placeholder="Search UUID/events..."
                        className="w-full bg-slate-900 border border-slate-800 focus:border-amber-400/50 focus:outline-none rounded pl-8 pr-2.5 py-1 text-xs text-white font-mono"
                        value={searchLogQuery}
                        onChange={(e) => setSearchLogQuery(e.target.value)}
                      />
                      <Search className="absolute left-2.5 top-1.5 w-3.5 h-3.5 text-slate-500" />
                    </div>
                  </div>

                  <div className="flex-1 overflow-x-auto min-h-[300px]">
                    <table className="w-full border-collapse font-mono text-xs text-left">
                      <thead>
                        <tr className="border-b border-white/5 text-slate-500 text-[10px] tracking-wider uppercase">
                          <th className="py-2.5 px-3">TIMESTAMP</th>
                          <th className="py-2.5 px-3">EVENT TYPE</th>
                          <th className="py-2.5 px-2">JOB CLASSIFICATION</th>
                          <th className="py-2.5 px-3">ACTION</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 text-slate-300">
                        {filteredLogs.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-12 text-center text-slate-500">
                              No matching audit events located.
                            </td>
                          </tr>
                        ) : (
                          filteredLogs.map(log => (
                            <tr key={log.log_id} className={`hover:bg-white/5 transition cursor-pointer ${selectedLog?.log_id === log.log_id ? "bg-[#00f0ff]/5" : ""}`} onClick={() => setSelectedLog(log)}>
                              <td className="py-2.5 px-3 whitespace-nowrap text-slate-400">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </td>
                              <td className="py-2.5 px-3">
                                <span className={`px-1.5 py-0.5 rounded font-bold text-[9px] ${
                                  log.event_type === "COMPLETE" 
                                    ? "bg-slate-800 text-slate-300 border border-slate-700" 
                                    : log.event_type === "START"
                                      ? "bg-cyber-green/10 text-cyber-green border border-cyber-green/20"
                                      : "bg-cyber-blue/10 text-cyber-blue border border-cyber-blue/20"
                                }`}>
                                  {log.event_type}
                                </span>
                              </td>
                              <td className="py-2.5 px-2 font-semibold text-white whitespace-nowrap max-w-[120px] overflow-hidden text-ellipsis">
                                {log.metadata?.job?.name || "Pipeline Route API"}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                <span className="text-cyber-blue hover:underline text-[10px]">INSPECT JSON</span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Right side JSON visualizer */}
                <div className="lg:col-span-5 glass-panel border-white/5 rounded-lg p-5 flex flex-col gap-4">
                  <h3 className="text-sm font-mono text-slate-300 flex items-center gap-2">
                    <span className="w-1.5 h-3 bg-cyber-blue"></span>
                    LOG LINEAGE AUDIT CORE DATA METADATA
                  </h3>

                  {selectedLog ? (
                    <div className="flex-1 flex flex-col gap-3 min-h-[300px]">
                      <div className="bg-slate-950/90 rounded border border-slate-900 p-3 font-mono text-[10px] space-y-1 overflow-x-auto select-all selection:bg-cyber-blue/20">
                        <div className="flex items-center justify-between text-slate-500 pb-1.5 mb-2 border-b border-white/5 text-[9px] uppercase">
                          <span>OpenLineage Standard Spec</span>
                          <span>JSON format</span>
                        </div>
                        <pre className="text-slate-300 text-left max-h-[300px] overflow-y-auto leading-relaxed">
                          {JSON.stringify(selectedLog.metadata, null, 2)}
                        </pre>
                      </div>

                      {/* Display scheduled mapping if present */}
                      {selectedLog.metadata?.run?.facets?.routing_optimizations && (
                        <div className="p-3 bg-slate-950/60 border border-slate-900 rounded font-mono text-[10px] space-y-1.5">
                          <h4 className="text-white font-bold uppercase text-[9px] text-slate-400">Optimization Diagnostics</h4>
                          <div className="flex justify-between"><span className="text-slate-500">ROUTED TO:</span> <span className="text-cyber-blue font-bold">{selectedLog.metadata.run.facets.routing_optimizations.destination_region}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500">SAVINGS (CO2):</span> <span className="text-cyber-green font-bold">{Number(selectedLog.metadata.run.facets.routing_optimizations.predicted_carbon_savings_g).toFixed(1)} g</span></div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-slate-800 rounded p-6 text-center">
                      <Terminal className="w-8 h-8 text-slate-600 mb-2 animate-bounce" />
                      <p className="text-xs text-slate-500 font-mono">Select any log event row to inspect its active OpenLineage JSON telemetry properties.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
