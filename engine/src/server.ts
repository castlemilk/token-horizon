import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { WebSocketServer, WebSocket } from 'ws';
import { WorkflowDefinition, WorkflowRunResult, LogMessage } from './types.js';
import { DagRunner } from './dag-runner.js';
import { NodeMonitor } from './node-monitor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_DIR = path.resolve(__dirname, '../workflows');

const runs = new Map<string, WorkflowRunResult>();
const runLogs = new Map<string, LogMessage[]>();

/**
 * Loads all YAML workflow definitions from engine/workflows/
 */
export function loadWorkflows(): Map<string, WorkflowDefinition> {
  const workflows = new Map<string, WorkflowDefinition>();
  if (!fs.existsSync(WORKFLOWS_DIR)) return workflows;

  const files = fs.readdirSync(WORKFLOWS_DIR);
  for (const file of files) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      try {
        const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8');
        const parsed = YAML.parse(content) as WorkflowDefinition;
        if (parsed.id && parsed.stages) {
          workflows.set(parsed.id, parsed);
        }
      } catch (err: any) {
        console.error(`[Server] Failed to parse workflow ${file}:`, err.message);
      }
    }
  }
  return workflows;
}

const PORT = parseInt(process.env.ENGINE_PORT || '8766', 10);
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // JSON helper
  const sendJson = (data: any, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const readBody = async (): Promise<any> => {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({});
        }
      });
    });
  };

  try {
    if (pathname === '/api/health') {
      const nodes = await NodeMonitor.getAllNodes();
      sendJson({
        ok: true,
        service: 'token-horizon-engine',
        version: '0.1.0',
        activeRuns: Array.from(runs.values()).filter((r) => r.status === 'running').length,
        nodesCount: nodes.length
      });
      return;
    }

    if (pathname === '/api/workflows' && req.method === 'GET') {
      const workflows = Array.from(loadWorkflows().values());
      sendJson(workflows);
      return;
    }

    if (pathname.startsWith('/api/workflows/') && pathname.endsWith('/run') && req.method === 'POST') {
      const workflowId = pathname.replace('/api/workflows/', '').replace('/run', '');
      const workflows = loadWorkflows();
      const def = workflows.get(workflowId);
      if (!def) {
        sendJson({ error: `Workflow '${workflowId}' not found` }, 404);
        return;
      }

      const body = await readBody();
      const customInputs = body.inputs || {};

      // Launch async workflow
      const runPromise = DagRunner.execute(def, {
        inputs: customInputs,
        onLog: (log) => {
          const list = runLogs.get(log.runId) || [];
          list.push(log);
          runLogs.set(log.runId, list);
          broadcastWs({ type: 'log', data: log });
        },
        onStageUpdate: (stage) => {
          broadcastWs({ type: 'stage_update', data: stage });
        },
        onStepUpdate: (step, stageId) => {
          broadcastWs({ type: 'step_update', data: { step, stageId } });
        }
      });

      // Track initial state
      runPromise.then((result) => {
        runs.set(result.runId, result);
        broadcastWs({ type: 'run_complete', data: result });
      }).catch((err) => {
        console.error(`[Server] Workflow execution failed:`, err);
      });

      sendJson({
        status: 'launched',
        workflowId: def.id,
        workflowName: def.name,
        inputs: customInputs
      }, 202);
      return;
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const list = Array.from(runs.values()).sort((a, b) => b.startTime - a.startTime);
      sendJson(list);
      return;
    }

    if (pathname.startsWith('/api/runs/') && pathname.endsWith('/logs') && req.method === 'GET') {
      const runId = pathname.replace('/api/runs/', '').replace('/logs', '');
      sendJson(runLogs.get(runId) || []);
      return;
    }

    if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
      const runId = pathname.replace('/api/runs/', '');
      const run = runs.get(runId);
      if (!run) {
        sendJson({ error: `Run '${runId}' not found` }, 404);
        return;
      }
      sendJson(run);
      return;
    }

    if (pathname === '/api/nodes' && req.method === 'GET') {
      const nodes = await NodeMonitor.getAllNodes();
      sendJson(nodes);
      return;
    }

    if (pathname === '/api/nodes/register' && req.method === 'POST') {
      const nodeData = await readBody();
      if (!nodeData.id || !nodeData.hostname) {
        sendJson({ error: 'Invalid node registration payload' }, 400);
        return;
      }
      NodeMonitor.registerRemoteNode(nodeData);
      sendJson({ ok: true, registered: nodeData.id });
      return;
    }

    sendJson({ error: 'Endpoint not found' }, 404);
  } catch (err: any) {
    sendJson({ error: err.message }, 500);
  }
});

// WebSocket Server
const wss = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', message: 'Token Horizon Engine WebSocket connected' }));

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function broadcastWs(msg: { type: string; data: any }) {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.endsWith('server.ts') || process.env.RUN_SERVER === 'true') {
  server.listen(PORT, () => {
    console.log(`[Token Horizon Engine] Daemon running on http://127.0.0.1:${PORT}`);
    console.log(`[Token Horizon Engine] WebSocket server active on ws://127.0.0.1:${PORT}`);
  });
}

export { server, wss };
