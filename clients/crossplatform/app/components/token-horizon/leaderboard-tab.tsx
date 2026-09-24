import React, { useState } from 'react'
import { api } from '../../api/client'
import { usePoll } from '../../api/hooks'
import { fmtTokens, fmtCost } from '../../api/format'
import { Banner } from './activity-tab'
import { Trophy, Share2, RefreshCw, UploadCloud, DownloadCloud } from 'lucide-react'

const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: '7 Days' },
  { id: 'all', label: 'All-Time' },
  { id: 'streak', label: 'Streak' },
]

const BTN =
  'flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-mono font-bold text-zinc-300 disabled:opacity-50'

/** Mirrors the Swift leaderboardTab: ranked table, user rank, achievements,
 * share-card + cloud publish actions. */
export const LeaderboardTab: React.FC = () => {
  const [period, setPeriod] = useState('today')
  const [team, setTeam] = useState('')
  const { data, ok } = usePoll(`leaderboard-${period}-${team}`, () => api.leaderboard(period, team || undefined), 30_000)
  const { data: ach } = usePoll('achievements', api.achievements, 60_000)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const act = async (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) => {
    setBusy(true)
    try {
      const r = await fn()
      setNotice(r.message ?? r.error ?? (r.ok ? 'done' : 'failed'))
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
      setTimeout(() => setNotice(''), 5000)
    }
  }

  const copyShare = async () => {
    try {
      const card = await api.shareCard(period)
      await navigator.clipboard.writeText(card)
      setNotice('share card copied')
    } catch {
      setNotice('share failed')
    }
    setTimeout(() => setNotice(''), 5000)
  }

  const user = data?.userRank

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Trophy className="w-5 h-5 text-yellow-400" />}
        title="Leaderboard"
        sub="Token-consumption rankings — local + cloud/sheet-synced entries."
      />

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`px-3 py-1 rounded-full text-[10px] font-mono font-bold uppercase ${
              period === p.id ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {p.label}
          </button>
        ))}
        <input
          value={team}
          onChange={(e) => setTeam(e.target.value)}
          placeholder="team filter…"
          className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs font-mono text-zinc-200 outline-none w-36"
        />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={copyShare} className={BTN}>
            <Share2 className="w-3 h-3" /> Share
          </button>
          <button onClick={() => void act(api.leaderboardSync)} disabled={busy} className={BTN}>
            <RefreshCw className={`w-3 h-3 ${busy ? 'animate-spin' : ''}`} /> Sync
          </button>
          <button onClick={() => void act(api.publishCloud)} disabled={busy} className={BTN}>
            <UploadCloud className="w-3 h-3" /> Publish
          </button>
          <button onClick={() => void act(api.pullCloud)} disabled={busy} className={BTN}>
            <DownloadCloud className="w-3 h-3" /> Pull
          </button>
        </div>
      </div>
      {notice && <p className="text-[10px] font-mono text-emerald-400">{notice}</p>}

      {/* User rank card */}
      {user && (
        <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 flex items-center gap-6">
          <span className="text-2xl font-mono font-bold text-emerald-400">#{user.rank}</span>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-zinc-100">{user.entry.handle} · you</span>
            <span className="text-[10px] font-mono text-zinc-500">
              {user.league || 'unranked'} · mmr {user.mmr} · top {user.percentile.toFixed(0)}%
            </span>
          </div>
          <div className="ml-auto flex gap-5 font-mono text-xs">
            <span className="text-emerald-400">{fmtTokens(user.entry.tokensToday)} today</span>
            <span className="text-zinc-300">{fmtTokens(user.entry.tokens7d)} 7d</span>
            <span className="text-zinc-400">{fmtTokens(user.entry.tokensAll)} all</span>
            <span className="text-orange-300">{user.entry.streakDays}d streak</span>
          </div>
        </section>
      )}

      {/* Rankings */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <div className="px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
          {data?.periodTitle ?? ''} — {data?.total ?? 0} entries {!ok && <span className="text-red-400">· api offline</span>}
        </div>
        <div className="max-h-[380px] overflow-y-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500 text-[9px] uppercase">
              <tr>
                <th className="text-left px-3 py-1.5">rank</th>
                <th className="text-left px-3 py-1.5">handle</th>
                <th className="text-left px-3 py-1.5">league</th>
                <th className="text-right px-3 py-1.5">today</th>
                <th className="text-right px-3 py-1.5">7d</th>
                <th className="text-right px-3 py-1.5">all-time</th>
                <th className="text-right px-3 py-1.5">cost</th>
                <th className="text-right px-3 py-1.5">streak</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/60">
              {(data?.leaderboard ?? []).map((r) => (
                <tr key={r.entry.id} className={r.entry.isLocal ? 'bg-emerald-500/5 text-zinc-100' : 'text-zinc-300'}>
                  <td className="px-3 py-1.5">
                    <span className="text-zinc-500">#{r.rank}</span> <span>{r.badge}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    {r.entry.handle}
                    {r.entry.isLocal && <span className="text-emerald-400 text-[9px]"> ·you</span>}
                    {r.entry.team && <span className="text-zinc-600"> @{r.entry.team}</span>}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-500">{r.league || '—'}</td>
                  <td className="px-3 py-1.5 text-right text-emerald-400">{fmtTokens(r.entry.tokensToday)}</td>
                  <td className="px-3 py-1.5 text-right">{fmtTokens(r.entry.tokens7d)}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{fmtTokens(r.entry.tokensAll)}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-500">{r.costFormatted || fmtCost(r.entry.costAll)}</td>
                  <td className="px-3 py-1.5 text-right text-orange-300">{r.entry.streakDays}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Season + achievements */}
      {ach && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
              {ach.season.displayName || `Season ${ach.season.number}`} — {ach.season.daysRemaining}d left
            </span>
            <span className="text-xs font-mono text-emerald-400">{fmtTokens(ach.seasonTokens)} this season</span>
          </div>
          <div className="h-1.5 rounded-full bg-zinc-800 mb-4 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${Math.round((ach.season.progress ?? 0) * 100)}%` }} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {ach.achievements.map((a) => (
              <div
                key={a.id}
                className={`rounded-lg border p-2.5 ${a.unlocked ? 'border-amber-500/40 bg-amber-500/5' : 'border-zinc-800 opacity-50'}`}
              >
                <span className="block text-[10px] font-mono font-bold text-zinc-200">{a.title ?? a.name ?? a.id}</span>
                {a.description && (
                  <span className="block text-[9px] font-mono text-zinc-500 mt-0.5">{a.description}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
