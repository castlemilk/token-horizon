#!/usr/bin/env node
import { loadWorkflows } from './server.js';
import { DagRunner } from './dag-runner.js';
import { NodeMonitor } from './node-monitor.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  const workflows = loadWorkflows();

  if (command === 'list') {
    console.log('\n=== Available Token Horizon Workflows ===\n');
    for (const [id, wf] of workflows) {
      console.log(`• \x1b[36m${id}\x1b[0m: ${wf.name} (v${wf.version})`);
      console.log(`  ${wf.description || 'No description'}`);
      console.log(`  Stages: ${wf.stages.map((s) => s.name).join(' → ')}`);
      if (wf.inputs) {
        console.log(`  Inputs: ${Object.keys(wf.inputs).join(', ')}`);
      }
      console.log('');
    }
    return;
  }

  if (command === 'nodes') {
    console.log('\n=== Token Horizon Infrastructure Nodes ===\n');
    const nodes = await NodeMonitor.getAllNodes();
    for (const n of nodes) {
      const selfTag = n.isSelf ? ' (Local / Master)' : ' (Remote Worker)';
      console.log(`• \x1b[32m${n.hostname}\x1b[0m [${n.os}/${n.arch}]${selfTag}`);
      console.log(`  CPU: ${n.cpuPercent}% | RAM: ${Math.round(n.memory.usedBytes / 1e9)}GB / ${Math.round(n.memory.totalBytes / 1e9)}GB (${n.memory.usedPercent}%)`);
      if (n.gpu) {
        console.log(`  GPU: ${n.gpu.name} | VRAM: ${Math.round(n.gpu.vramUsedBytes / 1e9)}GB / ${Math.round(n.gpu.vramTotalBytes / 1e9)}GB (${n.gpu.usedPercent}%)`);
      }
      if (n.activeModels.length > 0) {
        console.log(`  Active Local Models: ${n.activeModels.join(', ')}`);
      }
      console.log('');
    }
    return;
  }

  if (command === 'run') {
    const workflowId = args[1];
    if (!workflowId) {
      console.error('Error: specify a workflow ID to run. Example: npm run cli run cloudguardian-assessment');
      process.exit(1);
    }

    const def = workflows.get(workflowId);
    if (!def) {
      console.error(`Error: workflow '${workflowId}' not found. Run 'npm run cli list' for available workflows.`);
      process.exit(1);
    }

    // Parse CLI inputs like --org=my-org or --dry_run=false
    const inputs: Record<string, any> = {};
    for (const arg of args.slice(2)) {
      if (arg.startsWith('--')) {
        const [k, v] = arg.slice(2).split('=');
        if (v === 'true') inputs[k] = true;
        else if (v === 'false') inputs[k] = false;
        else if (!isNaN(Number(v))) inputs[k] = Number(v);
        else inputs[k] = v;
      }
    }

    console.log(`\nStarting Workflow: \x1b[36m${def.name}\x1b[0m`);
    console.log(`Inputs:`, inputs);
    console.log('--------------------------------------------------\n');

    const result = await DagRunner.execute(def, {
      inputs,
      onLog: (log) => {
        const time = new Date(log.timestamp).toLocaleTimeString();
        let color = '\x1b[0m';
        if (log.level === 'error') color = '\x1b[31m';
        else if (log.level === 'warn') color = '\x1b[33m';
        else if (log.level === 'stdout') color = '\x1b[32m';

        console.log(`[${time}] ${color}${log.message}\x1b[0m`);
      }
    });

    console.log('\n--------------------------------------------------');
    console.log(`Workflow Result: ${result.status.toUpperCase()} in ${result.durationMs}ms`);
    if (result.error) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    return;
  }

  console.log(`Unknown command: ${command}. Usage: cli [list | nodes | run <workflowId> [--key=val]]`);
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
