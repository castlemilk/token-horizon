import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LogMessage } from '../types.js';

export interface RunAgyOptions {
  prompt: string;
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  onLog?: (log: LogMessage) => void;
  runId: string;
  stageId: string;
  stepId: string;
}

export async function runAgy(opts: RunAgyOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { prompt, model, cwd, env, timeoutSeconds = 600, onLog, runId, stageId, stepId } = opts;

  onLog?.({
    timestamp: Date.now(),
    runId,
    stageId,
    stepId,
    level: 'info',
    message: `[AGY] Dispatching agent prompt to Antigravity (model: ${model || 'default'})...`
  });

  // Find agy binary
  const candidatePaths = [
    process.env.AGY_PATH,
    path.join(os.homedir(), '.local/bin/agy'),
    '/usr/local/bin/agy',
    '/opt/homebrew/bin/agy'
  ].filter(Boolean) as string[];

  let agyBin = 'agy';
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      agyBin = p;
      break;
    }
  }

  const enhancedPath = `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`;
  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (model) {
    args.push('--model', model);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(agyBin, args, {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        PATH: enhancedPath,
        ...env
      }
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
        message: `[AGY] Execution timed out after ${timeoutSeconds}s`
      });
      resolve({ exitCode: 1, stdout, stderr: 'Execution timed out' });
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
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

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
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
        message: `[AGY] Completed with exit code ${exitCode}`
      });
      resolve({ exitCode, stdout, stderr });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      onLog?.({
        timestamp: Date.now(),
        runId,
        stageId,
        stepId,
        level: 'error',
        message: `[AGY] Spawn error: ${err.message}`
      });
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}
