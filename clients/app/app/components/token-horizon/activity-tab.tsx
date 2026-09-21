import React from 'react'
import { StatsResponse } from './types'
import { Activity, Layers, UserCheck } from 'lucide-react'

interface ActivityTabProps {
  stats: StatsResponse | null
}

export const ActivityTab: React.FC<ActivityTabProps> = ({ stats }) => {
  const tools = stats?.usage.perTool || []
  const claudeAccounts = stats?.usage.claudeAccounts || []

  const formatTokens = (n: number) => {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
    return n.toString()
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Top Banner */}
      <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Activity className="w-5 h-5 text-emerald-400" />
          <div>
            <span className="font-bold text-sm text-zinc-100 uppercase tracking-wide">
              AI Token Activity & Provider Consumption
            </span>
            <p className="text-xs text-zinc-400">
              Breakdown of tokens and costs tracked across coding assistants and CLI agents.
            </p>
          </div>
        </div>
      </div>

      {/* Tool Distribution Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Tools Breakdown */}
        <div className="flex flex-col p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            <Layers className="w-4 h-4 text-sky-400" />
            <span>Active Coding Tools</span>
          </div>

          <div className="divide-y divide-zinc-900 font-mono text-xs">
            {tools.map((t) => (
              <div key={t.tool} className="flex items-center justify-between py-2.5">
                <div className="flex flex-col">
                  <span className="font-bold text-zinc-200 uppercase">{t.tool}</span>
                  <span className="text-[10px] text-zinc-500">All-Time: {formatTokens(t.tokensAllTime)} tokens</span>
                </div>
                <div className="flex flex-col text-right">
                  <span className="font-bold text-zinc-100">{formatTokens(t.tokensToday)} today</span>
                  <span className="text-[10px] text-emerald-400">${t.costToday.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Discovered Claude Accounts */}
        <div className="flex flex-col p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
            <UserCheck className="w-4 h-4 text-purple-400" />
            <span>Discovered Claude Profiles</span>
          </div>

          <div className="divide-y divide-zinc-900 font-mono text-xs">
            {claudeAccounts.map((acct) => (
              <div key={acct.id} className="flex items-center justify-between py-2.5">
                <div className="flex flex-col">
                  <span className="font-bold text-zinc-200">{acct.label}</span>
                  <span className="text-[10px] text-zinc-500">{acct.email || acct.id}</span>
                </div>
                <div className="flex flex-col text-right">
                  <span className="font-bold text-zinc-100">{formatTokens(acct.tokensToday)}</span>
                  <span className="text-[10px] text-emerald-400">${acct.costToday.toFixed(2)} today</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
