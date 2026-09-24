export interface ToolUsage {
  tool: string
  tokensToday: number
  tokensAllTime: number
  costToday: number
  costAllTime: number
  cacheReadAll?: number
}

export interface ClaudeAccount {
  id: string
  label: string
  email?: string
  tokensToday: number
  tokensAllTime: number
  costToday: number
  costAllTime: number
  limits: Array<{
    label: string
    usedPercent: number
    resetsAt?: number
    detail?: string
  }>
}

export interface ProviderLimit {
  provider: string
  label: string
  usedPercent: number
  resetsAt?: number
  detail?: string
}

export interface WeeklyResetRow {
  provider: string
  label: string
  usedPercent: number
  remainingPercent: number
  resetsAt: number
  resetsIn: string
  resetsInShort: string
  resetDateTime: string
  urgency: 'urgent' | 'soon' | 'normal'
  detail: string
  resetsSoon: boolean
}

export interface SystemStats {
  cpu_percent: number
  ram_used_gb: number
  ram_total_gb: number
  load_1m: number
}

export interface StatsResponse {
  usage: {
    tokensToday: number
    tokensAllTime: number
    costToday: number
    costAllTime: number
    perTool: ToolUsage[]
    claudeAccounts?: ClaudeAccount[]
    limits: ProviderLimit[]
  }
  system: SystemStats
}

export interface NodeTelemetry {
  id: string
  hostname: string
  os: 'darwin' | 'linux' | 'win32'
  arch: string
  cpuPercent: number
  memory: {
    totalBytes: number
    usedBytes: number
    usedPercent: number
  }
  gpu?: {
    name: string
    vramTotalBytes: number
    vramUsedBytes: number
    usedPercent: number
  }
  activeModels: string[]
  isSelf: boolean
}

export interface WorkflowDefinition {
  id: string
  name: string
  version: string
  description?: string
  inputs?: Record<
    string,
    {
      type: string
      default?: any
      description?: string
    }
  >
  stages: Array<{
    id: string
    name: string
    steps: Array<{
      id: string
      name?: string
      provider: string
      command?: string
      prompt?: string
    }>
  }>
}

export interface WorkflowRunResult {
  runId: string
  workflowId: string
  workflowName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  inputs: Record<string, any>
  startTime: number
  endTime?: number
  durationMs?: number
  stages: Array<{
    stageId: string
    name: string
    status: string
    steps: Array<{
      stepId: string
      status: string
      stdout: string
      stderr: string
      exitCode?: number
      outputs: Record<string, any>
    }>
  }>
  error?: string
}

export interface LogMessage {
  timestamp: number
  runId: string
  stageId?: string
  stepId?: string
  level: 'info' | 'warn' | 'error' | 'stdout' | 'stderr'
  message: string
}
