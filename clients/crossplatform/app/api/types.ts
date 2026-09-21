/** Payload contracts for the Token Horizon daemon API (:8765). Field names
 * mirror the Swift Codable DTOs in clients/macos/Sources/TokenHorizon. */

export interface SystemStats {
  cpu_percent: number
  ram_used_gb: number
  ram_total_gb: number
  load_1m: number
  disk_mbps?: number
  net_mbps?: number
}

export interface ToolUsage {
  tool: string
  tokensToday: number
  tokensAllTime: number
  costToday: number
  costAllTime: number
  cacheReadAll?: number
  cacheWriteAll?: number
  inputTokensToday?: number
  outputTokensToday?: number
  inputTokensAllTime?: number
  outputTokensAllTime?: number
  requestsToday?: number
  requestsAllTime?: number
}

export interface ModelUsage {
  provider: string
  model: string
  tokensAll: number
  tokensToday: number
  cost: number
  messages: number
  free: boolean
  cacheReadAll?: number
  cacheWriteAll?: number
  estCost?: number
  contextK?: number
  tokPerSec?: number
  promptTokPerSec?: number
  paramSize?: string
  quant?: string
  isLocal?: boolean
  capabilities?: string[]
  localModelName?: string
  sharePercent?: number
  inputTokensAll?: number
  outputTokensAll?: number
  inputTokensToday?: number
  outputTokensToday?: number
  requestsAll?: number
  requestsToday?: number
}

export interface ProviderLimit {
  provider: string
  label: string
  usedPercent: number
  resetsAt?: number
  detail: string
  isWeekly?: boolean
  remainingPercent?: number
  resetsSoon?: boolean
  resetsIn?: string
  resetsInShort?: string
  resetDateTime?: string
  urgency?: 'urgent' | 'soon' | 'normal'
}

export interface ClaudeAccount {
  id: string
  label: string
  email?: string
  displayName?: string
  organizationName?: string
  rateLimitTier?: string
  tokensToday: number
  tokensAllTime: number
  costToday: number
  costAllTime: number
  limits: ProviderLimit[]
}

export interface SessionSummary {
  id: string
  title: string
  cost: number
  tokens: number
  directory: string
  created: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  requests: number
}

export interface ProjectUsage {
  directory: string
  tokens: number
  cost: number
  sessions: number
  inputTokens: number
  outputTokens: number
}

export interface ModelDailyUsage {
  model: string
  provider: string
  day: number
  tokens: number
}

export interface UsageSnapshot {
  tokensToday: number
  tokensAllTime: number
  costToday: number
  costAllTime: number
  perTool: ToolUsage[]
  models: ModelUsage[]
  limits: ProviderLimit[]
  claudeAccounts: ClaudeAccount[]
  recentSessions: SessionSummary[]
  sources: string[]
  updatedAt: number
  inputTokensToday: number
  outputTokensToday: number
  inputTokensAllTime: number
  outputTokensAllTime: number
  requestsToday: number
  requestsAllTime: number
  projects: ProjectUsage[]
  modelDaily: ModelDailyUsage[]
}

export interface StatsResponse {
  usage: UsageSnapshot
  system: SystemStats
}

export interface HistoryPoint {
  day: number
  tokens: number
  cost: number
  byTool: Record<string, number>
}

export interface TrendsResponse {
  window: string
  total: number
  points: HistoryPoint[]
}

export interface HistoryResponse {
  days: number
  streak: number
  points: HistoryPoint[]
}

export interface HeatmapResponse {
  days: number
  max: number
  total: number
  grid: number[][]
}

export interface LimitsResponse {
  limits: ProviderLimit[]
  weeklyResets: WeeklyResetRow[]
  nextWeeklyReset?: WeeklyResetRow
  maximizerRecommendation?: string
}

export interface WeeklyResetRow extends ProviderLimit {
  provider: string
  usedPercent: number
  remainingPercent: number
}

export interface ProcSample {
  pid: number
  ppid: number
  name: string
  command: string
  user: string
  threads: number
  cpu: number
  memMB: number
  diskReadMBps: number
  diskWriteMBps: number
  netInKBps: number
  netOutKBps: number
  startTime: number
  depth?: number
  hasChildren?: boolean
}

