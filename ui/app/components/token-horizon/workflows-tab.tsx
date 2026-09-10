import React, { useState, useEffect, useRef } from 'react';
import { WorkflowDefinition, WorkflowRunResult, LogMessage } from './types';
import { Play, CheckCircle2, XCircle, Clock, SkipForward, Terminal, FileText, RefreshCw, Cpu, Layers } from 'lucide-react';

interface WorkflowsTabProps {
  engineUrl: string;
}

export const WorkflowsTab: React.FC<WorkflowsTabProps> = ({ engineUrl }) => {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('cloudguardian-assessment');
  const [activeRun, setActiveRun] = useState<WorkflowRunResult | null>(null);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>('agy');
  const [dryRun, setDryRun] = useState<boolean>(true);
  const [activeArtifact, setActiveArtifact] = useState<string | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const fetchWorkflows = async () => {
    try {
      const res = await fetch(`${engineUrl}/api/workflows`);
      if (res.ok) {
        const data = await res.json();
        setWorkflows(data);
        if (data.length > 0 && !selectedWorkflowId) {
          setSelectedWorkflowId(data[0].id);
        }
      }
    } catch (err) {
      console.error('Failed to fetch workflows:', err);
    }
  };

  const fetchRuns = async () => {
    try {
      const res = await fetch(`${engineUrl}/api/runs`);
      if (res.ok) {
        const data: WorkflowRunResult[] = await res.json();
        if (data.length > 0) {
          const latest = data[0];
          setActiveRun(latest);
          // fetch logs
          const logRes = await fetch(`${engineUrl}/api/runs/${latest.runId}/logs`);
          if (logRes.ok) {
            const logData = await logRes.json();
            setLogs(logData);
          }
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchWorkflows();
    fetchRuns();
    const interval = setInterval(() => {
      fetchRuns();
    }, 2000);
    return () => clearInterval(interval);
  }, [engineUrl]);

  useEffect(() => {
    // Connect WebSocket for real-time streaming logs
    const wsUrl = engineUrl.replace(/^http/, 'ws');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'log') {
            setLogs((prev) => [...prev, msg.data]);
          } else if (msg.type === 'stage_update' || msg.type === 'run_complete') {
            fetchRuns();
          }
        } catch {
          // ignore
        }
      };
    } catch {
      // ws error ignored
    }
    return () => {
      ws?.close();
    };
  }, [engineUrl]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleLaunch = async (workflowId: string) => {
    setIsLaunching(true);
    setLogs([]);
    setActiveArtifact(null);
    try {
      const payload: Record<string, any> = {
        model_provider: selectedProvider,
        dry_run: dryRun,
        org: 'mI9dMP4nwuP5cjF5Ap6a'
      };

      const res = await fetch(`${engineUrl}/api/workflows/${workflowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: payload })
      });

      if (res.ok) {
        setTimeout(fetchRuns, 500);
      }
    } catch (err) {
      console.error('Launch failed:', err);
    } finally {
      setIsLaunching(false);
    }
  };

  const selectedDef = workflows.find((w) => w.id === selectedWorkflowId) || workflows[0];

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Top action cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {workflows.map((wf) => {
          const isSelected = wf.id === selectedWorkflowId;
          const isCloudGuardian = wf.id === 'cloudguardian-assessment';

          return (
            <div
              key={wf.id}
              onClick={() => setSelectedWorkflowId(wf.id)}
              className={`flex flex-col justify-between p-4 rounded-xl border transition-all cursor-pointer ${
                isSelected
                  ? 'bg-zinc-900/90 border-sky-500/50 ring-1 ring-sky-500/20 shadow-lg shadow-sky-950/20'
                  : 'bg-zinc-900/40 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/60'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-md ${isCloudGuardian ? 'bg-sky-500/10 text-sky-400' : 'bg-purple-500/10 text-purple-400'}`}>
                      {isCloudGuardian ? <Layers className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
                    </div>
                    <span className="font-bold text-sm text-zinc-100">{wf.name}</span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400 bg-zinc-800 px-2 py-0.5 rounded">
                    v{wf.version}
                  </span>
                </div>
                <p className="text-xs text-zinc-400 mt-2 leading-relaxed">
                  {wf.description}
                </p>
              </div>

              {isSelected && (
                <div className="mt-4 pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase text-zinc-400">Provider:</span>
                    <select
                      value={selectedProvider}
                      onChange={(e) => setSelectedProvider(e.target.value)}
                      className="bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-sky-500"
                    >
                      <option value="agy">AGY (Antigravity)</option>
                      <option value="claude">Claude Code</option>
                      <option value="local">Local Ollama / MLX</option>
                      <option value="glm">Zhipu GLM</option>
                      <option value="kimi">Moonshot Kimi</option>
                    </select>

                    <label className="flex items-center gap-1.5 text-xs text-zinc-300 ml-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={dryRun}
                        onChange={(e) => setDryRun(e.target.checked)}
                        className="rounded bg-zinc-950 border-zinc-700 text-sky-500 focus:ring-0"
                      />
                      <span>Dry-Run</span>
                    </label>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLaunch(wf.id);
                    }}
                    disabled={isLaunching}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs shadow-md shadow-sky-900/30 transition-all disabled:opacity-50"
                  >
                    {isLaunching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                    <span>Run Workflow</span>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* DAG Stage Pipeline Visualizer */}
      {selectedDef && (
        <div className="flex flex-col gap-2 bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Execution Pipeline Stages
            </span>
            {activeRun && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-400 font-mono">Run: {activeRun.runId}</span>
                <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full ${
                  activeRun.status === 'completed'
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : activeRun.status === 'running'
                    ? 'bg-sky-500/20 text-sky-300 animate-pulse'
                    : 'bg-rose-500/20 text-rose-300'
                }`}>
                  {activeRun.status}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-2">
            {selectedDef.stages.map((stage, idx) => {
              const runStage = activeRun?.stages.find((s) => s.stageId === stage.id);
              const status = runStage?.status || 'pending';

              let statusBg = 'bg-zinc-950 border-zinc-800 text-zinc-400';
              let StatusIcon = Clock;

              if (status === 'completed') {
                statusBg = 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300';
                StatusIcon = CheckCircle2;
              } else if (status === 'running') {
                statusBg = 'bg-sky-950/40 border-sky-500/60 text-sky-200 ring-1 ring-sky-500/30';
                StatusIcon = RefreshCw;
              } else if (status === 'failed') {
                statusBg = 'bg-rose-950/40 border-rose-500/60 text-rose-300';
                StatusIcon = XCircle;
              } else if (status === 'skipped') {
                statusBg = 'bg-zinc-950/60 border-zinc-800/60 text-zinc-500';
                StatusIcon = SkipForward;
              }

              return (
                <div key={stage.id} className={`flex flex-col p-3 rounded-lg border ${statusBg} transition-all`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono font-bold text-zinc-400">0{idx + 1}</span>
                    <StatusIcon className={`w-3.5 h-3.5 ${status === 'running' ? 'animate-spin text-sky-400' : ''}`} />
                  </div>
                  <span className="font-semibold text-xs mt-1 text-zinc-100">{stage.name}</span>
                  <div className="flex flex-col gap-1 mt-2">
                    {stage.steps.map((step) => {
                      const runStep = runStage?.steps.find((s) => s.stepId === step.id);
                      return (
                        <div key={step.id} className="flex items-center justify-between text-[10px] font-mono text-zinc-400 bg-black/40 px-2 py-1 rounded">
                          <span className="truncate">{step.name || step.id}</span>
                          <span className="uppercase text-[9px] text-zinc-400">{step.provider}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Live Terminal Output & Artifact Section */}
      <div className="flex flex-col flex-1 min-h-[260px] bg-black/90 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80 border-b border-zinc-800">
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-300">
            <Terminal className="w-3.5 h-3.5 text-sky-400" />
            <span>Workflow Console & Execution Stream</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-zinc-400">
              {logs.length} lines
            </span>
          </div>
        </div>

        <div className="flex-1 p-3 overflow-y-auto font-mono text-xs text-zinc-300 space-y-1 select-text">
          {logs.length === 0 ? (
            <div className="text-zinc-600 italic py-6 text-center">
              No live execution logs. Click 'Run Workflow' above to start automated analysis.
            </div>
          ) : (
            logs.map((log, idx) => {
              const time = new Date(log.timestamp).toLocaleTimeString();
              let color = 'text-zinc-300';
              if (log.level === 'error') color = 'text-rose-400 font-bold';
              else if (log.level === 'warn') color = 'text-amber-400';
              else if (log.level === 'stdout') color = 'text-emerald-400';
              else if (log.level === 'info') color = 'text-sky-300';

              return (
                <div key={idx} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-zinc-600 select-none text-[10px] pt-0.5">{time}</span>
                  <span className={`whitespace-pre-wrap ${color}`}>{log.message}</span>
                </div>
              );
            })
          )}
          <div ref={terminalEndRef} />
        </div>
      </div>
    </div>
  );
};
