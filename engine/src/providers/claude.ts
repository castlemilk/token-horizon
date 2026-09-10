import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LogMessage } from '../types.js';

export interface RunClaudeOptions {
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

export async function runClaude(opts: RunClaudeOptions): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { prompt, model, cwd, env, timeoutSeconds = 600, onLog, runId, stageId, stepId } = opts;

  onLog?.({
    timestamp: Date.now(),
    runId,
    stageId,
    stepId,
    level: 'info',
    message: `[Claude] Invoking Claude Code CLI (model: ${model || 'default'})...`
  });

  const candidatePaths = [
    process.env.CLAUDE_PATH,
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude'
  ].filter(Boolean) as string[];

  let claudeBin = 'claude';
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      claudeBin = p;
      break;
    }
  }

  const enhancedPath = `${path.join(os.homedir(), '.local/bin')}:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`;
  const args = ['-p', prompt, '--print'];
  if (model) {
    args.push('--model', model);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(claudeBin, args, {
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
        message: `[Claude] Execution timed out after ${timeoutSeconds}s`
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
        message: `[Claude] Completed with exit code ${exitCode}`
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
        message: `[Claude] Spawn error: ${err.message}`
      });
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}
