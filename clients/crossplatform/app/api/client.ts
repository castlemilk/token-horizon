import { endpoints } from './config'
import type {
  AchievementsResponse,
  CacheInfo,
  DiscoveryStatus,
  DockerResponse,
  HeatmapResponse,
  HistoryResponse,
  LeaderboardConfig,
  LeaderboardResponse,
  LimitsResponse,
  LocalResponse,
  ModelsResponse,
  ProcessesResponse,
  ShellEvent,
  StatsResponse,
  TopPick,
  TrendsResponse,
} from './types'

/** Thin typed fetchers over the daemon's loopback API. Every call is
 * fail-soft (throws on non-2xx; callers catch) since the daemon may be down. */
async function get<T>(base: string, path: string): Promise<T> {
  const res = await fetch(`${base}${path}`)
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

async function post<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  stats: () => get<StatsResponse>(endpoints.server, '/stats'),
  trends: (window: string) => get<TrendsResponse>(endpoints.server, `/trends?window=${window}`),
  history: (days = 370) => get<HistoryResponse>(endpoints.server, `/history?days=${days}`),
  heatmap: (days = 28) => get<HeatmapResponse>(endpoints.server, `/activity/heatmap?days=${days}`),
  limits: () => get<LimitsResponse>(endpoints.server, '/limits'),
  processes: () => get<ProcessesResponse>(endpoints.server, '/processes'),
  docker: () => get<DockerResponse>(endpoints.server, '/docker'),
  events: () => get<ShellEvent[]>(endpoints.server, '/events'),
  cache: () => get<CacheInfo>(endpoints.server, '/cache'),
  resetCache: () => post<{ ok: boolean; message: string }>(endpoints.server, '/cache/reset'),
  local: () => get<LocalResponse>(endpoints.server, '/local'),
  models: (search: string, scope: string) =>
    get<ModelsResponse>(endpoints.server, `/models?search=${encodeURIComponent(search)}&scope=${scope}`),
  topPicks: () => get<{ topPicks: TopPick[]; count: number }>(endpoints.server, '/top-picks'),
  discoveryStatus: () => get<DiscoveryStatus>(endpoints.server, '/discovery/status'),
  triggerScan: () => post<DiscoveryStatus>(endpoints.server, '/discovery/scan'),
  leaderboard: (period: string, team?: string) =>
    get<LeaderboardResponse>(
      endpoints.server,
      `/leaderboard?period=${period}${team ? `&team=${encodeURIComponent(team)}` : ''}`
    ),
  leaderboardSync: () => post<{ ok: boolean }>(endpoints.server, '/leaderboard/sync'),
  achievements: () => get<AchievementsResponse>(endpoints.server, '/achievements'),
  sheetsConfig: () => get<LeaderboardConfig>(endpoints.server, '/leaderboard/sheets/config'),
  saveSheetsConfig: (cfg: LeaderboardConfig) =>
    post<LeaderboardConfig>(endpoints.server, '/leaderboard/sheets/config', cfg),
  publishSheets: () =>
    post<{ ok: boolean; message?: string; error?: string }>(endpoints.server, '/leaderboard/sheets/publish'),
  pullSheets: () =>
    post<{ ok: boolean; count?: number; message?: string; error?: string }>(endpoints.server, '/leaderboard/sheets/pull'),
  publishCloud: () =>
    post<{ ok: boolean; message?: string; error?: string }>(endpoints.server, '/leaderboard/cloud/publish'),
  pullCloud: () =>
    post<{ ok: boolean; count?: number; message?: string; error?: string }>(endpoints.server, '/leaderboard/cloud/pull'),
  shareCard: (period: string, format = 'markdown') =>
    fetch(`${endpoints.server}/leaderboard/share?period=${period}&format=${format}`).then((r) => r.text()),
  widgetWindow: (value: string) => post<{ ok: boolean }>(endpoints.server, `/widget/window?value=${value}`),
}
