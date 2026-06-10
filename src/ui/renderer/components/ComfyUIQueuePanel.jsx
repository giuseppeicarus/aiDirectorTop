/**
 * ComfyUIQueuePanel — mostra la queue ComfyUI con attribuzione a progetto/clip.
 * Polling ogni 5s. Persiste tra sessioni: mostra cosa sta generando anche
 * dopo la riapertura dell'app.
 */

import { useState, useEffect, useRef } from 'react'
import { Cpu, Loader2, Clock, Film, Image, ChevronDown, ChevronRight, X } from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

const POLL_MS = 5000

const KIND_ICONS = {
  storyboard: <Image size={10} className="shrink-0" />,
  frame:      <Image size={10} className="shrink-0 text-[#3b82f6]" />,
  video:      <Film size={10} className="shrink-0 text-[#c9a84c]" />,
  unknown:    <Cpu size={10} className="shrink-0 text-[#555568]" />,
}

const KIND_LABELS = {
  storyboard: 'Storyboard',
  frame:      'Frame HD',
  video:      'Video clip',
  unknown:    'Generazione',
}

function QueueItem({ item, isRunning }) {
  return (
    <div className={clsx(
      'flex items-center gap-2 px-2 py-1.5 rounded text-[9px] font-mono',
      isRunning ? 'bg-[#c9a84c]/8 border border-[#c9a84c]/25' : 'bg-[#0f0f18] border border-[#252533]',
    )}>
      <span className="shrink-0">
        {isRunning
          ? <Loader2 size={10} className="animate-spin text-[#c9a84c]" />
          : <Clock size={10} className="text-[#555568]" />}
      </span>
      {KIND_ICONS[item.kind] || KIND_ICONS.unknown}
      <span className={clsx('flex-1 min-w-0', isRunning ? 'text-[#e8e4dd]' : 'text-[#9090a8]')}>
        {item.clip_id
          ? <span className="truncate block">{item.clip_id}</span>
          : <span className="text-[#555568]">{item.prefix || item.prompt_id}</span>}
      </span>
      <span className={clsx(
        'shrink-0 text-[8px] px-1 py-0.5 rounded',
        isRunning ? 'bg-[#c9a84c]/20 text-[#c9a84c]' : 'bg-[#1e1e2a] text-[#555568]',
      )}>
        {KIND_LABELS[item.kind] || 'Gen'}
      </span>
      {item.project_id && (
        <span className="shrink-0 text-[8px] text-[#555568] max-w-[80px] truncate" title={item.project_id}>
          {item.project_id.replace('reel_', '').slice(0, 10)}
        </span>
      )}
    </div>
  )
}

function NodeQueueSection({ node }) {
  const [open, setOpen] = useState(true)
  const total = node.total_running + node.total_pending
  if (!node.online || total === 0) return null

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full text-left text-[9px] font-mono text-[#9090a8] hover:text-[#e8e4dd]"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span className="text-[#c9a84c]">{node.name}</span>
        <span className="text-[#555568]">
          {node.total_running > 0 && `${node.total_running} in esecuzione`}
          {node.total_running > 0 && node.total_pending > 0 && ' · '}
          {node.total_pending > 0 && `${node.total_pending} in attesa`}
        </span>
      </button>
      {open && (
        <div className="space-y-1 pl-3">
          {node.queue_running.map((item, i) => (
            <QueueItem key={item.prompt_id || i} item={item} isRunning />
          ))}
          {node.queue_pending.slice(0, 6).map((item, i) => (
            <QueueItem key={item.prompt_id || i} item={item} isRunning={false} />
          ))}
          {node.total_pending > 6 && (
            <p className="text-[8px] font-mono text-[#555568] pl-2">
              +{node.total_pending - 6} altri in attesa…
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export function useComfyUIQueue() {
  const [data, setData] = useState(null)
  const timerRef = useRef(null)

  async function poll() {
    try {
      const r = await fetch(`${API_BASE}/queue/comfyui`, { cache: 'no-store' })
      if (r.ok) setData(await r.json())
    } catch { /* ignore */ }
  }

  useEffect(() => {
    poll()
    timerRef.current = setInterval(poll, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [])

  return data
}

export function ComfyUIQueueInline({ projectId }) {
  const data = useComfyUIQueue()
  if (!data) return null

  const { total_running = 0, total_pending = 0 } = data
  if (total_running === 0 && total_pending === 0) return null

  const projectItems = (data.nodes || []).flatMap(n => [
    ...n.queue_running.map(i => ({ ...i, isRunning: true })),
    ...n.queue_pending.map(i => ({ ...i, isRunning: false })),
  ]).filter(i => !projectId || !i.project_id || i.project_id === projectId)

  if (projectId && projectItems.length === 0) return null

  return (
    <div className="rounded-lg border border-[#c9a84c]/20 bg-[#c9a84c]/5 px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 mb-1.5">
        <Loader2 size={11} className="text-[#c9a84c] animate-spin shrink-0" />
        <span className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider">
          ComfyUI — {total_running} in esecuzione{total_pending > 0 ? ` · ${total_pending} in attesa` : ''}
        </span>
      </div>
      <div className="space-y-1">
        {projectItems.slice(0, 8).map((item, i) => (
          <QueueItem key={item.prompt_id || i} item={item} isRunning={item.isRunning} />
        ))}
      </div>
    </div>
  )
}

export default function ComfyUIQueuePanel({ onClose }) {
  const data = useComfyUIQueue()
  const [visible, setVisible] = useState(true)

  if (!data || !visible) return null
  const { total_running = 0, total_pending = 0, nodes = [] } = data
  if (total_running === 0 && total_pending === 0) return null

  function handleClose() {
    setVisible(false)
    onClose?.()
  }

  return (
    <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#252533] bg-[#0f0f18]">
        <div className="flex items-center gap-2">
          <Loader2 size={12} className="text-[#c9a84c] animate-spin" />
          <span className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider">
            ComfyUI Queue
          </span>
          <span className="text-[9px] font-mono text-[#555568]">
            {total_running} run · {total_pending} wait
          </span>
        </div>
        <button type="button" onClick={handleClose} className="text-[#555568] hover:text-[#9090a8] p-0.5">
          <X size={11} />
        </button>
      </div>
      <div className="p-3 space-y-3">
        {nodes.map((node, i) => (
          <NodeQueueSection key={i} node={node} />
        ))}
      </div>
    </div>
  )
}
