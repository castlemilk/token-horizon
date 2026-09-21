import React, { useState, useEffect } from 'react'
import { Sparkles, Play, RefreshCw } from 'lucide-react'

interface ModelsTabProps {
  proxyUrl: string
}

interface LocalModel {
  name: string
  size: number
  modified_at: string
  details?: {
    parameter_size?: string
    quantization_level?: string
  }
}

export const ModelsTab: React.FC<ModelsTabProps> = ({ proxyUrl }) => {
  const [models, setModels] = useState<LocalModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('qwen3.8:27b-mlx')
  const [prompt, setPrompt] = useState<string>('Explain how Token Horizon tracks local tok/s in one sentence.')
  const [response, setResponse] = useState<string>('')
  const [isRunning, setIsRunning] = useState(false)
  const [speedMetrics, setSpeedMetrics] = useState<{ tokPerSec: string; tokens: number } | null>(null)

  const fetchModels = async () => {
    try {
      const res = await fetch(`${proxyUrl}/api/tags`)
      if (res.ok) {
        const data = await res.json()
        setModels(data.models || [])
        if (data.models && data.models.length > 0 && !selectedModel) {
          setSelectedModel(data.models[0].name)
        }
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetchModels()
  }, [proxyUrl])

  const handleTestInference = async () => {
    if (!prompt.trim() || isRunning) return
    setIsRunning(true)
    setResponse('')
    setSpeedMetrics(null)

    const startTime = Date.now()
    try {
      const res = await fetch(`${proxyUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          prompt,
          stream: false,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        setResponse(data.response || '')
        const durationSec = (data.eval_duration || (Date.now() - startTime) * 1e6) / 1e9
        const evalCount = data.eval_count || 0
        const tokPerSec = durationSec > 0 ? (evalCount / durationSec).toFixed(1) : 'N/A'
        setSpeedMetrics({
          tokPerSec,
          tokens: evalCount,
        })
      } else {
        setResponse(`Error: ${res.status} ${res.statusText}`)
      }
    } catch (err: any) {
      setResponse(`Connection failed: ${err.message}`)
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Top Banner */}
      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Sparkles className="w-5 h-5 text-amber-400" />
          <div>
            <span className="font-bold text-sm text-zinc-100 uppercase tracking-wide">
              Local Inference Hub & Out-of-Band Telemetry
            </span>
            <p className="text-xs text-zinc-400">
              Direct telemetry proxy on localhost:11435 for ground-truth tok/s and streaming evaluation tracking.
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Model Catalog List */}
        <div className="flex flex-col p-3 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 px-1">
            Installed Local Models ({models.length})
          </span>
          <div className="flex flex-col gap-1.5 max-h-[380px] overflow-y-auto pr-1">
            {models.length === 0 ? (
              <div className="text-xs text-zinc-500 italic py-4 text-center">Loading local models...</div>
            ) : (
              models.map((m) => {
                const isSel = m.name === selectedModel
                return (
                  <div
                    key={m.name}
                    onClick={() => setSelectedModel(m.name)}
                    className={`flex flex-col p-2.5 rounded-lg border cursor-pointer transition-all ${
                      isSel
                        ? 'bg-zinc-800/90 border-amber-500/50 text-zinc-100'
                        : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:bg-zinc-900/60'
                    }`}
                  >
                    <span className="font-semibold text-xs truncate">{m.name}</span>
                    <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-1">
                      <span>{(m.size / 1e9).toFixed(1)} GB</span>
                      <span>{m.details?.quantization_level || 'standard'}</span>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* Inference & Speedometer */}
        <div className="md:col-span-2 flex flex-col p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Interactive Telemetry Testbed
            </span>
            {speedMetrics && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-zinc-400">Speed:</span>
                <span className="text-xs font-mono font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  {speedMetrics.tokPerSec} tok/s ({speedMetrics.tokens} tokens)
                </span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter inference prompt..."
              rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-amber-500"
            />

            <div className="flex justify-end">
              <button
                onClick={handleTestInference}
                disabled={isRunning}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-all disabled:opacity-50"
              >
                {isRunning ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
                <span>Run Telemetry Probe</span>
              </button>
            </div>
          </div>

          {/* Response window */}
          <div className="flex flex-col flex-1 min-h-[160px] bg-black/80 border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-300 overflow-y-auto">
            {isRunning ? (
              <div className="flex items-center gap-2 text-zinc-500 italic py-4">
                <RefreshCw className="w-4 h-4 animate-spin text-amber-400" />
                <span>Evaluating prompt through Token Horizon proxy...</span>
              </div>
            ) : response ? (
              <p className="whitespace-pre-wrap leading-relaxed">{response}</p>
            ) : (
              <div className="text-zinc-600 italic py-4 text-center">
                Click 'Run Telemetry Probe' to test local model throughput and ground-truth tok/s.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
