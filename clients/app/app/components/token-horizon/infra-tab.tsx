import React, { useState, useEffect } from 'react'
import { NodeTelemetry } from './types'
import { Server, Cpu, HardDrive, Zap, Laptop } from 'lucide-react'

interface InfraTabProps {
  engineUrl: string
}

export const InfraTab: React.FC<InfraTabProps> = ({ engineUrl }) => {
  const [nodes, setNodes] = useState<NodeTelemetry[]>([])

  const fetchNodes = async () => {
    try {
      const res = await fetch(`${engineUrl}/api/nodes`)
      if (res.ok) {
        const data = await res.json()
        setNodes(data)
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchNodes()
    const interval = setInterval(fetchNodes, 3000)
    return () => clearInterval(interval)
  }, [engineUrl])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Overview Banner */}
      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Server className="w-5 h-5 text-purple-400" />
          <div>
            <span className="font-bold text-sm text-zinc-100 uppercase tracking-wide">
              Cross-Platform Infrastructure & Model Clusters
            </span>
            <p className="text-xs text-zinc-400">
              Aggregated node telemetry across macOS, Linux, and Windows worker machines.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono px-2.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">
            {nodes.length} Connected Node{nodes.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Nodes Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {nodes.map((node) => {
          const usedMemGb = (node.memory.usedBytes / 1e9).toFixed(1)
          const totalMemGb = Math.round(node.memory.totalBytes / 1e9)

          return (
            <div
              key={node.id}
              className="flex flex-col p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-2 rounded-lg bg-zinc-800 text-zinc-300">
                    {node.os === 'darwin' ? <Laptop className="w-4 h-4" /> : <Server className="w-4 h-4" />}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-sm text-zinc-100">{node.hostname}</span>
                    <span className="text-[10px] font-mono text-zinc-400 uppercase">
                      {node.os} • {node.arch} {node.isSelf ? '• (Master)' : '• (Worker)'}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] font-mono text-emerald-400 uppercase">Live</span>
                </div>
              </div>

              {/* Resource Bars */}
              <div className="grid grid-cols-2 gap-3 mt-4">
                {/* CPU */}
                <div className="flex flex-col p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                  <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                    <span className="flex items-center gap-1">
                      <Cpu className="w-3 h-3 text-sky-400" /> CPU Load
                    </span>
                    <span className="text-zinc-200 font-bold">{node.cpuPercent}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-800 mt-2 overflow-hidden">
                    <div
                      className="h-full bg-sky-500 transition-all"
                      style={{ width: `${Math.min(100, node.cpuPercent)}%` }}
                    />
                  </div>
                </div>

                {/* RAM */}
                <div className="flex flex-col p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
                  <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                    <span className="flex items-center gap-1">
                      <HardDrive className="w-3 h-3 text-purple-400" /> Memory
                    </span>
                    <span className="text-zinc-200 font-bold">{node.memory.usedPercent}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-800 mt-2 overflow-hidden">
                    <div
                      className="h-full bg-purple-500 transition-all"
                      style={{ width: `${Math.min(100, node.memory.usedPercent)}%` }}
                    />
                  </div>
                  <span className="text-[9px] font-mono text-zinc-500 mt-1 text-right">
                    {usedMemGb} / {totalMemGb} GB
                  </span>
                </div>
              </div>

              {/* GPU / VRAM */}
              {node.gpu && (
                <div className="flex flex-col p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 mt-3">
                  <div className="flex items-center justify-between text-[11px] font-mono text-zinc-400">
                    <span className="flex items-center gap-1">
                      <Zap className="w-3 h-3 text-amber-400" /> {node.gpu.name}
                    </span>
                    <span className="text-zinc-200 font-bold">{node.gpu.usedPercent}%</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-zinc-800 mt-2 overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all"
                      style={{ width: `${Math.min(100, node.gpu.usedPercent)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Active Local Models */}
              <div className="flex items-center gap-2 mt-3 pt-2 border-t border-zinc-800/80">
                <span className="text-[10px] uppercase font-semibold text-zinc-400">Running Models:</span>
                {node.activeModels.length === 0 ? (
                  <span className="text-[10px] text-zinc-500 italic">None active</span>
                ) : (
                  node.activeModels.map((m, i) => (
                    <span key={i} className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                      {m}
                    </span>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
