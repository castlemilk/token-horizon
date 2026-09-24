import React, { useMemo, useState } from 'react'
import { api } from '../../api/client'
import { usePoll, useSeries } from '../../api/hooks'
import { fmtMemory, fmtRate } from '../../api/format'
import { Sparkline } from '../charts'
import { Activity, Container, ListFilter } from 'lucide-react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table'
import type { ProcSample } from '../../api/types'

type SortKey = 'cpu' | 'mem' | 'disk' | 'net'
const col = createColumnHelper<ProcSample>()

/** Mirrors the Swift activityTab: system-rate sparklines + process monitor + Docker. */
export const ActivityTab: React.FC = () => {
  const { data: stats } = usePoll('stats', api.stats, 2000)
  const { data: procs } = usePoll('processes', api.processes, 3000)
  const { data: docker } = usePoll('docker', api.docker, 5000)

  const sys = stats?.system
  const cpuSeries = useSeries(sys?.cpu_percent ?? null)
  const ramSeries = useSeries(sys ? (sys.ram_used_gb / Math.max(1, sys.ram_total_gb)) * 100 : null)
  const diskSeries = useSeries(sys?.disk_mbps ?? null)
  const netSeries = useSeries(sys?.net_mbps ?? null)

  const [sortId, setSortId] = useState<SortKey>('cpu')
  const [query, setQuery] = useState('')

  const rows = useMemo(() => {
    const all = procs?.all ?? []
    const filtered = query
      ? all.filter((p) => p.name.toLowerCase().includes(query) || p.command.toLowerCase().includes(query))
      : all
    return filtered.slice(0, 200)
  }, [procs, query])

  const columns = useMemo(
    () => [
      col.accessor('pid', { header: 'pid', cell: (c) => <span className="text-zinc-500">{c.getValue()}</span> }),
      col.accessor('name', {
        header: 'name',
        cell: (c) => (
          <span className="truncate max-w-[260px] inline-block align-middle" title={c.row.original.command}>
            {c.getValue()}
          </span>
        ),
      }),
      col.accessor('user', { header: 'user', cell: (c) => <span className="text-zinc-500">{c.getValue()}</span> }),
      col.accessor('cpu', {
        id: 'cpu',
        header: 'cpu%',
        cell: (c) => (
          <span className={c.getValue() > 50 ? 'text-red-400' : 'text-orange-300'}>{c.getValue().toFixed(1)}</span>
        ),
      }),
      col.accessor('memMB', {
        id: 'mem',
        header: 'mem',
        cell: (c) => <span className="text-cyan-300">{fmtMemory(c.getValue())}</span>,
      }),
      col.accessor((p) => p.diskReadMBps + p.diskWriteMBps, {
        id: 'disk',
        header: 'disk r/w',
        cell: (c) => <span className="text-zinc-400">{c.getValue().toFixed(1)}M/s</span>,
      }),
      col.accessor((p) => p.netInKBps + p.netOutKBps, {
        id: 'net',
        header: 'net i/o',
        cell: (c) => <span className="text-zinc-400">{(c.getValue() / 1024).toFixed(1)}M/s</span>,
      }),
    ],
    []
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting: [{ id: sortId, desc: true }] },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="flex flex-col gap-4 p-4">
      <Banner
        icon={<Activity className="w-5 h-5 text-emerald-400" />}
        title="System Activity"
        sub="Live host metrics, process table, and container usage — the macOS ACTIVITY tab."
      />

      {/* System sparklines (client-accumulated; the API serves point-in-time rates) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SysCard label="CPU" value={`${(sys?.cpu_percent ?? 0).toFixed(0)}%`} series={cpuSeries} color="#ef4444" />
        <SysCard
          label="RAM"
          value={`${(sys?.ram_used_gb ?? 0).toFixed(1)}/${(sys?.ram_total_gb ?? 0).toFixed(0)}G`}
          series={ramSeries}
          color="#22d3ee"
        />
        <SysCard label="DISK" value={fmtRate(sys?.disk_mbps ?? 0)} series={diskSeries} color="#f97316" />
        <SysCard label="NET" value={fmtRate(sys?.net_mbps ?? 0)} series={netSeries} color="#a855f7" />
      </div>

      {/* Processes */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800">
          <ListFilter className="w-3.5 h-3.5 text-zinc-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.toLowerCase())}
            placeholder="filter processes…"
            className="bg-transparent text-xs font-mono text-zinc-200 placeholder-zinc-600 outline-none w-56"
          />
          <div className="ml-auto flex gap-1">
            {(['cpu', 'mem', 'disk', 'net'] as SortKey[]).map((k) => (
              <button
                key={k}
                onClick={() => setSortId(k)}
                className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                  sortId === k ? 'bg-zinc-100 text-zinc-900' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500 text-[9px] uppercase">
              <tr>
                {table.getHeaderGroups()[0]?.headers.map((h, i) => (
                  <th
                    key={h.id}
                    className={`px-3 py-1.5 ${i < 3 ? 'text-left' : 'text-right'} ${h.column.getCanSort() ? 'cursor-pointer hover:text-zinc-300' : ''}`}
                    onClick={() => h.column.getCanSort() && h.column.toggleSorting(true)}
                  >
                    {flexRender(h.column.columnDef.header ?? h.column.id, h.getContext())}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/60">
              {table.getRowModel().rows.map((r) => (
                <tr key={r.original.pid} className="text-zinc-300 hover:bg-zinc-900/50">
                  {r.getVisibleCells().map((cell, i) => (
                    <td key={cell.id} className={`px-3 py-1 ${i < 3 ? 'text-left' : 'text-right'}`}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Docker */}
      {docker && docker.count > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800 text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
            <Container className="w-3.5 h-3.5 text-sky-400" />
            Docker · {docker.count} containers · {(docker.totalContainerCpu ?? 0).toFixed(1)}% CPU ·{' '}
            {fmtMemory(docker.totalContainerMemMB)}
            {docker.vmHostPid > 0 && (
              <span className="text-zinc-600 normal-case">
                · VM host pid {docker.vmHostPid} {fmtMemory(docker.vmHostMemMB)}
              </span>
            )}
          </div>
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-zinc-900/60 text-zinc-500 text-[9px] uppercase">
              <tr>
                <th className="text-left px-3 py-1.5">container</th>
                <th className="text-left px-3 py-1.5">image</th>
                <th className="text-right px-3 py-1.5">cpu%</th>
                <th className="text-right px-3 py-1.5">mem</th>
                <th className="text-right px-3 py-1.5">net i/o</th>
                <th className="text-left px-3 py-1.5">status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900/60">
              {docker.containers.map((c) => (
                <tr key={c.id} className="text-zinc-300">
                  <td className="px-3 py-1">{c.name}</td>
                  <td className="px-3 py-1 text-zinc-500 truncate max-w-[180px]">{c.image}</td>
                  <td className="px-3 py-1 text-right text-orange-300">{c.cpu.toFixed(1)}</td>
                  <td className="px-3 py-1 text-right text-cyan-300">
                    {fmtMemory(c.memMB)} <span className="text-zinc-600">/{fmtMemory(c.memLimitMB)}</span>
                  </td>
                  <td className="px-3 py-1 text-right text-zinc-400">{(c.netInMB + c.netOutMB).toFixed(0)}M</td>
                  <td className="px-3 py-1 text-zinc-500">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SysCard({ label, value, series, color }: { label: string; value: string; series: number[]; color: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-500">{label}</span>
        <span className="text-xs font-mono font-bold" style={{ color }}>
          {value}
        </span>
      </div>
      <div className="mt-2">
        <Sparkline values={series} color={color} height={36} />
      </div>
    </div>
  )
}

export function Banner({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
      <div className="flex items-center gap-2.5">
        {icon}
        <div>
          <span className="font-bold text-sm text-zinc-100 uppercase tracking-wide">{title}</span>
          <p className="text-xs text-zinc-400">{sub}</p>
        </div>
      </div>
    </div>
  )
}
