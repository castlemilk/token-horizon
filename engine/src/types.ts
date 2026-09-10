export type ProviderType = 'cli' | 'agy' | 'claude' | 'glm' | 'kimi' | 'local';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface WorkflowInputDefinition {
  type: 'string' | 'boolean' | 'number';
  default?: any;
  description?: string;
  required?: boolean;
}

export interface StepOutputMapping {
  [outputKey: string]: 'stdout' | 'stderr' | 'exit_code' | 'json' | 'json_extract' | string;
}

export interface WorkflowStep {
  id: string;
  name?: string;
  provider: ProviderType;
  command?: string;         // For 'cli' or provider CLI wrapping
  model?: string;           // Target model identifier
  prompt?: string;          // Model prompt or instructions
  cwd?: string;             // Working directory
  env?: Record<string, string>;
  timeoutSeconds?: number;
  condition?: string;       // Expression evaluating to boolean
  outputs?: StepOutputMapping;
  onFailure?: 'stop' | 'continue' | 'retry';
}

export interface WorkflowStage {
  id: string;
  name: string;
  condition?: string;
  parallel?: boolean;
  steps: WorkflowStep[];
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputs?: Record<string, WorkflowInputDefinition>;
  stages: WorkflowStage[];
}

export interface StepExecutionResult {
  stepId: string;
  status: StepStatus;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, any>;
  error?: string;
}

export interface StageExecutionResult {
  stageId: string;
  name: string;
  status: StepStatus;
  startTime: number;
  endTime?: number;
  steps: StepExecutionResult[];
}

export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  workflowName: string;
  status: StepStatus;
  inputs: Record<string, any>;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  stages: StageExecutionResult[];
  error?: string;
}

export interface LogMessage {
  timestamp: number;
  runId: string;
  stageId?: string;
  stepId?: string;
  level: 'info' | 'warn' | 'error' | 'stdout' | 'stderr';
  message: string;
}

export interface NodeTelemetry {
  id: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32';
  arch: string;
  cpuPercent: number;
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usedPercent: number;
  };
  gpu?: {
    name: string;
    vramTotalBytes: number;
    vramUsedBytes: number;
    usedPercent: number;
    utilizationPercent?: number;
  };
  activeModels: string[];
  measuredTokPerSec?: number;
  lastSeen: number;
  isSelf: boolean;
}
