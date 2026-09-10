import crypto from 'crypto';
import {
  WorkflowDefinition,
  WorkflowRunResult,
  StageExecutionResult,
  StepExecutionResult,
  StepStatus,
  LogMessage,
  WorkflowStep,
  WorkflowStage
} from './types.js';
import { Interpolator, EvaluationContext } from './interpolator.js';
import { runCli } from './providers/cli.js';
import { runAgy } from './providers/agy.js';
import { runClaude } from './providers/claude.js';
import { runLocal } from './providers/local.js';
import { runPlanProvider } from './providers/plan-providers.js';

export interface RunWorkflowOptions {
  inputs?: Record<string, any>;
  onLog?: (log: LogMessage) => void;
  onStepUpdate?: (step: StepExecutionResult, stageId: string) => void;
  onStageUpdate?: (stage: StageExecutionResult) => void;
}

export class DagRunner {
  public static async execute(
    definition: WorkflowDefinition,
    options: RunWorkflowOptions = {}
  ): Promise<WorkflowRunResult> {
    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startTime = Date.now();

    // 1. Resolve and validate inputs
    const resolvedInputs: Record<string, any> = {};
    if (definition.inputs) {
      for (const [key, def] of Object.entries(definition.inputs)) {
        if (options.inputs && options.inputs[key] !== undefined) {
          resolvedInputs[key] = options.inputs[key];
        } else if (def.default !== undefined) {
          resolvedInputs[key] = def.default;
        } else if (def.required) {
          throw new Error(`Missing required workflow input: '${key}'`);
        }
      }
    }

    const context: EvaluationContext = {
      inputs: resolvedInputs,
      env: process.env,
      stages: {}
    };

    const runResult: WorkflowRunResult = {
      runId,
      workflowId: definition.id,
      workflowName: definition.name,
      status: 'running',
      inputs: resolvedInputs,
      startTime,
      stages: []
    };

    options.onLog?.({
      timestamp: Date.now(),
      runId,
      level: 'info',
      message: `[DAG Runner] Starting execution of workflow '${definition.name}' (${definition.id})`
    });

    try {
      // 2. Execute stages in sequence
      for (const stageDef of definition.stages) {
        context.stages[stageDef.id] = { steps: {} };
        const stageStartTime = Date.now();

        const stageResult: StageExecutionResult = {
          stageId: stageDef.id,
          name: stageDef.name,
          status: 'running',
          startTime: stageStartTime,
          steps: []
        };
        runResult.stages.push(stageResult);
        options.onStageUpdate?.(stageResult);

        // Check stage condition
        const stageShouldRun = Interpolator.evaluateCondition(stageDef.condition, context);
        if (!stageShouldRun) {
          stageResult.status = 'skipped';
          stageResult.endTime = Date.now();
          options.onLog?.({
            timestamp: Date.now(),
            runId,
            stageId: stageDef.id,
            level: 'info',
            message: `[DAG Runner] Skipping stage '${stageDef.name}' (condition evaluated to false)`
          });
          options.onStageUpdate?.(stageResult);
          continue;
        }

        options.onLog?.({
          timestamp: Date.now(),
          runId,
          stageId: stageDef.id,
          level: 'info',
          message: `[DAG Runner] Entering stage '${stageDef.name}' (${stageDef.steps.length} step${stageDef.steps.length > 1 ? 's' : ''})`
        });

        // Run steps (parallel or sequential)
        if (stageDef.parallel) {
          const stepPromises = stageDef.steps.map((step) =>
            this.executeStep(step, stageDef, runId, context, options)
          );
          const executedSteps = await Promise.all(stepPromises);
          stageResult.steps.push(...executedSteps);
        } else {
          for (const step of stageDef.steps) {
            const stepResult = await this.executeStep(step, stageDef, runId, context, options);
            stageResult.steps.push(stepResult);

            if (stepResult.status === 'failed' && (step.onFailure === 'stop' || !step.onFailure)) {
              stageResult.status = 'failed';
              stageResult.endTime = Date.now();
              runResult.status = 'failed';
              runResult.error = `Step '${step.name || step.id}' failed in stage '${stageDef.name}'`;
              options.onStageUpdate?.(stageResult);
              break;
            }
          }
        }

        const anyFailed = stageResult.steps.some((s) => s.status === 'failed');
        stageResult.status = anyFailed ? 'failed' : 'completed';
        stageResult.endTime = Date.now();
        options.onStageUpdate?.(stageResult);

        if (stageResult.status === 'failed') {
          runResult.status = 'failed';
          break;
        }
      }

      const allCompleted = runResult.stages.every((s) => s.status === 'completed' || s.status === 'skipped');
      runResult.status = allCompleted ? 'completed' : 'failed';
    } catch (err: any) {
      runResult.status = 'failed';
      runResult.error = err.message;
      options.onLog?.({
        timestamp: Date.now(),
        runId,
        level: 'error',
        message: `[DAG Runner] Workflow aborted with fatal error: ${err.message}`
      });
    }

    runResult.endTime = Date.now();
    runResult.durationMs = runResult.endTime - runResult.startTime;

    options.onLog?.({
      timestamp: Date.now(),
      runId,
      level: runResult.status === 'completed' ? 'info' : 'error',
      message: `[DAG Runner] Workflow ${runResult.status.toUpperCase()} in ${runResult.durationMs}ms`
    });

    return runResult;
  }

