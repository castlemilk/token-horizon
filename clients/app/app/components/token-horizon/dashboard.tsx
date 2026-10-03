import React, { useState, useEffect } from 'react'
import { DaemonHealth, ServiceStatus, StatsResponse } from './types'
import { fetchJSON } from './api'
import { Header } from './header'
import { WorkflowsTab } from './workflows-tab'
import { LimitsTab } from './limits-tab'
import { InfraTab } from './infra-tab'
import { ModelsTab } from './models-tab'
import { ActivityTab } from './activity-tab'

export const TokenHorizonDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('activity')
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [activeRunsCount, setActiveRunsCount] = useState<number>(0)
  const [health, setHealth] = useState<DaemonHealth | null>(null)
  const [daemonStatus, setDaemonStatus] = useState<ServiceStatus>('checking')
  const [engineStatus, setEngineStatus] = useState<ServiceStatus>('checking')

  const serverUrl = 'http://127.0.0.1:8765'
  const engineUrl = 'http://127.0.0.1:8766'
  const proxyUrl = 'http://127.0.0.1:11435'

  useEffect(() => {
    const controller = new AbortController()
    let fetchingStats = false
    let fetchingEngine = false
    const fetchStats = async () => {
      if (fetchingStats) return
      fetchingStats = true
      try {
        const [nextHealth, nextStats] = await Promise.all([
          fetchJSON<DaemonHealth>(`${serverUrl}/health`, controller.signal),
          fetchJSON<StatsResponse>(`${serverUrl}/stats`, controller.signal),
        ])
        if (!nextHealth.ok) throw new Error('Daemon is not ready')
        if (!controller.signal.aborted) {
          setHealth(nextHealth)
          setStats(nextStats)
          setDaemonStatus('connected')
        }
      } catch {
        if (!controller.signal.aborted) setDaemonStatus('unavailable')
      } finally {
        fetchingStats = false
      }
    }
    const fetchEngineHealth = async () => {
      if (fetchingEngine) return
      fetchingEngine = true
      try {
        const data = await fetchJSON<{ activeRuns?: number }>(`${engineUrl}/api/health`, controller.signal)
        if (!controller.signal.aborted) {
          setActiveRunsCount(data.activeRuns ?? 0)
          setEngineStatus('connected')
        }
      } catch {
        if (!controller.signal.aborted) {
          setActiveRunsCount(0)
          setEngineStatus('unavailable')
        }
      } finally {
        fetchingEngine = false
      }
    }
    void fetchStats()
    void fetchEngineHealth()
    const statsInterval = setInterval(() => void fetchStats(), 2000)
    const engineInterval = setInterval(() => void fetchEngineHealth(), 10000)
    return () => {
      controller.abort()
      clearInterval(statsInterval)
      clearInterval(engineInterval)
    }
  }, [])

  return (
    <div className="flex flex-col h-full w-full bg-[#0e1011] text-zinc-100 overflow-hidden font-sans">
      <Header
        stats={stats}
        health={health}
        status={daemonStatus}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        activeRunsCount={activeRunsCount}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {daemonStatus === 'unavailable' && (
          <div role="status" className="px-4 py-3 text-xs text-amber-300 border-b border-zinc-800">
            The local service is reconnecting.{' '}
            {stats ? 'Showing the last received activity.' : 'Activity will appear when it is ready.'}
          </div>
        )}
        {(activeTab === 'workflows' || activeTab === 'infra') && engineStatus !== 'connected' && (
          <div role="status" className="p-6 text-sm text-zinc-400">
            {engineStatus === 'checking'
              ? 'Checking workflow service…'
              : 'The optional workflow service is unavailable. Activity and plan limits use the local desktop service and remain available.'}
          </div>
        )}
        {activeTab === 'workflows' && engineStatus === 'connected' && <WorkflowsTab engineUrl={engineUrl} />}
        {activeTab === 'limits' && <LimitsTab serverUrl={serverUrl} stats={stats} />}
        {activeTab === 'infra' && engineStatus === 'connected' && <InfraTab engineUrl={engineUrl} />}
        {activeTab === 'models' && <ModelsTab proxyUrl={proxyUrl} />}
        {activeTab === 'activity' && <ActivityTab stats={stats} />}
      </div>
    </div>
  )
}
