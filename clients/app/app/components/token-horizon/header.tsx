import React from 'react'
import { RingGauge } from './gauges'
import { StatsResponse } from './types'
import { Zap, Activity, ShieldCheck, Server, Sparkles } from 'lucide-react'

interface HeaderProps {
  stats: StatsResponse | null
  activeTab: string
  onTabChange: (tab: string) => void
  activeRunsCount: number
}

export const Header: React.FC<HeaderProps> = ({ stats, activeTab, onTabChange, activeRunsCount }) => {
  const cpuPercent = stats?.system.cpu_percent ?? 0
  const ramUsed = stats?.system.ram_used_gb ?? 0
  const ramTotal = stats?.system.ram_total_gb ?? 128
  const ramPercent = Math.round((ramUsed / ramTotal) * 100)

  const tokensToday = stats?.usage.tokensToday ?? 0
  const costToday = stats?.usage.costToday ?? 0

  const formatTokens = (n: number) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
    return n.toString()
  }

  const tabs = [
    {
      id: 'workflows',
      label: 'Workflows & Agents',
      icon: Zap,
      badge: activeRunsCount > 0 ? `${activeRunsCount} active` : undefined,
    },
    { id: 'limits', label: 'Limits & Headroom', icon: ShieldCheck },
    { id: 'infra', label: 'Infra & Nodes', icon: Server },
    { id: 'models', label: 'Local Models', icon: Sparkles },
    { id: 'activity', label: 'Activity', icon: Activity },
  ]

  return (
    <div className="flex flex-col border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-4 py-3 select-none">
      {/* Top metrics bar */}
      <div className="flex items-center justify-between gap-4">
        {/* Left: CPU & RAM Wing Gauges */}
        <div className="flex items-center gap-6">
          <RingGauge value={cpuPercent} label="CPU" sublabel={`${cpuPercent}% load`} color="#38bdf8" />
          <RingGauge
            value={ramPercent}
            label="RAM"
            sublabel={`${ramUsed.toFixed(1)} / ${ramTotal} GB`}
            color="#a855f7"
          />
        </div>

        {/* Center: Token Horizon Title & Active Status */}
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-bold text-sm tracking-wide text-zinc-100 uppercase">Token Horizon</span>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/50">
            v0.2.0 • Cross-Platform Engine
          </span>
        </div>

        {/* Right: Daily token & cost metrics */}
        <div className="flex items-center gap-6">
          <div className="flex flex-col text-right">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Tokens Today</span>
            <span className="text-base font-mono font-bold text-zinc-100">{formatTokens(tokensToday)}</span>
          </div>
          <div className="flex flex-col text-right">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Cost Today</span>
            <span className="text-base font-mono font-bold text-emerald-400">${costToday.toFixed(2)}</span>
          </div>
        </div>
      </div>

      {/* Tabs navigation */}
      <div className="flex items-center gap-1.5 mt-3 pt-2 border-t border-zinc-900 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/80'
              }`}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-sky-400' : 'text-zinc-500'}`} />
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 font-mono">
                  {tab.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
