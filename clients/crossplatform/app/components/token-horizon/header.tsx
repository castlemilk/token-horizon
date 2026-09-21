import React from 'react'
import { RingGauge } from '../gauges'
import type { StatsResponse } from '../../api/types'
import { fmtTokens, fmtCost } from '../../api/format'
import { Activity, Boxes, Coins, Cpu, Settings, TerminalSquare, Trophy } from 'lucide-react'

interface HeaderProps {
  stats: StatsResponse | null
  activeTab: string
  onTabChange: (tab: string) => void
}

/** Dashboard chrome mirroring the Swift app: CPU/RAM wing gauges, title,
 * daily token/cost totals, and the macOS tab set. */
export const Header: React.FC<HeaderProps> = ({ stats, activeTab, onTabChange }) => {
  const cpuPercent = stats?.system.cpu_percent ?? 0
  const ramUsed = stats?.system.ram_used_gb ?? 0
  const ramTotal = stats?.system.ram_total_gb ?? 128
  const ramPercent = Math.round((ramUsed / ramTotal) * 100)

  const tabs = [
    { id: 'activity', label: 'Activity', icon: Activity },
    { id: 'local', label: 'Local / MLX', icon: Cpu },
    { id: 'tokens', label: 'Tokens', icon: Coins },
    { id: 'models', label: 'Models', icon: Boxes },
    { id: 'shells', label: 'Shells', icon: TerminalSquare },
    { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
    { id: 'settings', label: 'Settings', icon: Settings },
  ]

  return (
    <div className="flex flex-col border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md px-4 py-3 select-none">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <RingGauge value={cpuPercent} label="CPU" sublabel={`${cpuPercent}% load`} color="#38bdf8" />
          <RingGauge
            value={ramPercent}
            label="RAM"
            sublabel={`${ramUsed.toFixed(1)} / ${ramTotal} GB`}
            color="#a855f7"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${stats ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          <span className="font-bold text-sm tracking-wide text-zinc-100 uppercase">Token Horizon</span>
          {!stats && <span className="text-[10px] font-mono text-red-400">daemon offline</span>}
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col text-right">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Tokens Today</span>
            <span className="text-base font-mono font-bold text-zinc-100">{fmtTokens(stats?.usage.tokensToday ?? 0)}</span>
          </div>
          <div className="flex flex-col text-right">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">Cost Today</span>
            <span className="text-base font-mono font-bold text-emerald-400">{fmtCost(stats?.usage.costToday ?? 0)}</span>
          </div>
        </div>
      </div>

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
            </button>
          )
        })}
      </div>
    </div>
  )
}
