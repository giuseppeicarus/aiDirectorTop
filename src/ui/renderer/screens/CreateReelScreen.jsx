/**
 * CreateReel — reel da descrizione + immagini di riferimento (LLM vision).
 * Storyboard bassa risoluzione → approvazione → HD + clip video.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import {
  ImagePlus, Loader2, Sparkles, Check, RefreshCw, X, Film,
  LayoutGrid, AlertCircle, Image as ImageIcon, Trash2, Clapperboard,
  ChevronRight, Instagram, Library, Search,
} from 'lucide-react'
import clsx from 'clsx'
import ProjectDirBanner from '../components/ProjectDirBanner'
import {
  BACKEND_ORIGIN,
  mediaThumbUrl,
  mediaFileUrl,
  clipReelFramePreviewUrl,
  clipReelStoryboardPreviewUrl,
  reelFrameClipUrl,
  resolveBackendUrl,
  resolveReelMediaProjectId,
} from '../utils/mediaUrl'
import { resolveImagePaths } from '../utils/electronFilePaths'

const MAX_REFS = 12

const JOB_STATUS_META = {
  done: { label: 'Completato', color: '#22c55e', bg: '#22c55e18' },
  running: { label: 'In corso', color: '#c9a84c', bg: '#c9a84c18' },
  awaiting_storyboard: { label: 'Storyboard', color: '#3b82f6', bg: '#3b82f618' },
  interrupted: { label: 'Interrotto', color: '#f59e0b', bg: '#f59e0b18' },
  failed: { label: 'Fallito', color: '#ef4444', bg: '#ef444418' },
  cancelled: { label: 'Annullato', color: '#555568', bg: '#55556818' },
}

function StatusBadge({ status, small }) {
  const m = JOB_STATUS_META[status] ?? JOB_STATUS_META.failed
  return (
    <span
      className={clsx('font-mono rounded px-1.5 py-0.5', small ? 'text-[8px]' : 'text-[9px]')}
      style={{ background: m.bg, color: m.color }}
    >
      {m.label}
    </span>
  )
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'adesso'
  if (m < 60) return `${m} min fa`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h fa`
  return `${Math.floor(h / 24)}g fa`
}

function reelVideoUrl(job) {
  const url = job.result?.video_url
  if (url) return `${BACKEND_ORIGIN}${url.replace('/api/trailer/', '/api/reel/')}`
  const storage = job.storage_project_id || job.project_id
  const name = job.result?.filename
  if (storage && name) {
    return `${BACKEND_ORIGIN}/api/reel/output/${encodeURIComponent(storage)}/${encodeURIComponent(name)}`
  }
  return null
}
const DEFAULT_CONFIG = {
  duration_sec: 30,
  aspect_ratio: '9:16',
  width: 1080,
  height: 1920,
  style: 'cinematic, photorealistic, dramatic lighting',
  storyboard_max_side: 320,
  storyboard_steps: 10,
  max_clip_sec: 5,
  concurrent_jobs: 1,
  clip_backend: 'auto',
  allow_ffmpeg_fallback: false,
  txt2img_workflow: 'z_image_txt2img',
  img2video_workflow: 'ltx_img2video',
}

const PHASES = [
  { id: 'vision_analysis', label: 'Vision (riferimenti)' },
  { id: 'reel_director', label: 'Regia' },
  { id: 'prompt_generator', label: 'Prompt' },
  { id: 'storyboard', label: 'Storyboard LD' },
  { id: 'production', label: 'HD + Video' },
]

function GoldBtn({ children, onClick, disabled, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
        'bg-[#c9a84c] text-[#0a0a0f] hover:bg-[#e6c46a] disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, onClick, disabled, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-2 px-3 py-1.5 rounded-md text-xs border border-[#32324a]',
        'text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#c9a84c]/40 disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

function ClipPreviewCell({ clip, projectId, jobId, aspectRatio = '9:16' }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const isPlaceholder = clip?.storyboard_placeholder || clip?.storyboard_ok === false
  const preferHd = clip?.status === 'generating' || clip?.status === 'done' || clip?.hd_frame_ready

  useEffect(() => {
    let cancelled = false
    setFailed(false)

    async function load() {
      const mediaIds = [projectId, jobId && `reel_${jobId}`, 'reel_standalone'].filter(Boolean)
      const seen = new Set()
      const urls = []
      for (const pid of mediaIds) {
        if (seen.has(pid)) continue
        seen.add(pid)
        if (preferHd) {
          const hd = clipReelFramePreviewUrl(clip, pid)
          if (hd) urls.push(hd)
        }
        const sb = clipReelStoryboardPreviewUrl(clip, pid)
        if (sb) urls.push(sb)
      }
      if (clip?.frame_url) {
        const resolved = resolveBackendUrl(clip.frame_url) || clip.frame_url
        if (resolved && !urls.includes(resolved)) urls.unshift(resolved)
      }

      const localPath = clip?.first_frame_path || clip?.storyboard_path
      if (localPath && window.studio?.reel?.readImageLocal) {
        const r = await window.studio.reel.readImageLocal(localPath)
        if (!cancelled && r?.ok && r.dataUrl) {
          setFailed(false)
          setSrc(r.dataUrl)
          return
        }
      }

      if (window.studio?.reel?.fetchImageUrl) {
        for (const httpUrl of urls) {
          const sep = httpUrl.includes('?') ? '&' : '?'
          const r = await window.studio.reel.fetchImageUrl(`${httpUrl}${sep}v=${retry}`)
          if (!cancelled && r?.ok && r.dataUrl) {
            setFailed(false)
            setSrc(r.dataUrl)
            return
          }
        }
      }
      if (!cancelled && urls[0]) {
        const sep = urls[0].includes('?') ? '&' : '?'
        setSrc(`${urls[0]}${sep}v=${retry}`)
      } else if (!cancelled) {
        setSrc(null)
      }
    }

    load()
    return () => { cancelled = true }
  }, [
    clip?.clip_id,
    clip?.storyboard_path,
    clip?.first_frame_path,
    clip?.frame_url,
    clip?.status,
    projectId,
    jobId,
    retry,
    preferHd,
  ])

  useEffect(() => {
    if (src || failed || isPlaceholder || !clip?.clip_id) return undefined
    const iv = setInterval(() => setRetry(r => r + 1), 2000)
    return () => clearInterval(iv)
  }, [clip?.clip_id, src, failed, isPlaceholder])

  if (clip?.clip_url) {
    const vsrc = clip.clip_url.startsWith('http') ? clip.clip_url : `${BACKEND_ORIGIN}${clip.clip_url}`
    return (
      <video src={vsrc} className="w-full h-full object-cover" muted playsInline preload="metadata" />
    )
  }

  if (isPlaceholder) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-[#f59e0b] bg-[#0f0f18]">
        <AlertCircle size={14} />
        <span className="text-[7px] font-mono">ComfyUI fallito</span>
      </div>
    )
  }

  const loading = !src && !failed && (
    clip?.status === 'waiting' || clip?.status === 'generating' || clip?.status === 'storyboard'
  )

  if (loading) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-[#0f0f18]">
        <Loader2 size={14} className="text-[#c9a84c] animate-spin" />
        {clip?.comfyuiPct > 0 && (
          <span className="text-[8px] font-mono text-[#c9a84c]">{clip.comfyuiPct}%</span>
        )}
      </div>
    )
  }

  if (!src) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0f0f18] text-[#555568]">
        <ImageIcon size={14} />
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={clip?.clip_id}
      className="w-full h-full object-cover"
      onError={() => {
        if (retry < 4) setRetry(r => r + 1)
        else { setSrc(null); setFailed(true) }
      }}
    />
  )
}

function ClipPreviewGrid({ clips, projectId, jobId, aspectRatio }) {
  const isPortrait = aspectRatio === '9:16'
  const sorted = [...clips].sort((a, b) => (a.clip_id || '').localeCompare(b.clip_id || ''))
  const withImage = clips.filter(c =>
    c.storyboard_ok !== false && !c.storyboard_placeholder && (c.frame_url || c.storyboard_path),
  ).length

  if (!clips.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-[#555568] gap-2">
        <ImageIcon size={24} />
        <p className="text-[10px] font-mono">Le anteprime appariranno qui</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[9px] font-mono text-[#9090a8]">
        Anteprime {withImage}/{clips.length}
      </p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))' }}>
        {sorted.map(clip => (
          <div
            key={clip.clip_id}
            className={clsx(
              'rounded-lg overflow-hidden border bg-[#16161f]',
              clip.status === 'done' && 'border-[#22c55e]/50',
              clip.status === 'storyboard' && 'border-[#3b82f6]/40',
              clip.status === 'storyboard_failed' && 'border-[#f59e0b]/50',
              clip.status === 'generating' && 'border-[#c9a84c]/50',
              clip.status === 'waiting' && 'border-[#252533]',
            )}
          >
            <div style={{ aspectRatio: isPortrait ? '9/16' : '16/9' }}>
              <ClipPreviewCell clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} />
            </div>
            <p className="text-[7px] font-mono text-[#c9a84c] px-1 py-0.5 truncate">{clip.clip_id}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function JobsListView({ projectId, refreshKey, onNew, onViewDetail }) {
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)

  async function fetchJobs() {
    setLoading(true)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs?project_id=${encodeURIComponent(projectId)}`,
      )
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { fetchJobs() }, [projectId, refreshKey])

  async function handleDelete(e, job) {
    e.stopPropagation()
    setDeletingId(job.job_id)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=true`,
        { method: 'DELETE' },
      )
      if (res.ok) setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <Instagram size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">CreateReel</h1>
          {!loading && jobs.length > 0 && (
            <span className="text-[10px] font-mono text-[#555568]">{jobs.length} lavori</span>
          )}
        </div>
        <GoldBtn onClick={onNew}>
          <Sparkles size={14} />
          Nuovo reel
        </GoldBtn>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-[#555568]">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm font-mono">Caricamento...</span>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <Film size={28} className="text-[#252533]" />
            <p className="text-sm font-mono text-[#555568]">Nessun reel generato</p>
            <GoldBtn onClick={onNew}>
              <Sparkles size={14} />
              Crea il primo reel
            </GoldBtn>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
            {jobs.map(job => {
              const meta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.failed
              const videoSrc = reelVideoUrl(job)
              return (
                <div
                  key={job.job_id}
                  onClick={() => onViewDetail(job)}
                  className="rounded-xl border border-[#252533] bg-[#16161f] p-4 cursor-pointer hover:border-[#32324a] transition-colors"
                >
                  <div
                    className="rounded-lg mb-3 overflow-hidden flex items-center justify-center bg-[#0f0f18] border border-[#252533]"
                    style={{ aspectRatio: '9/16', maxHeight: 160 }}
                  >
                    {videoSrc ? (
                      <video
                        src={videoSrc}
                        className="w-full h-full object-cover"
                        muted
                        onMouseEnter={e => e.target.play()}
                        onMouseLeave={e => { e.target.pause(); e.target.currentTime = 0 }}
                      />
                    ) : (
                      <Film size={22} style={{ color: meta.color, opacity: 0.4 }} />
                    )}
                  </div>
                  <p className="text-[11px] font-mono text-[#e8e4dd] truncate mb-1">
                    {job.title || job.description?.slice(0, 40) || job.job_id}
                  </p>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[9px] font-mono text-[#555568]">{timeAgo(job.created_at)}</span>
                    <StatusBadge status={job.status} small />
                  </div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {[job.config?.aspect_ratio, `${job.config?.duration_sec}s`, job.reference_count ? `${job.reference_count} ref` : null].filter(Boolean).map(v => (
                      <span key={v} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#555568]">{v}</span>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onViewDetail(job) }}
                      className="flex-1 py-1.5 rounded text-[9px] font-mono border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd]"
                    >
                      Dettagli
                    </button>
                    <button
                      type="button"
                      onClick={e => handleDelete(e, job)}
                      disabled={deletingId === job.job_id}
                      className="px-2 py-1.5 rounded text-[9px] font-mono border border-[#252533] text-[#555568] hover:text-[#ef4444]"
                    >
                      {deletingId === job.job_id ? <Loader2 size={9} className="animate-spin" /> : <X size={9} />}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function JobDetailView({ job, projectId, onBack, onRestart, onDelete }) {
  const [deleting, setDeleting] = useState(false)
  const videoSrc = reelVideoUrl(job)
  const storageId = job.storage_project_id || job.project_id

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=true`,
        { method: 'DELETE' },
      )
      if (res.ok) onDelete()
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <button type="button" onClick={onBack} className="flex items-center gap-1 text-[10px] font-mono text-[#9090a8] hover:text-[#e8e4dd]">
          <ChevronRight size={12} className="rotate-180" />
          Lista
        </button>
        <div className="flex gap-2">
          <GoldBtn onClick={() => onRestart(job)}>
            {job.status === 'awaiting_storyboard' ? <Check size={13} /> : <RefreshCw size={13} />}
            {job.status === 'awaiting_storyboard' ? 'Approva storyboard' : 'Riapri / riprendi'}
          </GoldBtn>
          <GhostBtn onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Elimina
          </GhostBtn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-2xl">
        <div className="flex items-center gap-2">
          <StatusBadge status={job.status} />
          <code className="text-[10px] text-[#c9a84c]">{job.job_id}</code>
        </div>
        <p className="text-sm text-[#e8e4dd]">{job.description || '—'}</p>
        <p className="text-[10px] font-mono text-[#555568]">Cartella: {storageId}</p>
        {videoSrc && (
          <video src={videoSrc} controls className="w-full max-w-sm rounded-lg border border-[#252533]" />
        )}
        {job.result?.storyboard?.length > 0 && (
          <p className="text-[10px] font-mono text-[#9090a8]">
            {job.result.storyboard.length} frame storyboard salvati
          </p>
        )}
        {job.error && (
          <p className="text-xs text-[#ef4444] font-mono">{job.error}</p>
        )}
      </div>
    </div>
  )
}

// ── Media Library picker modal ───────────────────────────────────────────────

function MediaLibraryPicker({ onConfirm, onClose }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(new Set())
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch(`${BACKEND_ORIGIN}/api/media?type=image`)
      .then(r => r.json())
      .then(data => { setItems(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const filtered = items.filter(item => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      (item.filename || '').toLowerCase().includes(q) ||
      (item.project_title || '').toLowerCase().includes(q)
    )
  })

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function handleConfirm() {
    const paths = items
      .filter(i => selected.has(i.id) && i.filepath)
      .map(i => i.filepath)
    onConfirm(paths)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-[680px] max-h-[80vh] flex flex-col rounded-xl border border-[#252533] bg-[#0f0f18] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#252533] shrink-0">
          <div className="flex items-center gap-2">
            <Library size={15} className="text-[#c9a84c]" />
            <span className="text-sm font-['Playfair_Display']">Importa da Media Library</span>
          </div>
          <button onClick={onClose} className="text-[#555568] hover:text-[#e8e4dd]">
            <X size={14} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[#252533] shrink-0">
          <div className="flex items-center gap-2 bg-[#16161f] border border-[#252533] rounded px-2 py-1.5">
            <Search size={12} className="text-[#555568] shrink-0" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Cerca per nome o progetto…"
              className="flex-1 bg-transparent text-[11px] text-[#e8e4dd] placeholder-[#555568] outline-none"
            />
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-[#c9a84c]" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center text-[11px] font-mono text-[#555568] py-12">
              {search ? 'Nessun risultato.' : 'Nessuna immagine nella Media Library.'}
            </p>
          ) : (
            <div className="grid grid-cols-5 gap-2">
              {filtered.map(item => {
                const sel = selected.has(item.id)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggle(item.id)}
                    className={clsx(
                      'relative aspect-square rounded-lg overflow-hidden border-2 transition-all',
                      sel
                        ? 'border-[#c9a84c] shadow-[0_0_0_1px_#c9a84c40]'
                        : 'border-[#252533] hover:border-[#32324a]',
                    )}
                    title={item.filename}
                  >
                    <img
                      src={mediaThumbUrl(item.id)}
                      alt={item.filename}
                      className="w-full h-full object-cover bg-[#16161f]"
                      onError={e => { e.target.src = mediaFileUrl(item.id) }}
                    />
                    {sel && (
                      <div className="absolute inset-0 bg-[#c9a84c]/20 flex items-center justify-center">
                        <div className="w-5 h-5 rounded-full bg-[#c9a84c] flex items-center justify-center">
                          <Check size={11} className="text-black" />
                        </div>
                      </div>
                    )}
                    <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/60 truncate">
                      <p className="text-[7px] font-mono text-[#9090a8] truncate">{item.project_title || item.filename}</p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-[#252533] shrink-0">
          <span className="text-[10px] font-mono text-[#555568]">
            {selected.size > 0 ? `${selected.size} selezionat${selected.size === 1 ? 'a' : 'e'}` : 'Clicca per selezionare'}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[11px] font-mono rounded border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#32324a] transition-colors"
            >
              Annulla
            </button>
            <button
              onClick={handleConfirm}
              disabled={selected.size === 0}
              className="px-3 py-1.5 text-[11px] font-mono rounded bg-[#c9a84c] text-black font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#e6c46a] transition-colors"
            >
              Importa {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ReferenceDropZone({ refs, onAddPaths, onRemove, onPick, onPickFromLibrary, uploadError }) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono text-[#9090a8] uppercase tracking-wider">
          Immagini di riferimento ({refs.length}/{MAX_REFS})
        </span>
        <div className="flex gap-2">
          <GhostBtn onClick={onPickFromLibrary} title="Importa da Media Library">
            <Library size={12} /> Libreria
          </GhostBtn>
          <GhostBtn onClick={onPick}>
            <ImagePlus size={12} /> Sfoglia
          </GhostBtn>
        </div>
      </div>
      {uploadError && (
        <p className="mb-2 text-[10px] font-mono text-[#ef4444]">{uploadError}</p>
      )}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const files = [...e.dataTransfer.files]
          if (files.length) onAddPaths(files)
        }}
        onClick={() => refs.length < MAX_REFS && inputRef.current?.click()}
        className={clsx(
          'rounded-lg border-2 border-dashed transition-colors cursor-pointer',
          dragOver ? 'border-[#c9a84c] bg-[#c9a84c]/10' : 'border-[#32324a] hover:border-[#c9a84c]/40',
          refs.length >= MAX_REFS && 'opacity-50 pointer-events-none',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files || [])]
            if (files.length) onAddPaths(files)
            e.target.value = ''
          }}
        />
        {refs.length === 0 ? (
          <div className="py-10 px-4 text-center">
            <ImagePlus size={28} className="mx-auto mb-2 text-[#555568]" />
            <p className="text-xs font-mono text-[#9090a8]">
              Trascina qui le immagini oppure clicca per selezionare
            </p>
            <p className="text-[9px] font-mono text-[#555568] mt-1">PNG, JPG, WebP — max {MAX_REFS}</p>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 p-3">
            {refs.map(r => (
              <div key={r.path} className="relative aspect-square rounded-lg overflow-hidden border border-[#252533] bg-[#0f0f18]">
                {r.preview ? (
                  <img src={r.preview} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[#555568]">
                    <ImageIcon size={20} />
                  </div>
                )}
                <button
                  type="button"
                  onClick={(ev) => { ev.stopPropagation(); onRemove(r.path) }}
                  className="absolute top-1 right-1 p-0.5 rounded bg-black/60 text-[#e8e4dd]"
                >
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
            {refs.length < MAX_REFS && (
              <div className="aspect-square rounded-lg border border-dashed border-[#32324a] flex items-center justify-center text-[#555568]">
                <ImagePlus size={18} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Director narrative card (shown in storyboard header + generating view) ──

function DirectorNarrativeCard({ narrative }) {
  if (!narrative) return null
  return (
    <div className="rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5 p-3 space-y-2">
      <div className="flex items-center gap-2 mb-1">
        <Clapperboard size={13} className="text-[#c9a84c] shrink-0" />
        <span className="text-[9px] font-mono uppercase tracking-wider text-[#c9a84c]">Storia del regista</span>
      </div>
      {narrative.logline && (
        <p className="text-[11px] text-[#e8e4dd] italic leading-relaxed">"{narrative.logline}"</p>
      )}
      {narrative.narrative_arc && (
        <p className="text-[10px] text-[#9090a8] leading-relaxed">{narrative.narrative_arc}</p>
      )}
      <div className="flex flex-wrap gap-3 pt-1">
        {narrative.mood && (
          <div>
            <span className="text-[8px] font-mono text-[#555568] uppercase">Mood </span>
            <span className="text-[9px] font-mono text-[#c9a84c]">{narrative.mood}</span>
          </div>
        )}
        {narrative.visual_theme && (
          <div>
            <span className="text-[8px] font-mono text-[#555568] uppercase">Tema </span>
            <span className="text-[9px] font-mono text-[#9090a8]">{narrative.visual_theme}</span>
          </div>
        )}
      </div>
      {narrative.visual_motifs?.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {narrative.visual_motifs.map((m, i) => (
            <span key={i} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#16161f] border border-[#252533] text-[#9090a8]">{m}</span>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Info panel helpers ───────────────────────────────────────────────────────

function Section({ label, children }) {
  return (
    <div>
      <p className="text-[8px] font-mono uppercase tracking-wider text-[#555568] mb-1">{label}</p>
      {children}
    </div>
  )
}

const ENERGY_COLORS = { low: '#3b82f6', medium: '#c9a84c', high: '#f59e0b', peak: '#ef4444' }

function EnergyDot({ energy }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full"
      style={{ background: ENERGY_COLORS[energy] || '#555568' }}
      title={energy}
    />
  )
}

function ClipPromptCard({ clip, index }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded bg-[#0f0f18] border border-[#252533] overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-2 py-1.5 text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[9px] font-mono text-[#c9a84c] shrink-0">#{String(index + 1).padStart(2, '0')}</span>
          <span className="text-[9px] font-mono text-[#555568] truncate">{clip.clip_id}</span>
        </div>
        <ChevronRight size={10} className={clsx('text-[#555568] transition-transform shrink-0', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-2 border-t border-[#252533]">
          {clip.scene_prompt && (
            <div className="pt-2">
              <p className="text-[8px] font-mono text-[#555568] uppercase mb-0.5">Scena</p>
              <p className="text-[10px] text-[#e8e4dd] leading-relaxed">{clip.scene_prompt}</p>
            </div>
          )}
          {clip.first_frame_prompt && (
            <div>
              <p className="text-[8px] font-mono text-[#555568] uppercase mb-0.5">Frame immagine (txt2img)</p>
              <p className="text-[10px] text-[#9090a8] leading-relaxed font-mono">{clip.first_frame_prompt}</p>
            </div>
          )}
          {clip.motion_prompt && (
            <div>
              <p className="text-[8px] font-mono text-[#555568] uppercase mb-0.5">Motion prompt (img2video)</p>
              <p className="text-[10px] text-[#c9a84c]/80 leading-relaxed font-mono">{clip.motion_prompt}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function CreateReelScreen() {
  const { id: routeProjectId } = useParams()
  const catalogProjectId = routeProjectId ?? 'reel_standalone'

  const [view, setView] = useState('list')
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const [selectedJob, setSelectedJob] = useState(null)
  const [description, setDescription] = useState('')
  const [title, setTitle] = useState('')
  const [refs, setRefs] = useState([])
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [activeJobId, setActiveJobId] = useState(null)
  const [storageProjectId, setStorageProjectId] = useState(null)
  const [clips, setClips] = useState([])
  const [logs, setLogs] = useState([])
  const [globalPct, setGlobalPct] = useState(0)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [visionSummary, setVisionSummary] = useState('')
  const [visionData, setVisionData] = useState(null)
  const [directorData, setDirectorData] = useState(null)
  const [dopPlans, setDopPlans] = useState([])
  const [infoTab, setInfoTab] = useState('vision')
  const [directorNarrative, setDirectorNarrative] = useState(null)
  const [phaseStatus, setPhaseStatus] = useState({})
  const [projectDir, setProjectDir] = useState(null)
  const [refUploadError, setRefUploadError] = useState(null)
  const [showMediaPicker, setShowMediaPicker] = useState(false)
  const cancelRef = useRef(false)
  const pendingClipsRef = useRef([])

  const mediaProjectId = resolveReelMediaProjectId(storageProjectId, activeJobId, catalogProjectId)

  const addLog = useCallback((msg) => {
    setLogs(prev => [...prev.slice(-80), { t: Date.now(), msg }])
  }, [])

  const loadPreview = useCallback(async (path) => {
    const r = await window.studio?.reel?.readImageLocal?.(path)
    if (r?.ok) {
      setRefs(prev => prev.map(x => x.path === path ? { ...x, preview: r.dataUrl } : x))
    }
  }, [])

  const addRefsFromPaths = useCallback(async (pathsOrFiles) => {
    setRefUploadError(null)
    const resolved = await resolveImagePaths(pathsOrFiles, catalogProjectId)
    if (!resolved.length) {
      setRefUploadError(
        'Impossibile leggere le immagini. Usa «Sfoglia» o trascina file dal disco (non solo dal browser).',
      )
      return
    }
    let stablePaths = resolved
    try {
      const staged = await window.studio?.reel?.copyReferenceFiles?.(resolved, catalogProjectId)
      if (staged?.paths?.length) stablePaths = staged.paths
    } catch {
      stablePaths = resolved
    }
    setRefs(prev => {
      const seen = new Set(prev.map(x => x.path))
      const added = stablePaths
        .filter(p => !seen.has(p))
        .map(p => ({ path: p, preview: null }))
      if (!added.length) return prev
      const next = [...prev, ...added].slice(0, MAX_REFS)
      added.forEach(r => { loadPreview(r.path) })
      return next
    })
  }, [loadPreview, catalogProjectId])

  const handlePickImages = async () => {
    const paths = await window.studio?.reel?.pickImages?.()
    if (paths?.length) await addRefsFromPaths(paths)
  }

  const buildParams = (phase, resumeJobId = null) => ({
    project_id: catalogProjectId,
    description: description.trim(),
    title: title.trim() || 'CreateReel',
    reference_image_paths: refs.map(r => r.path),
    duration_sec: config.duration_sec,
    style: config.style,
    aspect_ratio: config.aspect_ratio,
    width: config.width,
    height: config.height,
    storyboard_max_side: config.storyboard_max_side,
    storyboard_steps: config.storyboard_steps,
    max_clip_sec: config.max_clip_sec,
    concurrent_jobs: config.concurrent_jobs,
    clip_backend: config.clip_backend,
    allow_ffmpeg_fallback: config.allow_ffmpeg_fallback,
    txt2img_workflow: config.txt2img_workflow,
    img2video_workflow: config.img2video_workflow,
    phase,
    resume_job_id: resumeJobId,
  })

  const handleProgress = useCallback((data) => {
    if (data.error) {
      setError(data.error)
      addLog(`Errore: ${data.error}`)
      return
    }
    if (data.pct != null) setGlobalPct(Math.round(data.pct * 100))
    if (data.job_id) setActiveJobId(data.job_id)
    if (data.storage_project_id) setStorageProjectId(data.storage_project_id)
    if (data.project_dir) setProjectDir(data.project_dir)
    if (data.event === 'vision_analysis_done') {
      setVisionSummary(data.combined_style || '')
      setVisionData(data)
      setPhaseStatus(s => ({ ...s, vision_analysis: 'done' }))
      setInfoTab('vision')
      addLog(`Vision: ${data.image_count} immagini — ${(data.combined_style || '').slice(0, 80)}`)
    }
    if (data.event === 'reel_plan_ready') {
      setDirectorData(data)
      if (data.narrative_arc || data.logline) {
        setDirectorNarrative({
          logline:       data.logline || '',
          mood:          data.mood || '',
          visual_theme:  data.visual_theme || '',
          narrative_arc: data.narrative_arc || '',
          visual_motifs: data.visual_motifs || [],
        })
      }
      setPhaseStatus(s => ({ ...s, reel_director: 'done' }))
      setInfoTab('director')
      addLog(`Regia: ${data.slots} slot — ${data.logline || ''}`)
    }
    if (data.event === 'dop_plan_ready') {
      setDopPlans(data.plans || [])
    }
    if (data.event === 'awaiting_storyboard_approval') {
      if (data.director_narrative) setDirectorNarrative(data.director_narrative)
    }
    if (data.event === 'clip_prompt_ready' || data.event === 'clip_queued') {
      const promptEntry = {
        clip_id: data.clip_id,
        slot_id: data.slot_id ?? data.slot,
        scene_prompt: data.scene_prompt,
        first_frame_prompt: data.first_frame_prompt,
        motion_prompt: data.motion_prompt,
      }
      if (data.event === 'clip_prompt_ready') pendingClipsRef.current.push(promptEntry)
      setClips(prev => {
        const exists = prev.some(c => c.clip_id === data.clip_id)
        const entry = { ...promptEntry, status: 'waiting', frame_url: null }
        if (exists) {
          return prev.map(c => c.clip_id === data.clip_id ? { ...c, ...entry, status: 'waiting' } : c)
        }
        return [...prev, entry]
      })
    }

    if (data.event === 'prompts_ready') {
      setPhaseStatus(s => ({ ...s, prompt_generator: 'done' }))
      setInfoTab('prompts')
      addLog(`Prompt pronti: ${data.clip_count ?? 0} clip`)
      const payloads = Array.isArray(data.clips) ? data.clips : pendingClipsRef.current
      setClips(prev => {
        const byId = new Map(prev.map(c => [c.clip_id, c]))
        for (const p of payloads) {
          if (!p?.clip_id) continue
          const existing = byId.get(p.clip_id) ?? { clip_id: p.clip_id, status: 'waiting' }
          byId.set(p.clip_id, {
            ...existing,
            slot_id: p.slot ?? p.slot_id ?? existing.slot_id,
            scene_prompt: p.scene_prompt,
            first_frame_prompt: p.first_frame_prompt,
            motion_prompt: p.motion_prompt,
          })
        }
        return [...byId.values()]
      })
      pendingClipsRef.current = []
    }

    if (data.event === 'storyboard_frame') {
      const sbOk = data.storyboard_ok !== false && !data.storyboard_placeholder
      const framePayload = sbOk ? {
        storyboard_url: data.url,
        storyboard_path: data.path,
        storyboard_filename: data.storyboard_filename,
        preview_url: data.preview_url,
        storyboard_clip_url: data.storyboard_clip_url,
      } : {}
      const sbUrl = sbOk ? clipReelStoryboardPreviewUrl(
        { clip_id: data.clip_id, ...framePayload },
        mediaProjectId,
      ) : null
      setClips(prev => {
        const sbName = data.storyboard_filename || `${data.clip_id}_sb.png`
        const entry = {
          clip_id: data.clip_id,
          slot_id: data.slot_id ?? data.slot,
          status: sbOk ? 'storyboard' : 'storyboard_failed',
          storyboard_ok: sbOk,
          storyboard_placeholder: !sbOk,
          ...framePayload,
          storyboard_filename: sbOk ? sbName : undefined,
          frame_url: sbUrl,
        }
        const exists = prev.some(c => c.clip_id === data.clip_id)
        return exists
          ? prev.map(c => c.clip_id === data.clip_id ? { ...c, ...entry } : c)
          : [...prev, entry]
      })
      if (sbOk) addLog(`Storyboard ${data.clip_id}`)
    }

    if (data.event === 'frame_done' || data.event === 'frames_ready') {
      const frameUrl = resolveBackendUrl(data.frame_url)
        || reelFrameClipUrl(mediaProjectId, data.clip_id)
        || resolveBackendUrl(data.url)
      if (frameUrl) {
        setClips(prev => prev.map(c =>
          c.clip_id === data.clip_id
            ? {
                ...c,
                frame_url: frameUrl,
                first_frame_path: data.path || data.first_path || c.first_frame_path,
                hd_frame_ready: !data.placeholder,
                status: data.placeholder ? c.status : 'generating',
              }
            : c,
        ))
      }
    }

    if (data.event === 'clip_comfyui_progress' && data.clip_id) {
      const clipPct = data.comfyui_max > 1
        ? Math.round((data.comfyui_value / data.comfyui_max) * 100)
        : 0
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id ? { ...c, comfyuiPct: clipPct, status: 'generating' } : c,
      ))
    }
    if (data.event === 'awaiting_storyboard_approval') {
      setPhaseStatus(s => ({ ...s, storyboard: 'done' }))
      if (data.storyboard?.length) {
        setClips(data.storyboard.map(f => {
          const sbOk = f.storyboard_ok !== false && !f.storyboard_placeholder
          const row = {
            ...f,
            clip_id: f.clip_id,
            status: sbOk ? 'storyboard' : 'storyboard_failed',
            storyboard_ok: sbOk,
            storyboard_url: f.url,
            storyboard_path: f.path,
            storyboard_filename: f.storyboard_filename || `${f.clip_id}_sb.png`,
          }
          return { ...row, frame_url: clipReelStoryboardPreviewUrl(row, mediaProjectId) }
        }))
      }
      if (data.vision_summary) setVisionSummary(data.vision_summary)
      setView('storyboard')
      setListRefreshKey(k => k + 1)
      addLog('Storyboard pronto — in attesa di approvazione')
    }
    if (data.event === 'clip_done') {
      const clipUrl = resolveBackendUrl(data.url) || data.url
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id ? { ...c, status: 'done', clip_url: clipUrl } : c,
      ))
    }
    if (data.event === 'assembly_done' || data.done || data.video_path) {
      setResult(data)
      setView('done')
      setListRefreshKey(k => k + 1)
      addLog('Reel completato')
    }
    if (data.msg) addLog(data.msg)
    if (data.event) {
      setPhaseStatus(s => ({ ...s, [data.phase || data.event]: 'active' }))
    }
  }, [addLog, mediaProjectId])

  const runPipeline = async (phase, resumeId = null) => {
    setError(null)
    cancelRef.current = false
    if (phase === 'full' || phase === 'storyboard') {
      setView('generating')
      if (phase === 'full') {
        setClips([])
        pendingClipsRef.current = []
      }
      setPhaseStatus({})
      if (phase !== 'storyboard') setGlobalPct(0)
    }
    await window.studio?.reel?.generate?.(buildParams(phase, resumeId || activeJobId), handleProgress)
  }

  const handleGenerate = () => {
    if (!description.trim() || description.length < 20) {
      setError('Inserisci una descrizione di almeno 20 caratteri')
      return
    }
    runPipeline('full')
  }

  const handleApprove = () => {
    setView('generating')
    setPhaseStatus(s => ({ ...s, production: 'active' }))
    runPipeline('production', activeJobId)
  }
  const handleRegenerateStoryboard = () => {
    setView('generating')
    runPipeline('storyboard', activeJobId)
  }

  function handleGoList() {
    setActiveJobId(null)
    setStorageProjectId(null)
    setSelectedJob(null)
    setListRefreshKey(k => k + 1)
    setView('list')
  }

  function handleNew() {
    setDescription('')
    setTitle('')
    setRefs([])
    setError(null)
    setActiveJobId(null)
    setView('setup')
  }

  function handleViewDetail(job) {
    if (job.status === 'running') {
      setActiveJobId(job.job_id)
      setStorageProjectId(job.storage_project_id || null)
      setDescription(job.description || '')
      setTitle(job.title || '')
      setConfig({ ...DEFAULT_CONFIG, ...job.config })
      setVisionSummary(job.result?.vision?.combined_style || '')
      if (job.result?.director_narrative) setDirectorNarrative(job.result.director_narrative)
      const pid = job.storage_project_id || catalogProjectId
      const storyboardClips = (job.result?.storyboard ?? []).map(f => ({
        clip_id: f.clip_id,
        slot_id: f.slot_id,
        status: f.storyboard_ok === false ? 'storyboard_failed' : 'generating',
        storyboard_ok: f.storyboard_ok !== false,
        storyboard_path: f.path,
        storyboard_filename: f.storyboard_filename,
        frame_url: clipReelStoryboardPreviewUrl(f, pid),
        scene_prompt: f.scene_prompt,
      }))
      if (storyboardClips.length) setClips(storyboardClips)
      setGlobalPct(job.progress_pct ?? 0)
      setView('generating')
      return
    }
    setSelectedJob(job)
    setView('detail')
  }

  function handleRestartJob(job) {
    if (job.status === 'awaiting_storyboard') {
      setActiveJobId(job.job_id)
      setStorageProjectId(job.storage_project_id || null)
      setDescription(job.description || '')
      setTitle(job.title || '')
      setConfig({ ...DEFAULT_CONFIG, ...job.config })
      setVisionSummary(job.result?.vision?.combined_style || '')
      if (job.result?.director_narrative) setDirectorNarrative(job.result.director_narrative)
      const pid = job.storage_project_id || catalogProjectId
      setClips((job.result?.storyboard ?? []).map(f => ({
        clip_id: f.clip_id,
        slot_id: f.slot_id,
        status: f.storyboard_ok === false ? 'storyboard_failed' : 'storyboard',
        storyboard_ok: f.storyboard_ok !== false,
        storyboard_path: f.path,
        storyboard_filename: f.storyboard_filename,
        frame_url: clipReelStoryboardPreviewUrl(f, pid),
        scene_prompt: f.scene_prompt,
      })))
      setView('storyboard')
      return
    }
    setDescription(job.description || '')
    setTitle(job.title || '')
    setConfig({ ...DEFAULT_CONFIG, ...job.config })
    if (['failed', 'interrupted'].includes(job.status)) {
      setActiveJobId(job.job_id)
      setStorageProjectId(job.storage_project_id || null)
    }
    setView('setup')
  }

  if (view === 'list') {
    return (
      <div className="flex flex-col h-full">
        <JobsListView
          projectId={catalogProjectId}
          refreshKey={listRefreshKey}
          onNew={handleNew}
          onViewDetail={handleViewDetail}
        />
      </div>
    )
  }

  if (view === 'detail' && selectedJob) {
    return (
      <div className="flex flex-col h-full">
        <JobDetailView
          job={selectedJob}
          projectId={catalogProjectId}
          onBack={() => setView('list')}
          onRestart={handleRestartJob}
          onDelete={handleGoList}
        />
      </div>
    )
  }

  if (view === 'storyboard') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="px-6 py-4 border-b border-[#252533] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <LayoutGrid className="text-[#c9a84c]" size={18} />
            <h1 className="font-['Playfair_Display'] text-lg">CreateReel — Revisione storyboard</h1>
          </div>
          <div className="flex gap-2">
            <GhostBtn onClick={handleGoList}>
              <X size={12} /> Lista
            </GhostBtn>
            <GhostBtn onClick={handleRegenerateStoryboard}>
              <RefreshCw size={12} /> Rigenera storyboard
            </GhostBtn>
            <GoldBtn onClick={handleApprove}>
              <Check size={14} /> Approva e genera HD + Video
            </GoldBtn>
          </div>
        </header>
        <div className="px-6 py-2 border-b border-[#252533]/50 shrink-0 space-y-2">
          <ProjectDirBanner
            storageProjectId={storageProjectId}
            jobId={activeJobId}
            projectDir={projectDir}
            storageApi="reel"
          />
          {visionSummary && (
            <p className="text-[10px] font-mono text-[#9090a8]">Vision: {visionSummary}</p>
          )}
          <DirectorNarrativeCard narrative={directorNarrative} />
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <ClipPreviewGrid
            clips={clips}
            projectId={mediaProjectId}
            jobId={activeJobId}
            aspectRatio={config.aspect_ratio}
          />
        </div>
      </div>
    )
  }

  if (view === 'generating' || view === 'done') {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-[#252533] shrink-0">
          <div className="flex items-center gap-3 mb-3">
            <Clapperboard className="text-[#c9a84c]" size={20} />
            <h1 className="font-['Playfair_Display'] text-lg">
              {view === 'done' ? 'Reel completato' : 'Generazione in corso…'}
            </h1>
            {view === 'generating' && <Loader2 size={16} className="animate-spin text-[#c9a84c]" />}
            <span className="text-[10px] font-mono text-[#c9a84c] ml-auto">{globalPct}%</span>
          </div>
          <div className="h-1.5 bg-[#16161f] rounded-full">
            <div className="h-full bg-[#c9a84c] rounded-full transition-all" style={{ width: `${globalPct}%` }} />
          </div>
          {(storageProjectId || projectDir) && (
            <div className="mt-3">
              <ProjectDirBanner
                storageProjectId={storageProjectId}
                jobId={activeJobId}
                projectDir={projectDir}
                storageApi="reel"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            {PHASES.map(p => (
              <span
                key={p.id}
                className={clsx(
                  'text-[9px] font-mono px-2 py-0.5 rounded',
                  phaseStatus[p.id] === 'done' ? 'bg-[#22c55e]/20 text-[#22c55e]'
                    : phaseStatus[p.id] === 'active' ? 'bg-[#c9a84c]/20 text-[#c9a84c]'
                      : 'bg-[#16161f] text-[#555568]',
                )}
              >
                {p.label}
              </span>
            ))}
          </div>
          {directorNarrative && (
            <div className="mt-3">
              <DirectorNarrativeCard narrative={directorNarrative} />
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mt-3 p-3 rounded border border-[#ef4444]/40 text-[#ef4444] text-xs font-mono shrink-0">
            {error}
          </div>
        )}

        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="flex-1 flex flex-col min-w-0 border-r border-[#252533] p-4 overflow-hidden">
            <p className="text-[9px] font-mono text-[#9090a8] uppercase mb-2 shrink-0">Anteprime clip</p>
            <div className="flex-1 overflow-y-auto pr-1">
              <ClipPreviewGrid
                clips={clips}
                projectId={mediaProjectId}
                jobId={activeJobId}
                aspectRatio={config.aspect_ratio}
              />
            </div>
          </div>
          <div className="w-80 shrink-0 flex flex-col overflow-hidden border-l border-[#252533]">
            {view === 'done' && (result?.filename || result?.video_path) && (
              <div className="p-3 border-b border-[#252533] shrink-0">
                <video
                  src={
                    result.video_url?.replace('/api/trailer/', '/api/reel/')
                    || `http://127.0.0.1:8765/api/reel/output/${encodeURIComponent(mediaProjectId)}/${encodeURIComponent(result.filename || String(result.video_path).split(/[/\\]/).pop())}`
                  }
                  controls
                  className="w-full rounded border border-[#252533]"
                />
              </div>
            )}

            {/* Tab bar */}
            <div className="flex border-b border-[#252533] shrink-0">
              {[
                { id: 'vision',   label: 'Vision',  dot: !!visionData },
                { id: 'director', label: 'Regia',   dot: !!directorData },
                { id: 'prompts',  label: 'Prompt',  dot: clips.length > 0 },
                { id: 'log',      label: 'Log',     dot: false },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setInfoTab(tab.id)}
                  className={clsx(
                    'flex-1 py-2 text-[9px] font-mono uppercase tracking-wide transition-colors relative',
                    infoTab === tab.id
                      ? 'text-[#c9a84c] border-b-2 border-[#c9a84c]'
                      : 'text-[#555568] hover:text-[#9090a8]',
                  )}
                >
                  {tab.label}
                  {tab.dot && infoTab !== tab.id && (
                    <span className="absolute top-1.5 right-1.5 w-1 h-1 rounded-full bg-[#c9a84c]" />
                  )}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">

              {/* ── Vision ── */}
              {infoTab === 'vision' && (
                visionData ? (
                  <div className="space-y-3">
                    <Section label="Stile visivo">
                      <p className="text-[10px] text-[#e8e4dd] leading-relaxed">{visionData.combined_style || '—'}</p>
                    </Section>
                    {visionData.palette_hex?.length > 0 && (
                      <Section label="Palette colori">
                        <div className="flex flex-wrap gap-1.5">
                          {visionData.palette_hex.map((hex, i) => (
                            <div key={i} className="flex items-center gap-1">
                              <div className="w-4 h-4 rounded" style={{ background: hex }} />
                              <span className="text-[9px] font-mono text-[#9090a8]">{hex}</span>
                            </div>
                          ))}
                        </div>
                      </Section>
                    )}
                    {visionData.character_anchors?.length > 0 && (
                      <Section label={`Personaggi (${visionData.character_anchors.length})`}>
                        <ul className="space-y-1">
                          {visionData.character_anchors.map((a, i) => (
                            <li key={i} className="text-[10px] text-[#9090a8] leading-relaxed">• {typeof a === 'string' ? a : JSON.stringify(a)}</li>
                          ))}
                        </ul>
                      </Section>
                    )}
                    {visionData.environment_anchors?.length > 0 && (
                      <Section label="Ambiente">
                        <ul className="space-y-1">
                          {visionData.environment_anchors.map((a, i) => (
                            <li key={i} className="text-[10px] text-[#9090a8] leading-relaxed">• {typeof a === 'string' ? a : JSON.stringify(a)}</li>
                          ))}
                        </ul>
                      </Section>
                    )}
                    {visionData.wardrobe_notes && (
                      <Section label="Wardrobe / costume">
                        <p className="text-[10px] text-[#9090a8] leading-relaxed">{visionData.wardrobe_notes}</p>
                      </Section>
                    )}
                    {visionData.continuity_rules?.length > 0 && (
                      <Section label="Regole continuità">
                        <ul className="space-y-1">
                          {visionData.continuity_rules.map((r, i) => (
                            <li key={i} className="text-[10px] text-[#9090a8] leading-relaxed">• {typeof r === 'string' ? r : JSON.stringify(r)}</li>
                          ))}
                        </ul>
                      </Section>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] font-mono text-[#555568] italic">In attesa dell'analisi vision…</p>
                )
              )}

              {/* ── Regia ── */}
              {infoTab === 'director' && (
                directorData ? (
                  <div className="space-y-3">
                    <DirectorNarrativeCard narrative={directorNarrative} />
                    {directorData.slot_details?.length > 0 && (
                      <Section label={`Slot (${directorData.slot_details.length})`}>
                        <div className="space-y-2">
                          {directorData.slot_details.map((s, i) => (
                            <div key={i} className="rounded bg-[#0f0f18] border border-[#252533] p-2">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[9px] font-mono text-[#c9a84c]">{s.slot_id}</span>
                                <div className="flex items-center gap-1.5">
                                  <EnergyDot energy={s.energy} />
                                  <span className="text-[9px] font-mono text-[#555568]">{s.duration_sec}s</span>
                                </div>
                              </div>
                              <p className="text-[9px] font-mono text-[#9090a8] mb-0.5">{s.emotion}</p>
                              <p className="text-[10px] text-[#e8e4dd] leading-relaxed">{s.visual_hint}</p>
                            </div>
                          ))}
                        </div>
                      </Section>
                    )}
                    {dopPlans.length > 0 && (
                      <Section label={`Cinematographer (${dopPlans.length} piani)`}>
                        <div className="space-y-2">
                          {dopPlans.map((p, i) => (
                            <div key={i} className="rounded bg-[#0f0f18] border border-[#252533] p-2">
                              <span className="text-[9px] font-mono text-[#c9a84c]">{p.slot_id || `piano ${i+1}`}</span>
                              {p.shot_type && <p className="text-[9px] font-mono text-[#555568] mt-0.5">{p.shot_type} · {p.camera_movement}</p>}
                              {p.visual_description && <p className="text-[10px] text-[#9090a8] mt-1 leading-relaxed">{p.visual_description}</p>}
                            </div>
                          ))}
                        </div>
                      </Section>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] font-mono text-[#555568] italic">In attesa della regia…</p>
                )
              )}

              {/* ── Prompt ── */}
              {infoTab === 'prompts' && (
                clips.length > 0 ? (
                  <div className="space-y-2">
                    {clips.map((c, i) => (
                      <ClipPromptCard key={c.clip_id || i} clip={c} index={i} />
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] font-mono text-[#555568] italic">In attesa dei prompt…</p>
                )
              )}

              {/* ── Log ── */}
              {infoTab === 'log' && (
                <div className="font-mono text-[10px] text-[#9090a8] space-y-0.5">
                  {logs.length === 0
                    ? <p className="italic text-[#555568]">Nessun log ancora.</p>
                    : logs.map((l, i) => <div key={i}>{l.msg}</div>)
                  }
                </div>
              )}
            </div>

            {view === 'done' && (
              <div className="flex flex-col gap-2 p-3 border-t border-[#252533] shrink-0">
                <GhostBtn onClick={handleGoList}>Torna alla lista</GhostBtn>
                <GoldBtn onClick={handleNew}>Nuovo reel</GoldBtn>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Film className="text-[#c9a84c]" size={24} />
          <div>
            <h1 className="font-['Playfair_Display'] text-2xl text-[#e8e4dd]">Nuovo reel</h1>
            <p className="text-[11px] font-mono text-[#9090a8]">
              Vision LLM → storyboard LD → approvazione → HD + video
            </p>
          </div>
        </div>
        <GhostBtn onClick={handleGoList}>
          <ChevronRight size={12} className="rotate-180" />
          Lista
        </GhostBtn>
      </div>

      <label className="block mb-4">
        <span className="text-[10px] font-mono text-[#9090a8] uppercase tracking-wider">Titolo (opzionale)</span>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-3 py-2 text-sm text-[#e8e4dd]"
          placeholder="Il mio reel"
        />
      </label>

      <label className="block mb-4">
        <span className="text-[10px] font-mono text-[#9090a8] uppercase tracking-wider">
          Descrizione del video *
        </span>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={6}
          className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-3 py-2 text-sm text-[#e8e4dd] resize-y"
          placeholder="Descrivi la storia, i personaggi, l'atmosfera, il ritmo e cosa deve succedere in ogni momento…"
        />
      </label>

      <ReferenceDropZone
        refs={refs}
        onAddPaths={addRefsFromPaths}
        onRemove={(path) => setRefs(prev => prev.filter(x => x.path !== path))}
        onPick={handlePickImages}
        onPickFromLibrary={() => setShowMediaPicker(true)}
        uploadError={refUploadError}
      />

      {showMediaPicker && (
        <MediaLibraryPicker
          onConfirm={async (paths) => {
            setShowMediaPicker(false)
            if (paths.length) await addRefsFromPaths(paths)
          }}
          onClose={() => setShowMediaPicker(false)}
        />
      )}

      <div className="grid grid-cols-2 gap-4 mb-6">
        <label>
          <span className="text-[10px] font-mono text-[#9090a8]">Durata (sec)</span>
          <input
            type="number"
            min={8}
            max={180}
            value={config.duration_sec}
            onChange={e => setConfig(c => ({ ...c, duration_sec: Number(e.target.value) }))}
            className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label>
          <span className="text-[10px] font-mono text-[#9090a8]">Aspect ratio</span>
          <select
            value={config.aspect_ratio}
            onChange={e => setConfig(c => ({ ...c, aspect_ratio: e.target.value }))}
            className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-sm"
          >
            {['9:16', '16:9', '1:1', '4:3'].map(ar => (
              <option key={ar} value={ar}>{ar}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[10px] font-mono text-[#9090a8]">Storyboard max side</span>
          <input
            type="number"
            min={96}
            max={768}
            value={config.storyboard_max_side}
            onChange={e => setConfig(c => ({ ...c, storyboard_max_side: Number(e.target.value) }))}
            className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-sm"
          />
        </label>
        <label>
          <span className="text-[10px] font-mono text-[#9090a8]">Storyboard steps</span>
          <input
            type="number"
            min={4}
            max={40}
            value={config.storyboard_steps}
            onChange={e => setConfig(c => ({ ...c, storyboard_steps: Number(e.target.value) }))}
            className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="block mb-6">
        <span className="text-[10px] font-mono text-[#9090a8]">Stile visivo</span>
        <input
          value={config.style}
          onChange={e => setConfig(c => ({ ...c, style: e.target.value }))}
          className="mt-1 w-full bg-[#16161f] border border-[#252533] rounded px-3 py-2 text-sm"
        />
      </label>

      {error && (
        <p className="mb-4 text-xs text-[#ef4444] font-mono">{error}</p>
      )}

      <GoldBtn onClick={handleGenerate} disabled={!description.trim()}>
        <Sparkles size={14} />
        Genera storyboard
      </GoldBtn>

      <p className="mt-4 text-[9px] font-mono text-[#555568] leading-relaxed">
        Fase 1: analisi vision delle immagini. Fase 2–3: regia e prompt allineati ai riferimenti.
        Fase 4: anteprime ComfyUI a bassa risoluzione — dovrai approvare prima di HD e clip LTX.
        Configura il ruolo LLM <strong>vision_analyst</strong> in Servizi (es. gpt-4o o claude-sonnet).
      </p>
    </div>
  )
}