  private static async executeStep(
    step: WorkflowStep,
    stage: WorkflowStage,
    runId: string,
    context: EvaluationContext,
    options: RunWorkflowOptions
  ): Promise<StepExecutionResult> {
    const stepStartTime = Date.now();
    const stepResult: StepExecutionResult = {
      stepId: step.id,
      status: 'running',
      startTime: stepStartTime,
      stdout: '',
      stderr: '',
      outputs: {}
    };

    options.onStepUpdate?.(stepResult, stage.id);

    // Check step condition
    const stepShouldRun = Interpolator.evaluateCondition(step.condition, context);
    if (!stepShouldRun) {
      stepResult.status = 'skipped';
      stepResult.endTime = Date.now();
      stepResult.durationMs = 0;
      context.stages[stage.id].steps[step.id] = {
        outputs: {},
        status: 'skipped'
      };
      options.onStepUpdate?.(stepResult, stage.id);
      return stepResult;
    }

    try {
      let rawResult: { exitCode: number; stdout: string; stderr: string };

      // Interpolate parameters
      const command = step.command ? Interpolator.interpolateString(step.command, context) : undefined;
      const prompt = step.prompt ? Interpolator.interpolateString(step.prompt, context) : undefined;
      const cwd = step.cwd ? Interpolator.interpolateString(step.cwd, context) : undefined;
      const env = step.env ? (Interpolator.interpolateAny(step.env, context) as Record<string, string>) : undefined;

      const resolvedProvider = (Interpolator.interpolateString(step.provider, context) || 'cli') as ProviderType;
      switch (resolvedProvider) {
        case 'cli': {
          if (!command) throw new Error(`CLI step '${step.id}' requires a 'command' property`);
          rawResult = await runCli({
            command,
            cwd,
            env,
            timeoutSeconds: step.timeoutSeconds,
            onLog: options.onLog,
            runId,
            stageId: stage.id,
            stepId: step.id
          });
          break;
        }

        case 'agy': {
          if (!prompt) throw new Error(`AGY step '${step.id}' requires a 'prompt' property`);
          rawResult = await runAgy({
            prompt,
            model: step.model,
            cwd,
            env,
            timeoutSeconds: step.timeoutSeconds,
            onLog: options.onLog,
            runId,
            stageId: stage.id,
            stepId: step.id
          });
          break;
        }

        case 'claude': {
          if (!prompt) throw new Error(`Claude step '${step.id}' requires a 'prompt' property`);
          rawResult = await runClaude({
            prompt,
            model: step.model,
            cwd,
            env,
            timeoutSeconds: step.timeoutSeconds,
            onLog: options.onLog,
            runId,
            stageId: stage.id,
            stepId: step.id
          });
          break;
        }

        case 'local': {
          if (!prompt) throw new Error(`Local model step '${step.id}' requires a 'prompt' property`);
          rawResult = await runLocal({
            prompt,
            model: step.model,
            onLog: options.onLog,
            runId,
            stageId: stage.id,
            stepId: step.id
          });
          break;
        }

        case 'glm':
        case 'kimi': {
          if (!prompt) throw new Error(`Plan provider step '${step.id}' requires a 'prompt' property`);
          rawResult = await runPlanProvider({
            provider: step.provider,
            prompt,
            model: step.model,
            cwd,
            env,
            timeoutSeconds: step.timeoutSeconds,
            onLog: options.onLog,
            runId,
            stageId: stage.id,
            stepId: step.id
          });
          break;
        }

        default:
          throw new Error(`Unsupported provider: '${(step as any).provider}'`);
      }

      stepResult.exitCode = rawResult.exitCode;
      stepResult.stdout = rawResult.stdout;
      stepResult.stderr = rawResult.stderr;
      stepResult.status = rawResult.exitCode === 0 ? 'completed' : 'failed';

      // 3. Extract and map step outputs
      if (step.outputs) {
        for (const [outKey, mapping] of Object.entries(step.outputs)) {
          if (mapping === 'stdout') {
            stepResult.outputs[outKey] = rawResult.stdout;
          } else if (mapping === 'stderr') {
            stepResult.outputs[outKey] = rawResult.stderr;
          } else if (mapping === 'exit_code') {
            stepResult.outputs[outKey] = rawResult.exitCode;
          } else if (mapping === 'json') {
            try {
              stepResult.outputs[outKey] = JSON.parse(rawResult.stdout);
            } catch {
              stepResult.outputs[outKey] = rawResult.stdout;
            }
          } else if (mapping === 'json_extract') {
            stepResult.outputs[outKey] = this.extractJson(rawResult.stdout);
          } else {
            // Direct expression
            stepResult.outputs[outKey] = Interpolator.interpolateString(mapping, context);
          }
        }
      }
    } catch (err: any) {
      stepResult.status = 'failed';
      stepResult.error = err.message;
      options.onLog?.({ timestamp: Date.now(), runId, stageId: stage.id, stepId: step.id, level: "error", message: `[DAG Runner] Step error: ${err.message}` });
    }

    stepResult.endTime = Date.now();
    stepResult.durationMs = stepResult.endTime - stepResult.startTime;

    context.stages[stage.id].steps[step.id] = {
      outputs: stepResult.outputs,
      status: stepResult.status,
      exitCode: stepResult.exitCode
    };

    options.onStepUpdate?.(stepResult, stage.id);
    return stepResult;
  }

  private static extractJson(text: string): any {
    // Try finding ```json ... ``` blocks first
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {
        // continue
      }
    }

    // Try finding first { ... } or [ ... ]
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch {
        // continue
      }
    }

    return text;
  }
}
