import React, { useState } from 'react'
import { api } from '../../api/client'
import { endpoints } from '../../api/config'
import { usePoll } from '../../api/hooks'
import { fmtAgo } from '../../api/format'
import { Banner } from './activity-tab'
import { Settings, Trash2, Save } from 'lucide-react'

/** Mirrors the API-backed parts of the Swift settingsTab: durable cache,
 * leaderboard cloud/sheets config, widget chart window. App-local toggles
 * (surface mode, tray icon, launch-at-login) are daemon-side and not exposed. */
export const SettingsTab: React.FC = () => {
  const { data: cache, ok } = usePoll('cache', api.cache, 10_000)
  const { data: cfg } = usePoll('sheetsConfig', api.sheetsConfig, 30_000)
  const [sheetsURL, setSheetsURL] = useState<string | null>(null)
  const [cloudURL, setCloudURL] = useState<string | null>(null)
  const [cloudToken, setCloudToken] = useState('')
  const [autoSync, setAutoSync] = useState<boolean | null>(null)
  const [window_, setWindow_] = useState('months')
  const [notice, setNotice] = useState('')

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  const saveConfig = async () => {
    try {
      await api.saveSheetsConfig({
        sheetsURL: sheetsURL ?? cfg?.sheetsURL ?? '',
        cloudURL: cloudURL ?? cfg?.cloudURL ?? cfg?.cloudflareURL ?? '',
        cloudToken: cloudToken || undefined,
        autoSync: autoSync ?? cfg?.autoSync ?? false,
      })
      flash('config saved')
    } catch (e) {
      flash((e as Error).message)
    }
  }

  const resetCache = async () => {
    try {
      const r = await api.resetCache()
      flash(r.message ?? 'cache cleared')
    } catch (e) {
      flash((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Settings className="w-5 h-5 text-zinc-300" />}
        title="Settings"
        sub="Daemon settings reachable over the API. App-surface toggles stay in the macOS app."
      />
      {!ok && <p className="text-[10px] font-mono text-red-400">daemon offline — {endpoints.server}</p>}
      {notice && <p className="text-[10px] font-mono text-emerald-400">{notice}</p>}

      {/* Cache */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Durable Cache</span>
        <div className="flex items-center gap-6 mt-2 font-mono text-xs text-zinc-300">
          <span>persistence {cache?.persistenceEnabled ? 'on' : 'off'}</span>
          <span>{cache?.filesCount ?? 0} files</span>
          <span>{((cache?.totalBytes ?? 0) / 1024).toFixed(0)} KB</span>
          {cache?.lastUpdated ? <span>updated {fmtAgo(cache.lastUpdated)}</span> : null}
          <button
            onClick={() => void resetCache()}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/40 hover:bg-red-900/60 border border-red-800/50 text-red-300 text-[10px] font-bold uppercase"
          >
            <Trash2 className="w-3 h-3" /> Reset cache
          </button>
        </div>
      </section>

      {/* Leaderboard sync config */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 flex flex-col gap-3">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Leaderboard Sync</span>
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-mono uppercase text-zinc-500">Cloudflare worker URL</span>
          <input
            value={cloudURL ?? cfg?.cloudURL ?? cfg?.cloudflareURL ?? ''}
            onChange={(e) => setCloudURL(e.target.value)}
            placeholder="https://token-horizon.dev"
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-mono uppercase text-zinc-500">Cloud token</span>
          <input
            type="password"
            value={cloudToken}
            onChange={(e) => setCloudToken(e.target.value)}
            placeholder="leave blank to keep current"
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[9px] font-mono uppercase text-zinc-500">Google Sheets webhook URL</span>
          <input
            value={sheetsURL ?? cfg?.sheetsURL ?? ''}
            onChange={(e) => setSheetsURL(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-xs font-mono text-zinc-300">
          <input
            type="checkbox"
            checked={autoSync ?? cfg?.autoSync ?? false}
            onChange={(e) => setAutoSync(e.target.checked)}
            className="accent-emerald-500"
          />
          auto-sync on launch
        </label>
        <div className="flex justify-end">
          <button
            onClick={() => void saveConfig()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-[10px] font-bold uppercase"
          >
            <Save className="w-3 h-3" /> Save
          </button>
        </div>
      </section>

      {/* Widget window */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Widget Chart Window</span>
        <div className="flex gap-1.5 mt-2">
          {['hours', 'days', 'weeks', 'months', 'years'].map((w) => (
            <button
              key={w}
              onClick={() => {
                setWindow_(w)
                void api
                  .widgetWindow(w)
                  .then(() => flash(`widget window → ${w}`))
                  .catch((e) => flash(e.message))
              }}
              className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold ${
                window_ === w ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {w}
            </button>
          ))}
        </div>
      </section>

      {/* Endpoints */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">Endpoints</span>
        <div className="mt-2 font-mono text-[11px] text-zinc-400 space-y-1">
          <p>
            daemon <span className="text-zinc-200">{endpoints.server}</span>
          </p>
          <p>
            engine <span className="text-zinc-200">{endpoints.engine}</span>
          </p>
          <p>
            ollama proxy <span className="text-zinc-200">{endpoints.proxy}</span>
          </p>
          <p className="text-zinc-600 text-[10px]">override via ?server= ?engine= ?proxy= (persisted in localStorage)</p>
        </div>
      </section>
    </div>
  )
}
