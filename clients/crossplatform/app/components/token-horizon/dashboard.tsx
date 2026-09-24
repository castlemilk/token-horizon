import React, { useState } from 'react'
import { api } from '../../api/client'
import { usePoll } from '../../api/hooks'
import { Header } from './header'
import { ActivityTab } from './activity-tab'
import { TokensTab } from './tokens-tab'
import { ModelsTab } from './models-tab'
import { LocalTab } from './local-tab'
import { ShellsTab } from './shells-tab'
import { LeaderboardTab } from './leaderboard-tab'
import { SettingsTab } from './settings-tab'

/** Cross-platform port of the macOS Token Horizon dashboard — the seven
 * SwiftUI tabs reimplemented over the :8765 daemon API. */
export const TokenHorizonDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('activity')
  const { data: stats } = usePoll('stats', api.stats, 2000)

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0e1011] text-zinc-100 overflow-hidden font-sans">
      <Header stats={stats} activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'activity' && <ActivityTab />}
        {activeTab === 'local' && <LocalTab />}
        {activeTab === 'tokens' && <TokensTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'shells' && <ShellsTab />}
        {activeTab === 'leaderboard' && <LeaderboardTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </div>
  )
}
