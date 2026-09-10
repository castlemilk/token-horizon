import React, { useState, useEffect } from 'react';
import { StatsResponse } from './types';
import { Header } from './header';
import { WorkflowsTab } from './workflows-tab';
import { LimitsTab } from './limits-tab';
import { InfraTab } from './infra-tab';
import { ModelsTab } from './models-tab';
import { ActivityTab } from './activity-tab';

export const TokenHorizonDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('workflows');
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [activeRunsCount, setActiveRunsCount] = useState<number>(0);

  const serverUrl = 'http://127.0.0.1:8765';
  const engineUrl = 'http://127.0.0.1:8766';
  const proxyUrl = 'http://127.0.0.1:11435';

  const fetchStats = async () => {
    try {
      const res = await fetch(`${serverUrl}/stats`);
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // server starting
    }
  };

  const fetchEngineHealth = async () => {
    try {
      const res = await fetch(`${engineUrl}/api/health`);
      if (res.ok) {
        const data = await res.json();
        setActiveRunsCount(data.activeRuns || 0);
      }
    } catch {
      // engine starting
    }
  };

  useEffect(() => {
    fetchStats();
    fetchEngineHealth();
    const statsInterval = setInterval(fetchStats, 2000);
    const engineInterval = setInterval(fetchEngineHealth, 2000);
    return () => {
      clearInterval(statsInterval);
      clearInterval(engineInterval);
    };
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0e1011] text-zinc-100 overflow-hidden font-sans">
      <Header
        stats={stats}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        activeRunsCount={activeRunsCount}
      />

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'workflows' && <WorkflowsTab engineUrl={engineUrl} />}
        {activeTab === 'limits' && <LimitsTab serverUrl={serverUrl} stats={stats} />}
        {activeTab === 'infra' && <InfraTab engineUrl={engineUrl} />}
        {activeTab === 'models' && <ModelsTab proxyUrl={proxyUrl} />}
        {activeTab === 'activity' && <ActivityTab stats={stats} />}
      </div>
    </div>
  );
};
