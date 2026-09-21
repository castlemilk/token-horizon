/** Formatting helpers matching the Swift app's UsageSnapshot.tokens()/cost() conventions. */

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${n}`
}

export function fmtCost(c: number): string {
  return c >= 100 ? `$${c.toFixed(0)}` : `$${c.toFixed(2)}`
}

export function fmtMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}G`
  return `${Math.round(mb)}M`
}

export function fmtRate(mbps: number): string {
  if (mbps >= 1024) return `${(mbps / 1024).toFixed(1)}G/s`
  if (mbps >= 1) return `${mbps.toFixed(1)}M/s`
  return `${(mbps * 1024).toFixed(0)}K/s`
}

export function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

export function fmtAgo(epochSec: number): string {
  const diff = Date.now() / 1000 - epochSec
  if (diff < 60) return `${Math.max(0, Math.round(diff))}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${(diff / 3600).toFixed(1)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

const TOOL_COLORS = ['#38bdf8', '#a855f7', '#34d399', '#f59e0b', '#fb7185', '#2dd4bf', '#f97316', '#818cf8']
export function toolColor(tool: string): string {
  let h = 0
  for (let i = 0; i < tool.length; i++) h = (h * 31 + tool.charCodeAt(i)) >>> 0
  return TOOL_COLORS[h % TOOL_COLORS.length]
}
