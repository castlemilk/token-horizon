import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { NodeTelemetry } from './types.js';

const execAsync = promisify(exec);

export class NodeMonitor {
  private static remoteNodes: Map<string, NodeTelemetry> = new Map();

  /**
   * Samples local node telemetry across macOS, Linux, and Windows.
   */
  public static async sampleLocalNode(): Promise<NodeTelemetry> {
    const platform = os.platform() as 'darwin' | 'linux' | 'win32';
    const hostname = os.hostname();
    const arch = os.arch();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // CPU usage estimation via loadavg or cpus()
    const cpus = os.cpus();
    const cpuCount = cpus.length;
    const loadAvg1m = os.loadavg()[0];
    const cpuPercent = Math.min(100, Math.round((loadAvg1m / Math.max(1, cpuCount)) * 100));

    let gpuInfo: NodeTelemetry['gpu'] | undefined = undefined;
    const activeModels: string[] = [];

    // Platform-specific GPU & Model detection
    if (platform === 'darwin') {
      // macOS: Unified memory & MLX / Ollama detection
      gpuInfo = {
        name: `Apple Silicon (${arch.toUpperCase()}) Unified Memory`,
        vramTotalBytes: totalMem,
        vramUsedBytes: usedMem,
        usedPercent: memPercent,
        utilizationPercent: Math.min(100, Math.round(cpuPercent * 0.8))
      };

      try {
        const { stdout } = await execAsync('ps aux | grep -E "mlx|ollama|llama" | grep -v grep | head -5');
        if (stdout.includes('mlx-lm') || stdout.includes('mlx-engine')) activeModels.push('mlx-engine');
        if (stdout.includes('ollama')) activeModels.push('ollama-runner');
      } catch {
        // process query ignored
      }
    } else if (platform === 'linux') {
      // Linux: Check for NVIDIA GPU via nvidia-smi
      try {
        const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits');
        const [name, totalMib, usedMib, util] = stdout.trim().split(',').map((s) => s.trim());
        const totalBytes = parseInt(totalMib, 10) * 1024 * 1024;
        const usedBytes = parseInt(usedMib, 10) * 1024 * 1024;
        gpuInfo = {
          name: name || 'NVIDIA GPU',
          vramTotalBytes: totalBytes || 0,
          vramUsedBytes: usedBytes || 0,
          usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0,
          utilizationPercent: parseInt(util, 10) || 0
        };
      } catch {
        // No nvidia-smi, fallback
        gpuInfo = undefined;
      }
    } else if (platform === 'win32') {
      // Windows: Try nvidia-smi or default
      try {
        const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits');
        const [name, totalMib, usedMib] = stdout.trim().split(',').map((s) => s.trim());
        const totalBytes = parseInt(totalMib, 10) * 1024 * 1024;
        const usedBytes = parseInt(usedMib, 10) * 1024 * 1024;
        gpuInfo = {
          name: name || 'DirectX/WDDM GPU',
          vramTotalBytes: totalBytes || 0,
          vramUsedBytes: usedBytes || 0,
          usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0
        };
      } catch {
        gpuInfo = undefined;
      }
    }

    return {
      id: `node_${hostname.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      hostname,
      os: platform,
      arch,
      cpuPercent,
      memory: {
        totalBytes: totalMem,
        usedBytes: usedMem,
        freeBytes: freeMem,
        usedPercent: memPercent
      },
      gpu: gpuInfo,
      activeModels,
      lastSeen: Date.now(),
      isSelf: true
    };
  }

  /**
   * Registers or updates a remote node's telemetry heartbeat.
   */
  public static registerRemoteNode(node: NodeTelemetry): void {
    node.lastSeen = Date.now();
    node.isSelf = false;
    this.remoteNodes.set(node.id, node);
  }

  /**
   * Returns all known nodes (self + active remote nodes within last 60s).
   */
  public static async getAllNodes(): Promise<NodeTelemetry[]> {
    const selfNode = await this.sampleLocalNode();
    const now = Date.now();
    const list: NodeTelemetry[] = [selfNode];

    for (const [id, node] of this.remoteNodes.entries()) {
      if (now - node.lastSeen < 60000) {
        list.push(node);
      } else {
        this.remoteNodes.delete(id);
      }
    }

    return list;
  }
}
