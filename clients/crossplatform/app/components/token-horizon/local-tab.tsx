import React, { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { endpoints } from '../../api/config'
import { usePoll } from '../../api/hooks'
import { fmtTokens, fmtMemory, fmtRate } from '../../api/format'
import { Sparkline } from '../charts'
import { Banner } from './activity-tab'
import { Cpu, Play, RefreshCw } from 'lucide-react'
import type { LocalResponse } from '../../api/types'

const WINDOWS = [
  { id: '5M', points: 150, coarse: false },
  { id: '1H', points: 1800, coarse: false },
  { id: '6H', points: 720, coarse: true },
  { id: '24H', points: 2880, coarse: true },
]

/** Mirrors the Swift mlxTab: MLX/Ollama observability, local token usage,
 * runner processes — plus the interactive inference testbed. */
export const LocalTab: React.FC = () => {
  const { data: local, ok } = usePoll<LocalResponse>('local', api.local, 2000)
  const [windowId, setWindowId] = useState('5M')
  const win = WINDOWS.find((w) => w.id === windowId) ?? WINDOWS[0]

  const series = (name: 'cpu' | 'memory' | 'disk' | 'tok' | 'prefill'): number[] => {
    const s = local?.series
    if (!s) return []
    const arr = win.coarse ? s[`${name}Coarse` as keyof typeof s] : s[name]
    return (arr as number[]).slice(-win.points)
  }
  const peak = (name: 'cpu' | 'memory' | 'disk' | 'tok' | 'prefill') => Math.max(0, ...series(name))

  const procs = local?.processes ?? []
  const totals = local?.totals
  const ollama = local?.ollama
  const idle = procs.length === 0

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Cpu className="w-5 h-5 text-teal-400" />}
        title="MLX & Local Observability"
        sub="Local inference runners, measured tok/s, and Ollama telemetry — the macOS MLX tab."
      />

      <div className="flex items-center gap-3">
        <span
          className={`text-[10px] font-mono font-bold uppercase tracking-wider ${idle ? 'text-zinc-500' : 'text-emerald-400'}`}
        >
          {!ok ? 'API OFFLINE — /local needs a rebuilt daemon' : idle ? 'IDLE' : `ACTIVE · ${procs.length} PROCS`}
        </span>
        {local?.proxyPort && (
          <span className="text-[10px] font-mono text-zinc-500">telemetry proxy 127.0.0.1:{local.proxyPort}</span>
        )}
        {local?.gatewayPort && (
          <span className="text-[10px] font-mono text-zinc-500">llm gateway 127.0.0.1:{local.gatewayPort}</span>
        )}
        <div className="ml-auto flex gap-1">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              onClick={() => setWindowId(w.id)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                windowId === w.id ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {w.id}
            </button>
          ))}
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        <MiniStat
          label="CPU"
          value={idle ? (peak('cpu') > 0 ? `peak ${peak('cpu').toFixed(1)}%` : '0.0%') : `${(totals?.cpuPercent ?? 0).toFixed(1)}%`}
          color="text-red-400"
        />
        <MiniStat
          label="MEM"
          value={idle ? (peak('memory') > 0 ? `peak ${fmtMemory(peak('memory'))}` : '0M') : fmtMemory(totals?.memoryMB ?? 0)}
          color="text-cyan-300"
        />
        <MiniStat
          label="READ"
          value={idle ? (peak('disk') > 0 ? `peak ${peak('disk').toFixed(1)}M` : '0.0M/s') : fmtRate(totals?.diskReadMBps ?? 0)}
          color="text-orange-300"
        />
        <MiniStat label="WRITE" value={idle ? '0.0M/s' : fmtRate(totals?.diskWriteMBps ?? 0)} color="text-yellow-300" />
        <MiniStat label="DECODE" value={(totals?.measuredTokPerSec ?? peak('tok') ?? 0).toFixed(1)} color="text-emerald-400" />
        <MiniStat
          label="PREFILL"
          value={(totals?.measuredPrefillTokPerSec ?? peak('prefill') ?? 0).toFixed(1)}
          color="text-teal-300"
        />
      </div>

      {/* Sparklines */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(['cpu', 'memory', 'disk', 'tok', 'prefill'] as const).map((k, i) => (
          <div key={k} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
            <span className="text-[8px] font-mono font-bold uppercase tracking-wider text-zinc-500">
              {k} {windowId}
            </span>
            <Sparkline values={series(k)} color={['#ef4444', '#22d3ee', '#f97316', '#34d399', '#2dd4bf'][i]} height={30} />
          </div>
        ))}
      </div>

      {/* Local token usage */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="flex items-center gap-6 mb-3">
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Local Token Usage</span>
          <span className="text-xs font-mono text-emerald-400">{fmtTokens(ollama?.todayTokens ?? 0)} today</span>
          <span className="text-xs font-mono text-zinc-400">{fmtTokens(ollama?.allTokens ?? 0)} all-time</span>
          <span className="text-xs font-mono text-orange-300">{ollama?.messagesAll ?? 0} requests</span>
        </div>
        <div className="divide-y divide-zinc-900/60 font-mono text-[11px]">
          {Object.entries(ollama?.models ?? {})
            .filter(([, s]) => s.all > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, s]) => (
              <div key={name} className="flex items-center gap-3 py-1.5">
                <i className="w-1 h-1 rounded-full bg-teal-400 inline-block" />
                <span className="text-zinc-200 flex-1 truncate">{name}</span>
                <span className="text-zinc-500">
                  {fmtTokens(s.prompt)} in · {fmtTokens(s.eval)} out
                </span>
                <span className="text-emerald-400 w-14 text-right">{fmtTokens(s.today)}</span>
                <span className="text-zinc-300 w-14 text-right">{fmtTokens(s.all)}</span>
              </div>
            ))}
          {Object.keys(ollama?.models ?? {}).length === 0 && (
            <div className="py-3 text-center text-zinc-600 italic">no local model traffic recorded yet</div>
          )}
        </div>
      </section>

      {/* Runners */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <div className="px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
          Runners
        </div>
        {idle ? (
          <div className="px-4 py-4">
            <p className="text-[11px] font-mono text-zinc-500">no active MLX runner</p>
            <p className="text-[10px] font-mono text-zinc-600 mt-1">
              watching Ollama --mlx-engine, mlx-lm, and mlx_vlm process trees
            </p>
          </div>
        ) : (
          <table className="w-full text-[11px] font-mono">
            <tbody className="divide-y divide-zinc-900/60">
              {procs.map((p) => (
                <tr key={p.pid} className="text-zinc-300">
                  <td className="px-3 py-1.5 w-6">
                    <i className={`w-1.5 h-1.5 rounded-full inline-block ${p.cpu > 50 ? 'bg-red-400' : 'bg-emerald-400'}`} />
                  </td>
                  <td className="px-3 py-1.5 text-zinc-500">{p.pid}</td>
                  <td className="px-3 py-1.5 truncate max-w-[280px]" title={p.command}>
                    {p.model ?? p.name}
                  </td>
                  <td className="px-3 py-1.5 text-right text-orange-300">{p.cpu.toFixed(1)}%</td>
                  <td className="px-3 py-1.5 text-right text-cyan-300">{fmtMemory(p.memoryMB)}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-400">
                    {p.tokPerSec ? `${p.tokPerSec.toFixed(1)} t/s` : '-- t/s'}
                  </td>
                  <td className="px-3 py-1.5 text-right text-teal-300">
                    {p.prefillTokPerSec ? `p ${p.prefillTokPerSec.toFixed(0)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2 text-[10px] font-mono text-zinc-600 border-t border-zinc-900">
          decode/prefill tok/s are measured by the Ollama telemetry proxy or the runner's own /metrics endpoint; never
          inferred from process load.
        </p>
      </section>

      <OllamaTestbed />
    </div>
  )
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <span className="block text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`block text-sm font-mono font-bold ${color}`}>{value}</span>
    </div>
  )
}

interface LocalModel {
  name: string
  size: number
  details?: { parameter_size?: string; quantization_level?: string }
}

/** Ollama inference testbed — fires through the telemetry proxy so tok/s is
 * recorded into the daemon's local-usage rollup. */
const OllamaTestbed: React.FC = () => {
  const [models, setModels] = useState<LocalModel[]>([])
  const [selected, setSelected] = useState('')
  const [prompt, setPrompt] = useState('Explain how Token Horizon tracks local tok/s in one sentence.')
  const [response, setResponse] = useState('')
  const [running, setRunning] = useState(false)
  const [metrics, setMetrics] = useState<{ tokPerSec: string; tokens: number } | null>(null)

  useEffect(() => {
    fetch(`${endpoints.proxy}/api/tags`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.models) {
          setModels(d.models)
          if (d.models[0]) setSelected(d.models[0].name)
        }
      })
      .catch(() => {})
  }, [])

  const run = async () => {
    if (!prompt.trim() || !selected || running) return
    setRunning(true)
    setResponse('')
    setMetrics(null)
    try {
      const res = await fetch(`${endpoints.proxy}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: selected, prompt, stream: false }),
      })
      const data = await res.json()
      setResponse(data.response || `Error: ${res.status}`)
      const sec = (data.eval_duration || 0) / 1e9
      setMetrics({ tokPerSec: sec > 0 ? ((data.eval_count || 0) / sec).toFixed(1) : 'N/A', tokens: data.eval_count || 0 })
    } catch (e) {
      setResponse(`Connection failed: ${(e as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
          Inference Testbed — via telemetry proxy {endpoints.proxy}
        </span>
        {metrics && (
          <span className="text-[10px] font-mono font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
            {metrics.tokPerSec} tok/s · {metrics.tokens} tok
          </span>
        )}
      </div>
      <div className="flex gap-3">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-200 outline-none"
        >
          {models.length === 0 && <option value="">no local models</option>}
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name} · {(m.size / 1e9).toFixed(1)}GB
              {m.details?.quantization_level ? ` · ${m.details.quantization_level}` : ''}
            </option>
          ))}
        </select>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 outline-none focus:border-amber-500"
        />
        <button
          onClick={run}
          disabled={running || !selected}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium disabled:opacity-50"
        >
          {running ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Run
        </button>
      </div>
      {(response || running) && (
        <pre className="bg-black/80 border border-zinc-800 rounded-lg p-3 font-mono text-[11px] text-zinc-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
          {running ? 'Evaluating…' : response}
        </pre>
      )}
    </section>
  )
}
