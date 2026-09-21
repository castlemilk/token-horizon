import React from 'react'
import { api } from '../../api/client'
import { usePoll } from '../../api/hooks'
import { fmtAgo, fmtDuration } from '../../api/format'
import { Banner } from './activity-tab'
import { TerminalSquare } from 'lucide-react'

/** Mirrors the Swift shellsTab: the POST /event shell-event ring buffer. */
export const ShellsTab: React.FC = () => {
  const { data: events } = usePoll('events', api.events, 3000)

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<TerminalSquare className="w-5 h-5 text-sky-400" />}
        title="Shell Events"
        sub="Commands ingested via POST /event (zsh hook) — cwd, duration, exit status."
      />

      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <div className="px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
          Recent — {events?.length ?? 0} events
        </div>
        <div className="divide-y divide-zinc-900/60 font-mono text-[11px]">
          {(events ?? []).map((ev) => (
            <div key={ev.id} className="flex items-center gap-3 px-4 py-2">
              <i
                className={`w-1.5 h-1.5 rounded-full inline-block shrink-0 ${ev.exit === 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
              />
              <span className="text-zinc-200 truncate flex-1" title={ev.cwd}>
                {ev.cwd.split('/').pop() || ev.cwd || '~'}
              </span>
              <span className="text-zinc-500 hidden md:inline truncate max-w-[320px]">{ev.cwd}</span>
              <span className="text-zinc-400 w-16 text-right">{fmtDuration(ev.durationMs)}</span>
              <span className={`w-10 text-right ${ev.exit === 0 ? 'text-zinc-500' : 'text-red-400'}`}>
                {ev.exit === 0 ? 'ok' : `exit ${ev.exit}`}
              </span>
              <span className="text-zinc-600 w-16 text-right">{fmtAgo(ev.time)}</span>
            </div>
          ))}
          {(events ?? []).length === 0 && (
            <div className="px-4 py-6 text-center text-zinc-600 italic">
              no shell events — install the zsh hook (shell/token-horizon.zsh)
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
