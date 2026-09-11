import { spawn } from 'child_process';
import { LogMessage } from '../types.js';

export interface RunCliOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onLog?: (log: LogMessage) => void;
  runId: string;
  stageId: string;
  stepId: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(opts: RunCliOptions): Promise<CliResult> {
  const { command, cwd, env, timeoutSeconds = 300, onLog, runId, stageId, stepId } = opts;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    onLog?.({
      timestamp: Date.now(),
      runId,
      stageId,
      stepId,
      level: 'info',
      message: `[CLI] Executing: ${command}${cwd ? ` (cwd: ${cwd})` : ''}`
    });

    const child = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: 'error',
        message: `[CLI] Command timed out after ${timeoutSeconds}s`
      });
      reject(new Error(`Command timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      stdout += text;
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: 'stdout',
        message: text
      });
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf-8');
      stderr += text;
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: 'stderr',
        message: text
      });
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) return;

      const exitCode = code ?? 0;
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: exitCode === 0 ? 'info' : 'warn',
        message: `[CLI] Process exited with code ${exitCode}`
      });

      resolve({
        exitCode,
        stdout,
        stderr
      });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: 'error',
        message: `[CLI] Failed to spawn process: ${err.message}`
      });
      reject(err);
    });
  });
}
