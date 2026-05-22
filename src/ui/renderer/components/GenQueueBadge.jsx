/**
 * GenQueueBadge — shows estimated generation time + ComfyUI queue depth.
 *
 * Usage:
 *   <GenQueueBadge kind="image" workflow="ltx_img2video" />
 *   <GenQueueBadge kind="video" workflow="ltx_img2video" />
 *
 * Fetches /api/queue/gen-stats on mount and every 10s.
 * Renders a small inline chip: "~12s · 3 in coda" or "~1m 4s · 0 in coda"
 */

import { useState, useEffect, useRef } from 'react'
import { Clock, Layers } from 'lucide-react'
import clsx from 'clsx'

const API = 'http://localhost:8765/api'
const POLL_MS = 10_000

function fmtSec(s) {
  if (!s || s <= 0) return null
  if (s < 60) return `~${Math.round(s)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return r > 0 ? `~${m}m ${r}s` : `~${m}m`
}

// Module-level cache so multiple badges don't hammer the API
let _cache = null
let _cacheTime = 0
let _pending = null

async function fetchStats() {
  const now = Date.now()
  if (_cache && now - _cacheTime < POLL_MS) return _cache
  if (_pending) return _pending
  _pending = fetch(`${API}/queue/gen-stats`)
    .then(r => r.json())
    .then(data => {
      _cache = data
      _cacheTime = Date.now()
      _pending = null
      return data
    })
    .catch(() => { _pending = null; return _cache })
  return _pending
}

export function useGenStats(kind, workflow) {
  const [stats, setStats] = useState(null)
  const timerRef = useRef(null)

  async function load() {
    const data = await fetchStats()
    if (!data) return
    const avg = data.averages?.[kind]?.[workflow]
    setStats({
      avgSec: avg?.avg_sec ?? null,
      count: avg?.count ?? 0,
      queueDepth: data.queue_depth ?? 0,
    })
  }

  useEffect(() => {
    load()
    timerRef.current = setInterval(load, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [kind, workflow])

  return stats
}

export default function GenQueueBadge({ kind = 'image', workflow = '', className = '' }) {
  const stats = useGenStats(kind, workflow)

  if (!stats) return null

  const timeLabel = fmtSec(stats.avgSec)
  const queueLabel = stats.queueDepth > 0
    ? `${stats.queueDepth} in coda`
    : null

  if (!timeLabel && !queueLabel) return null

  return (
    <span className={clsx(
      'inline-flex items-center gap-2 text-[10px] font-mono text-[var(--text3)]',
      className
    )}>
      {timeLabel && (
        <span className="flex items-center gap-1">
          <Clock size={9} />
          {timeLabel}
        </span>
      )}
      {timeLabel && queueLabel && <span className="opacity-40">·</span>}
      {queueLabel && (
        <span className={clsx(
          'flex items-center gap-1',
          stats.queueDepth > 0 && 'text-[var(--amber)]'
        )}>
          <Layers size={9} />
          {queueLabel}
        </span>
      )}
    </span>
  )
}