export interface ProcessesResponse {
  all: ProcSample[]
  tree: ProcSample[]
  byCPU: ProcSample[]
  byMem: ProcSample[]
  byDisk: ProcSample[]
  byNet: ProcSample[]
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  cpu: number
  memMB: number
  memLimitMB: number
  memPercent: number
  netInMB: number
  netOutMB: number
  diskReadMB: number
  diskWriteMB: number
  pids: number
  status: string
  ports: string
}

export interface DockerResponse {
  containers: DockerContainer[]
  count: number
  totalContainerMemMB: number
  totalContainerCpu: number
  vmHostPid: number
  vmHostMemMB: number
}

export interface ShellEvent {
  id: string
  time: number
  cwd: string
  durationMs: number
  exit: number
}

export interface CacheInfo {
  persistenceEnabled: boolean
  filesCount: number
  totalBytes: number
  lastUpdated: number
}

export interface MlxProcess {
  pid: number
  ppid: number
  name: string
  command: string
  model?: string
  cpu: number
  memoryMB: number
  diskReadMBps: number
  diskWriteMBps: number
  startTime: number
  tokPerSec?: number
  prefillTokPerSec?: number
  ttftSeconds?: number
}

export interface LocalResponse {
  sampledAt: number
  processes: MlxProcess[]
  totals: {
    cpuPercent: number
    memoryMB: number
    diskReadMBps: number
    diskWriteMBps: number
    measuredTokPerSec?: number
    measuredPrefillTokPerSec?: number
  }
  series?: {
    cpu: number[]
    memory: number[]
    disk: number[]
    tok: number[]
    prefill: number[]
    cpuCoarse: number[]
    memoryCoarse: number[]
    diskCoarse: number[]
    tokCoarse: number[]
    prefillCoarse: number[]
  }
  ollama?: {
    todayTokens: number
    allTokens: number
    messagesToday: number
    messagesAll: number
    models: Record<string, { today: number; all: number; prompt: number; eval: number; messages: number }>
    hourlyBuckets: Record<string, number>
  }
  proxyPort?: number
  gatewayPort?: number
}

export interface CatalogModel {
  id: string
  name: string
  provider: string
  inputPrice: number
  outputPrice: number
  effectiveInputPrice: number
  blendedNetCost: number
  blendedNetCostText: string
  netSavingsPercent: number
  hasDiscount: boolean
  contextK: number
  contextText: string
  isLocal: boolean
  isFree: boolean
  cachePrice?: number
  sweScore?: number
  lcbScore?: number
  discountPercent?: number
  discountLabel?: string
}

export interface ModelsResponse {
  count: number
  scope: string
  models: CatalogModel[]
}

export interface TopPick {
  rank: number
  id: string
  name: string
  provider: string
  valueScore: number
  perfScore: number
  inputPrice: number
  outputPrice: number
  blendedNetCostText: string
  badge: string
  reason: string
  contextK: number
  sweScore?: number
}

export interface DiscoveryStatus {
  catalogCount?: number
  lastScanAt?: string
  sources?: Record<string, unknown>
  [key: string]: unknown
}

export interface LeaderboardEntry {
  id: string
  handle: string
  team: string
  tokensToday: number
  tokens7d: number
  tokensAll: number
  costToday: number
  cost7d: number
  costAll: number
  streakDays: number
  topModel: string
  hardware: string
  isLocal: boolean
  updatedAt: number
  mmr: number
  league: string
  division: number
  efficiency: number
  requestsToday: number
  requestsAll: number
}

export interface LeaderboardRankedEntry {
  rank: number
  badge: string
  percentile: number
  entry: LeaderboardEntry
  score: number
  scoreFormatted: string
  costFormatted: string
  relativePercent: number
  league: string
  division: number
  mmr: number
  efficiency: number
  rankDelta7d?: number
  avgPerRequest: number
  trend: number[]
}

export interface LeaderboardResponse {
  period: string
  periodTitle: string
  total: number
  team: string
  userRank?: LeaderboardRankedEntry
  leaderboard: LeaderboardRankedEntry[]
}

export interface Achievement {
  id: string
  title?: string
  name?: string
  description?: string
  icon?: string
  unlocked?: boolean
  progress?: number
  [key: string]: unknown
}

export interface AchievementsResponse {
  season: {
    id: string
    number: number
    name: string
    displayName: string
    daysRemaining: number
    progress: number
  }
  seasonTokens: number
  achievements: Achievement[]
}

export interface LeaderboardConfig {
  sheetsURL?: string
  autoSync?: boolean
  cloudflareURL?: string
  cloudURL?: string
  cloudToken?: string
  cloudConfigured?: boolean
}
