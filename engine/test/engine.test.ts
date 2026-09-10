import assert from 'assert';
import { Interpolator, EvaluationContext } from '../src/interpolator.js';
import { DagRunner } from '../src/dag-runner.js';
import { NodeMonitor } from '../src/node-monitor.js';
import { loadWorkflows } from '../src/server.js';
import { WorkflowDefinition } from '../src/types.js';

async function runTests() {
  console.log('=== Running Token Horizon Engine Test Suite ===\n');

  // Test 1: Interpolation
  console.log('Test 1: Interpolator string & condition evaluation');
  const ctx: EvaluationContext = {
    inputs: { org: 'shorted-prod', dry_run: true, count: 42 },
    env: { TEST_VAR: 'token_horizon_val' },
    stages: {
      scan: {
        steps: {
          step1: {
            outputs: { report: 'Security scan clean', exit_code: 0 },
            status: 'completed'
          }
        }
      }
    }
  };

  const str = Interpolator.interpolateString('Org: {{inputs.org}}, Status: {{stages.scan.steps.step1.outputs.report}}', ctx);
  assert.strictEqual(str, 'Org: shorted-prod, Status: Security scan clean');

  assert.strictEqual(Interpolator.evaluateCondition('{{inputs.dry_run}} == true', ctx), true);
  assert.strictEqual(Interpolator.evaluateCondition('{{inputs.dry_run}} == false', ctx), false);
  assert.strictEqual(Interpolator.evaluateCondition('{{stages.scan.steps.step1.outputs.exit_code}} == 0', ctx), true);
  console.log('✓ Interpolation passed');

  // Test 2: Workflow Loading
  console.log('\nTest 2: Load workflow definitions from disk');
  const workflows = loadWorkflows();
  assert(workflows.has('cloudguardian-assessment'), "Expected 'cloudguardian-assessment' to be loaded");
  assert(workflows.has('code-quality-remediation'), "Expected 'code-quality-remediation' to be loaded");

  const cgWf = workflows.get('cloudguardian-assessment')!;
  assert.strictEqual(cgWf.stages.length, 4);
  console.log(`✓ Loaded ${workflows.size} workflows successfully`);

  // Test 3: Node Monitor
  console.log('\nTest 3: NodeMonitor telemetry');
  const localNode = await NodeMonitor.sampleLocalNode();
  assert(localNode.hostname.length > 0);
  assert(localNode.memory.totalBytes > 0);
  assert(localNode.memory.usedPercent >= 0 && localNode.memory.usedPercent <= 100);
  console.log(`✓ Local node: ${localNode.hostname} (${localNode.os}), RAM: ${localNode.memory.usedPercent}%`);

  // Test 4: DAG Runner execution with condition skipping
  console.log('\nTest 4: DAG Runner execution with stages and conditions');
  const testWf: WorkflowDefinition = {
    id: 'test-pipeline',
    name: 'Unit Test Pipeline',
    version: '1.0.0',
    inputs: {
      skip_stage: { type: 'boolean', default: true },
      message: { type: 'string', default: 'hello world' }
    },
    stages: [
      {
        id: 's1',
        name: 'Stage 1',
        steps: [
          {
            id: 'echo_step',
            provider: 'cli',
            command: 'echo "{{inputs.message}}"',
            outputs: { msg: 'stdout' }
          }
        ]
      },
      {
        id: 's2',
        name: 'Stage 2 (Skipped)',
        condition: '{{inputs.skip_stage}} == false',
        steps: [
          {
            id: 'should_not_run',
            provider: 'cli',
            command: 'exit 1'
          }
        ]
      }
    ]
  };

  const runResult = await DagRunner.execute(testWf, {
    inputs: { skip_stage: true, message: 'dag-test-pass' }
  });

  assert.strictEqual(runResult.status, 'completed');
  assert.strictEqual(runResult.stages[0].status, 'completed');
  assert.strictEqual(runResult.stages[1].status, 'skipped');
  assert(runResult.stages[0].steps[0].stdout.includes('dag-test-pass'));
  console.log('✓ DAG Runner completed successfully with conditional skip');

  console.log('\n=============================================');
  console.log('ALL TOKEN HORIZON ENGINE TESTS PASSED (4/4)!');
  console.log('=============================================\n');
}

runTests().catch((err) => {
  console.error('Test failure:', err);
  process.exit(1);
});
