import type { DaemonHealth, ProviderLimit, WeeklyResetRow } from './types'

/** Both the Swift app and the portable Go daemon expose these quota rows. */
export function limitRows(limits: ProviderLimit[], now = Date.now()): WeeklyResetRow[] {
  return limits
    .map((limit): WeeklyResetRow => {
      const usedPercent = Math.max(0, Math.min(100, limit.usedPercent))
      const reset = limit.resetsAt == null ? null : new Date(limit.resetsAt * 1000)
      const seconds = reset ? Math.max(0, Math.ceil((reset.getTime() - now) / 1000)) : null
      const resetsIn =
        seconds == null
          ? 'Unavailable'
          : seconds === 0
            ? 'Now'
            : seconds >= 86400
              ? `${Math.ceil(seconds / 86400)}d`
              : seconds >= 3600
                ? `${Math.ceil(seconds / 3600)}h`
                : `${Math.ceil(seconds / 60)}m`
      return {
        ...limit,
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsIn,
        resetsInShort: resetsIn,
        resetDateTime: reset ? reset.toLocaleString() : 'Unavailable',
        urgency: seconds == null ? 'normal' : seconds < 86400 ? 'urgent' : seconds < 172800 ? 'soon' : 'normal',
        detail: limit.detail ?? '',
        resetsSoon: seconds != null && seconds < 86400,
      }
    })
    .sort((a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity))
}

export function daemonVersion(health: DaemonHealth | null): string | null {
  const version = health?.build?.version ?? health?.version
  // Swift's top-level version is the API schema version; its build carries the app version.
  return typeof version === 'string' && version.length > 0 ? version : null
}

export async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(4000)
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  return response.json() as Promise<T>
}
