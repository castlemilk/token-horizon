import React, { useMemo, useState } from 'react'
import { api } from '../../api/client'
import { usePoll } from '../../api/hooks'
import { Banner } from './activity-tab'
import { Boxes, Search, ScanSearch } from 'lucide-react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table'
import type { CatalogModel } from '../../api/types'

const SCOPES = ['ALL', 'CODING', 'LOCAL', 'FREE', 'VISION', 'TOOLING']
const col = createColumnHelper<CatalogModel>()

/** Mirrors the Swift modelsTab: the full model catalog — search, scope filter,
 * sortable columns, top picks, discovery status. */
export const ModelsTab: React.FC = () => {
  const [search, setSearch] = useState('')
  const [scope, setScope] = useState('ALL')

  const { data, ok } = usePoll(`models-${search}-${scope}`, () => api.models(search, scope), 4000)
  const { data: picks } = usePoll('topPicks', api.topPicks, 60_000)
  const { data: discovery } = usePoll('discovery', api.discoveryStatus, 30_000)
  const [scanning, setScanning] = useState(false)

  const columns = useMemo(
    () => [
      col.accessor('name', {
        header: 'model',
        cell: (c) => (
          <span>
            <span className="text-zinc-100">{c.getValue()}</span>
            {c.row.original.isFree && (
              <span className="ml-1.5 text-[8px] text-emerald-400 border border-emerald-500/40 rounded px-1">FREE</span>
            )}
            {c.row.original.isLocal && (
              <span className="ml-1.5 text-[8px] text-teal-400 border border-teal-500/40 rounded px-1">LOCAL</span>
            )}
            {c.row.original.discountLabel && (
              <span className="ml-1.5 text-[8px] text-amber-400">{c.row.original.discountLabel}</span>
            )}
          </span>
        ),
      }),
      col.accessor('provider', { header: 'provider', cell: (c) => <span className="text-zinc-500">{c.getValue()}</span> }),
      col.accessor('sweScore', {
        header: 'swe',
        cell: (c) => <span className="text-sky-300">{c.getValue()?.toFixed(0) ?? '—'}</span>,
        sortUndefined: 'last',
      }),
      col.accessor('lcbScore', {
        header: 'lcb',
        cell: (c) => <span className="text-zinc-400">{c.getValue()?.toFixed(0) ?? '—'}</span>,
        sortUndefined: 'last',
      }),
      col.accessor('inputPrice', {
        header: 'in $/M',
        cell: (c) => (c.row.original.isFree ? '0' : `$${c.getValue().toFixed(2)}`),
      }),
      col.accessor('outputPrice', {
        header: 'out $/M',
        cell: (c) => (c.row.original.isFree ? '0' : `$${c.getValue().toFixed(2)}`),
      }),
      col.accessor('blendedNetCost', {
        header: 'net',
        cell: (c) => <span className="text-emerald-400">{c.row.original.blendedNetCostText}</span>,
      }),
      col.accessor('contextK', {
        header: 'ctx',
        cell: (c) => <span className="text-zinc-500">{c.row.original.contextText || `${c.getValue()}k`}</span>,
      }),
    ],
    []
  )

  const table = useReactTable({
    data: data?.models ?? [],
    columns,
    initialState: { sorting: [{ id: 'sweScore', desc: true }] },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Boxes className="w-5 h-5 text-purple-400" />}
        title="Model Catalog"
        sub={`${data?.count ?? 0} models · ${discovery?.catalogCount ?? '—'} in catalog`}
      />

      {/* Top picks */}
      {(picks?.topPicks?.length ?? 0) > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {picks!.topPicks.slice(0, 3).map((p) => (
            <div key={p.id} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono font-bold text-amber-400">
                  #{p.rank} {p.badge}
                </span>
                <span className="text-[9px] font-mono text-zinc-500 ml-auto">{p.provider}</span>
              </div>
              <span className="block text-xs font-bold text-zinc-100 mt-1 truncate">{p.name}</span>
              <div className="flex gap-3 mt-1.5 text-[10px] font-mono text-zinc-400">
                {p.sweScore != null && <span>swe {p.sweScore.toFixed(0)}</span>}
                <span>{p.blendedNetCostText}</span>
                <span>{p.contextK}k ctx</span>
              </div>
              <p className="text-[9px] font-mono text-zinc-500 mt-1.5 leading-relaxed">{p.reason}</p>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5">
          <Search className="w-3.5 h-3.5 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search models…"
            className="bg-transparent text-xs font-mono text-zinc-200 placeholder-zinc-600 outline-none w-52"
          />
        </div>
        {SCOPES.map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`px-2.5 py-1 rounded text-[10px] font-mono font-bold ${
              scope === s ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {s}
          </button>
        ))}
        <button
          onClick={() => {
            setScanning(true)
            void api.triggerScan().finally(() => setScanning(false))
          }}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[10px] font-mono font-bold text-zinc-300"
        >
          <ScanSearch className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} /> Rescan
        </button>
      </div>

      {/* Catalog table */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        {!ok && <p className="px-4 py-2 text-[10px] font-mono text-red-400">daemon offline</p>}
        <div className="max-h-[480px] overflow-y-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500 text-[9px] uppercase">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((h, i) => (
                    <th
                      key={h.id}
                      className={`px-3 py-1.5 cursor-pointer hover:text-zinc-300 ${i < 2 ? 'text-left' : 'text-right'}`}
                      onClick={h.column.getToggleSortingHandler()}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {h.column.getIsSorted() === 'asc' ? ' ▲' : h.column.getIsSorted() === 'desc' ? ' ▼' : ''}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-zinc-900/60">
              {table.getRowModel().rows.map((r) => (
                <tr key={r.original.id} className="text-zinc-300 hover:bg-zinc-900/50">
                  {r.getVisibleCells().map((cell, i) => (
                    <td key={cell.id} className={`px-3 py-1.5 ${i < 2 ? 'text-left' : 'text-right'}`}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
              {table.getRowModel().rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-zinc-600 italic">
                    no models match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-1.5 text-[9px] font-mono text-zinc-600 border-t border-zinc-900">
          showing {table.getRowModel().rows.length} of {data?.count ?? 0} · sorted by{' '}
          {table.getState().sorting[0]?.id ?? 'none'}
        </p>
      </section>
    </div>
  )
}
