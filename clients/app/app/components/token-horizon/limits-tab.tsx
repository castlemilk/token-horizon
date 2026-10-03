import React, { useState, useEffect } from 'react'
import { ProviderLimit, StatsResponse } from './types'
import { fetchJSON, limitRows } from './api'
import { ShieldCheck, Clock } from 'lucide-react'

interface LimitsTabProps {
  serverUrl: string
  stats: StatsResponse | null
}

export const LimitsTab: React.FC<LimitsTabProps> = ({ serverUrl, stats }) => {
  const [limits, setLimits] = useState<ProviderLimit[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const rows = limitRows(limits ?? stats?.usage.limits ?? [])

  useEffect(() => {
    const controller = new AbortController()
    const fetchLimits = async () => {
      try {
        const data = await fetchJSON<{ limits?: ProviderLimit[] }>(`${serverUrl}/limits`, controller.signal)
        if (!controller.signal.aborted) {
          setLimits(data.limits ?? [])
          setStatus('ready')
        }
      } catch {
        if (!controller.signal.aborted) setStatus('unavailable')
      }
    }

    fetchLimits()
    const interval = setInterval(fetchLimits, 5000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [serverUrl])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Top banner */}
      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-sky-400" />
          <div>
            <span className="font-bold text-sm text-zinc-100 uppercase tracking-wide">Plan Limits & Quota Windows</span>
            <p className="text-xs text-zinc-400">Track available provider quota windows and their next reset.</p>
          </div>
        </div>
      </div>

      {/* Unified Table */}
      <div className="border border-zinc-800 rounded-xl overflow-hidden bg-zinc-950/60">
        <div className="grid grid-cols-6 gap-2 px-4 py-2.5 bg-zinc-900/80 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400 border-b border-zinc-800">
          <div>Provider / Profile</div>
          <div>Window / Usage</div>
          <div>Remaining</div>
          <div>Resets In</div>
          <div>Local Refresh</div>
          <div className="text-right">Priority</div>
        </div>

        <div className="divide-y divide-zinc-900 font-mono text-xs">
          {rows.length === 0 ? (
            <div role="status" className="py-8 px-4 text-center text-zinc-500">
              {status === 'loading'
                ? 'Loading limits and quota windows…'
                : status === 'unavailable'
                  ? 'The local service is unavailable. Quota windows will refresh when it reconnects.'
                  : 'No quota windows reported yet. Provider limits appear when credentials are available.'}
            </div>
          ) : (
            rows.map((row, idx) => {
              const used = row.usedPercent
              const remaining = row.remainingPercent

              return (
                <div
                  key={idx}
                  className="grid grid-cols-6 gap-2 px-4 py-3 items-center hover:bg-zinc-900/40 transition-colors"
                >
                  {/* Provider */}
                  <div className="flex flex-col">
                    <span className="font-semibold text-zinc-200">{row.provider}</span>
                    <span className="text-[10px] text-zinc-500 truncate">{row.detail || row.label}</span>
                  </div>

                  {/* The reported window and its actual usage */}
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] text-zinc-400">{row.label}</span>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div className="h-full bg-sky-500 transition-all" style={{ width: `${used}%` }} />
                      </div>
                      <span className="text-[11px] text-zinc-300 font-bold">{used}%</span>
                    </div>
                  </div>

                  {/* Remaining headroom */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${Math.min(100, remaining)}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-emerald-400 font-bold">{remaining}% left</span>
                  </div>

                  {/* Resets In */}
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-zinc-500" />
                    <span className="text-zinc-200 font-semibold">{row.resetsIn}</span>
                  </div>

                  {/* Local Refresh */}
                  <div className="text-zinc-400 text-[11px]">{row.resetDateTime}</div>

                  {/* Priority Tag */}
                  <div className="flex justify-end">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        row.urgency === 'urgent'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse'
                          : row.urgency === 'soon'
                            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                            : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {row.urgency}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
