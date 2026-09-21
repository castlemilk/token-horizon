/** SVG sparkline matching the Swift Sparkline (area fill + line, normalized). */
export function Sparkline({ values, color, height = 40 }: { values: number[]; color: string; height?: number }) {
  const w = 100
  const h = 100
  if (values.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-zinc-900/50" />
  }
  const max = Math.max(...values, 1e-9)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${(h - (v / max) * (h - 4) - 2).toFixed(2)}`)
  const line = pts.join(' ')
  const area = `0,${h} ${line} ${w},${h}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ height, width: '100%' }}>
      <polygon points={area} fill={color} opacity={0.12} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Small KPI stat cell (label over mono value). */
export function Stat({ label, value, color = 'text-zinc-100' }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-sm font-mono font-bold ${color}`}>{value}</span>
    </div>
  )
}

/** GitHub-style day×hour heatmap for /activity/heatmap (grid[day][hour]). */
export function HeatmapGrid({ grid, max }: { grid: number[][]; max: number }) {
  const cell = 10
  const gap = 1.5
  const days = grid.length
  const hours = grid[0]?.length ?? 24
  const shade = (v: number) => {
    if (v <= 0 || max <= 0) return 'rgba(255,255,255,0.04)'
    const t = Math.min(1, Math.log10(1 + v) / Math.log10(1 + max))
    return `rgba(52, 211, 153, ${(0.15 + t * 0.85).toFixed(2)})`
  }
  return (
    <svg
      viewBox={`0 0 ${hours * (cell + gap)} ${days * (cell + gap)}`}
      className="w-full"
      style={{ maxHeight: days * (cell + gap) * 2 }}
    >
      {grid.map((row, d) =>
        row.map((v, h) => (
          <rect
            key={`${d}-${h}`}
            x={h * (cell + gap)}
            y={d * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
            fill={shade(v)}
          >
            <title>{`${fmtDayCell(d, days)} ${h}:00 — ${v.toLocaleString()} tokens`}</title>
          </rect>
        ))
      )}
    </svg>
  )
}

function fmtDayCell(offsetFromOldest: number, days: number): string {
  const d = new Date(Date.now() - (days - 1 - offsetFromOldest) * 86400_000)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Horizontally-stacked daily bars for /trends (per-tool share inside each bar). */
export function StackedBars({
  points,
}: {
  points: { day: number; tokens: number; cost: number; byTool: Record<string, number> }[]
}) {
  const max = Math.max(...points.map((p) => p.tokens), 1)
  const tools = Array.from(new Set(points.flatMap((p) => Object.keys(p.byTool))))
  const colorFor = (t: string) => {
    let h = 0
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
    const palette = ['#38bdf8', '#a855f7', '#34d399', '#f59e0b', '#fb7185', '#2dd4bf', '#f97316', '#818cf8']
    return palette[h % palette.length]
  }
  return (
    <div className="flex items-end gap-px h-28 w-full">
      {points.map((p) => (
        <div key={p.day} className="flex-1 flex flex-col justify-end h-full group relative">
          <div className="flex flex-col-reverse w-full" style={{ height: `${(p.tokens / max) * 100}%` }}>
            {tools.map((t) =>
              p.byTool[t] ? (
                <div
                  key={t}
                  style={{ height: `${(p.byTool[t] / p.tokens) * 100}%`, background: colorFor(t), minHeight: 1 }}
                />
              ) : null
            )}
            {p.tokens > 0 && tools.every((t) => !p.byTool[t]) && <div className="w-full h-full bg-emerald-500/70" />}
          </div>
          <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-[10px] font-mono text-zinc-200">
            {new Date(p.day * 86400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ·{' '}
            {p.tokens.toLocaleString()} tok · ${p.cost.toFixed(2)}
          </div>
        </div>
      ))}
    </div>
  )
}
