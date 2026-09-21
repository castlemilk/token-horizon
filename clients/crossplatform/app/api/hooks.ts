import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

/**
 * Poll `fn` every `ms` via TanStack Query — shared cache, deduped in-flight
 * requests, previous data kept on error (daemons restart). `ok` flips false
 * whenever the latest fetch failed, driving the offline chrome.
 */
export function usePoll<T>(key: string, fn: () => Promise<T>, ms: number): { data: T | null; ok: boolean } {
  const q = useQuery({
    queryKey: ['poll', key],
    queryFn: fn,
    refetchInterval: ms,
    refetchOnWindowFocus: false,
    retry: 1,
  })
  return { data: q.data ?? null, ok: q.isSuccess }
}

/** Append-only bounded series — accumulates samples across polls for
 * client-side sparklines (the daemon doesn't serve system-rate history). */
export function useSeries(sample: number | null, capacity = 300): number[] {
  const ref = useRef<number[]>([])
  const [, bump] = useState(0)
  useEffect(() => {
    if (sample === null || !Number.isFinite(sample)) return
    ref.current.push(sample)
    if (ref.current.length > capacity) ref.current.splice(0, ref.current.length - capacity)
    bump((n) => n + 1)
  }, [sample, capacity])
  return ref.current
}
