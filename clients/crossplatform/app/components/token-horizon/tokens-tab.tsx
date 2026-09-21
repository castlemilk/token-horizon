import React, { useState } from 'react'
import { api } from '../../api/client'
import { usePoll } from '../../api/hooks'
import { fmtTokens, fmtCost, toolColor } from '../../api/format'
import { StackedBars, HeatmapGrid, Stat } from '../charts'
import { Banner } from './activity-tab'
import { Coins } from 'lucide-react'

const WINDOWS = ['1D', '1W', '1M', '3M', '1Y']

/** Mirrors the Swift tokensTab: usage KPIs, per-tool/model tables, trends,
 * heatmap — plus the plan-limit rows the Swift tab merges in. */
export const TokensTab: React.FC = () => {
  const { data: stats } = usePoll('stats', api.stats, 5000)
  const [window, setWindow] = useState('1M')
  const { data: trends } = usePoll(`trends-${window}`, () => api.trends(window), 30_000)
  const { data: heatmap } = usePoll('heatmap', () => api.heatmap(28), 60_000)
  const { data: history } = usePoll('history', () => api.history(370), 60_000)
  const { data: limits } = usePoll('limits', api.limits, 30_000)

  const u = stats?.usage

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Coins className="w-5 h-5 text-amber-400" />}
        title="Token Usage"
        sub="Per-tool and per-model consumption, plan limits, trend windows, and activity heatmap."
      />

      {/* KPI row */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="tokens today" value={fmtTokens(u?.tokensToday ?? 0)} color="text-emerald-400" />
        <Kpi label="all-time" value={fmtTokens(u?.tokensAllTime ?? 0)} />
        <Kpi label="cost today" value={fmtCost(u?.costToday ?? 0)} color="text-emerald-400" />
        <Kpi label="cost all-time" value={fmtCost(u?.costAllTime ?? 0)} />
        <Kpi label="requests today" value={`${u?.requestsToday ?? 0}`} color="text-orange-300" />
        <Kpi label="streak" value={`${history?.streak ?? 0}d`} color="text-sky-400" />
      </div>

      {/* Plan limits (the Swift tokensTab folds these in via assembleLimitRows) */}
      {(limits?.limits?.length ?? 0) > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Plan Limits</span>
            {limits?.maximizerRecommendation && (
              <span className="text-[10px] font-mono text-teal-300">{limits.maximizerRecommendation}</span>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
            {(limits?.limits ?? []).map((l) => (
              <div key={`${l.provider}:${l.label}`} className="flex items-center gap-3 font-mono text-[11px]">
                <span className="text-zinc-300 w-40 truncate">
                  {l.provider} · {l.label}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className={`h-full ${l.urgency === 'urgent' ? 'bg-red-400' : l.urgency === 'soon' ? 'bg-amber-400' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(100, l.usedPercent)}%` }}
                  />
                </div>
                <span className="text-zinc-400 w-12 text-right">{l.usedPercent.toFixed(0)}%</span>
                <span className="text-zinc-500 w-20 text-right">{l.resetsInShort ?? l.resetsIn ?? ''}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Trends */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
            Token Flow — {fmtTokens(trends?.total ?? 0)}
          </span>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  window === w ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
        {trends && <StackedBars points={trends.points} />}
      </section>

      {/* Heatmap */}
      {heatmap && heatmap.grid.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
              Activity Heatmap — {fmtTokens(heatmap.total)} over {heatmap.days}d
            </span>
          </div>
          <HeatmapGrid grid={heatmap.grid} max={heatmap.max} />
        </section>
      )}

      {/* Per-tool + per-model tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Table
          title="By Tool"
          head={['tool', 'today', 'all-time', 'cost today', 'cache read']}
          rows={(u?.perTool ?? []).map((t) => ({
            key: t.tool,
            cells: [
              <span key="t" className="flex items-center gap-1.5">
                <i className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: toolColor(t.tool) }} />
                {t.tool}
              </span>,
              <span key="d" className="text-emerald-400">
                {fmtTokens(t.tokensToday)}
              </span>,
              fmtTokens(t.tokensAllTime),
              fmtCost(t.costToday),
              fmtTokens(t.cacheReadAll ?? 0),
            ],
          }))}
        />
        <Table
          title="By Model"
          head={['model', 'provider', 'today', 'all-time', 'cost']}
          rows={(u?.models ?? [])
            .slice()
            .sort((a, b) => b.tokensAll - a.tokensAll)
            .slice(0, 25)
            .map((m) => ({
              key: `${m.provider}/${m.model}`,
              cells: [
                <span key="m" className="text-zinc-200">
                  {m.model}
                </span>,
                <span key="p" className="text-zinc-500">
                  {m.provider}
                </span>,
                <span key="d" className="text-emerald-400">
                  {fmtTokens(m.tokensToday)}
                </span>,
                fmtTokens(m.tokensAll),
                m.free ? 'free' : fmtCost(m.cost),
              ],
            }))}
        />
      </div>

      {/* Projects + recent sessions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Table
          title="Projects"
          head={['directory', 'sessions', 'tokens', 'cost']}
          rows={(u?.projects ?? [])
            .slice()
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 15)
            .map((p) => ({
              key: p.directory,
              cells: [
                <span key="d" className="truncate max-w-[220px] inline-block align-middle" title={p.directory}>
                  {p.directory.split('/').pop() || p.directory}
                </span>,
                `${p.sessions}`,
                fmtTokens(p.tokens),
                fmtCost(p.cost),
              ],
            }))}
        />
        <Table
          title="Recent Sessions"
          head={['title', 'model', 'tokens', 'cost']}
          rows={(u?.recentSessions ?? []).slice(0, 15).map((s) => ({
            key: s.id,
            cells: [
              <span key="t" className="truncate max-w-[200px] inline-block align-middle" title={s.title}>
                {s.title || s.id.slice(0, 8)}
              </span>,
              <span key="m" className="text-zinc-500">
                {s.model || s.provider || '—'}
              </span>,
              fmtTokens(s.tokens),
              fmtCost(s.cost),
            ],
          }))}
        />
      </div>
    </div>
  )
}

function Kpi({ label, value, color = 'text-zinc-100' }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <Stat label={label} value={value} color={color} />
    </div>
  )
}

function Table({
  title,
  head,
  rows,
}: {
  title: string
  head: string[]
  rows: { key: string; cells: React.ReactNode[] }[]
}) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <div className="px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
        {title}
      </div>
      <div className="max-h-[300px] overflow-y-auto">
        <table className="w-full text-[11px] font-mono">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500 text-[9px] uppercase">
            <tr>
              {head.map((h) => (
                <th key={h} className="text-left px-3 py-1.5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-900/60">
            {rows.length === 0 && (
              <tr>
                <td colSpan={head.length} className="px-3 py-4 text-center text-zinc-600 italic">
                  no data
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key} className="text-zinc-300 hover:bg-zinc-900/50">
                {r.cells.map((c, i) => (
                  <td key={i} className="px-3 py-1.5">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
