/**
 * TrailerScreen — Trailer Generator
 * Standalone screen for AI-driven cinematic trailer generation.
 * Three views: setup → generating → done
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { useJobQueryDeepLink } from '../hooks/useJobQueryDeepLink'
import {
  Music2, Upload, Play, Pause, Loader2, CheckCircle, AlertCircle,
  Film, Wand2, X, ChevronDown, Clock, Zap,
  Image as ImageIcon, Sparkles, Video, RefreshCw, Tv, ChevronRight,
  LayoutGrid, Check, FolderOpen, Copy, Settings2, Cpu,
} from 'lucide-react'
import clsx from 'clsx'
import ProjectDirBanner from '../components/ProjectDirBanner'
import GenQueueBadge from '../components/GenQueueBadge'
import {
  BACKEND_ORIGIN,
  resolveBackendUrl,
  clipFramePreviewUrl,
  clipStoryboardPreviewUrl,
  resolveTrailerMediaProjectId,
  trailerFrameClipUrl,
} from '../utils/mediaUrl'
import { buildTrailerEnhanceContext } from '../utils/obsidianEnhanceContext'
import { ReelPromptEditorModal } from '../components/ReelClipCards'
import { clipNeedsMediaRecovery, mergeClipRecoveryEvent } from '../utils/clipMediaRecovery'
import { useMediaReconcile } from '../hooks/useMediaReconcile'

// ── Constants ────────────────────────────────────────────────────────────────

const ASPECT_RATIO_OPTIONS = ['16:9', '9:16', '1:1', '4:3', '21:9']

const RESOLUTION_MAP = {
  '16:9': [{ label: 'HD 1280×720', w: 1280, h: 720 }, { label: 'FHD 1920×1080', w: 1920, h: 1080 }],
  '9:16': [{ label: 'HD 720×1280', w: 720, h: 1280 }, { label: 'FHD 1080×1920', w: 1080, h: 1920 }],
  '1:1':  [{ label: '1024×1024', w: 1024, h: 1024 }, { label: '1280×1280', w: 1280, h: 1280 }],
  '4:3':  [{ label: '1024×768', w: 1024, h: 768 }, { label: '1280×960', w: 1280, h: 960 }],
  '21:9': [{ label: '2560×1080', w: 2560, h: 1080 }, { label: '1344×576', w: 1344, h: 576 }],
}

const FPS_OPTIONS = [24, 25, 30, 60]

/** Lato lungo massimo per le immagini storyboard (txt2img anteprima). */
const STORYBOARD_SIZE_OPTS = [
  { maxSide: 256, label: '256px', hint: 'Veloce' },
  { maxSide: 320, label: '320px', hint: 'Default' },
  { maxSide: 384, label: '384px', hint: 'Medio' },
  { maxSide: 512, label: '512px', hint: 'Dettaglio' },
  { maxSide: 640, label: '640px', hint: 'Alta anteprima' },
]

/** Step di sampling ComfyUI per lo storyboard. */
const STORYBOARD_STEPS_OPTS = [
  { steps: 6, label: 'Bassa', hint: '6 step — rapido' },
  { steps: 10, label: 'Media', hint: '10 step — bilanciato' },
  { steps: 15, label: 'Alta', hint: '15 step — qualità' },
  { steps: 20, label: 'Ultra', hint: '20 step — massima' },
]

function storyboardPixelSize(config) {
  const maxSide = config.storyboard_max_side ?? 320
  const w = config.width ?? 1080
  const h = config.height ?? 1920
  const scale = maxSide / Math.max(w, h, 1)
  return {
    w: Math.max(96, Math.round(w * scale)),
    h: Math.max(96, Math.round(h * scale)),
  }
}

const PHASE_LABELS = {
  audio_analysis:    { label: 'Analisi Audio',    icon: Music2 },
  director_llm:      { label: 'Director LLM',     icon: Film },
  edl_validator:     { label: 'Validazione EDL',  icon: CheckCircle },
  audio_compositor:  { label: 'Mix Audio',        icon: Zap },
  prompt_gen:        { label: 'Prompt AI',        icon: Sparkles },
  storyboard:        { label: 'Storyboard',       icon: LayoutGrid },
  comfyui:           { label: 'ComfyUI Gen',      icon: ImageIcon },
  assembly:          { label: 'Assemblaggio',     icon: Video },
}

const INITIAL_PHASES = Object.keys(PHASE_LABELS).map(k => ({
  key: k, status: 'waiting', msg: '',
}))

const SECTION_COLORS = {
  chorus:  '#c9a84c',
  verse:   '#3b82f6',
  hook:    '#22c55e',
  drop:    '#ef4444',
  bridge:  '#a855f7',
  intro:   '#555568',
  outro:   '#555568',
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

function formatDuration(sec) {
  if (!sec) return '0s'
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── Shared UI primitives ─────────────────────────────────────────────────────

function GoldBtn({ children, onClick, disabled, className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-2 px-4 py-2 rounded text-xs font-mono font-semibold transition-opacity disabled:opacity-40',
        className,
      )}
      style={{ background: 'var(--gold)', color: '#07070d' }}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, onClick, disabled, className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-2 px-3 py-1.5 rounded border border-[#252533] text-[11px] font-mono text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#32324a] transition-colors disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2">
      {children}
    </div>
  )
}

function Card({ children, className = '' }) {
  return (
    <div className={clsx('rounded-xl border border-[#252533] bg-[#16161f] p-5', className)}>
      {children}
    </div>
  )
}

// ── Phase status icon ────────────────────────────────────────────────────────

function PhaseIcon({ status, IconComponent }) {
  if (status === 'done') {
    return <CheckCircle size={14} className="text-[#22c55e] shrink-0" />
  }
  if (status === 'error') {
    return <AlertCircle size={14} className="text-[#ef4444] shrink-0" />
  }
  if (status === 'running') {
    return <Loader2 size={14} className="text-[#c9a84c] animate-spin shrink-0" />
  }
  return <IconComponent size={14} className="text-[#555568] shrink-0" />
}

// ── Status helpers ───────────────────────────────────────────────────────────

const JOB_STATUS_META = {
  done:                 { label: 'Completato',  color: '#22c55e', bg: '#22c55e18' },
  running:              { label: 'In corso',    color: '#c9a84c', bg: '#c9a84c18' },
  awaiting_storyboard:  { label: 'Storyboard',  color: '#3b82f6', bg: '#3b82f618' },
  interrupted:          { label: 'Interrotto', color: '#f59e0b', bg: '#f59e0b18' },
  failed:               { label: 'Fallito',     color: '#ef4444', bg: '#ef444418' },
  cancelled:            { label: 'Annullato',  color: '#555568', bg: '#55556818' },
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
  if (m < 1)  return 'adesso'
  if (m < 60) return `${m} min fa`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h fa`
  return `${Math.floor(h / 24)}g fa`
}

// ── Jobs List View ────────────────────────────────────────────────────────────

function JobsListView({ projectId, refreshKey, onNew, onViewDetail }) {
  const [jobs, setJobs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [deletingId, setDeletingId] = useState(null)

  async function fetchJobs() {
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/trailer/jobs?project_id=${encodeURIComponent(projectId)}`)
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { fetchJobs() }, [projectId, refreshKey])

  async function handleDelete(e, job) {
    e.stopPropagation()
    setDeletingId(job.job_id)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/trailer/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=true`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        console.error('Delete job failed', res.status, body.detail ?? body)
        return
      }
      setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
    } catch (err) {
      console.error('Delete job failed', err)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <Tv size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">Trailer Generator</h1>
          {!loading && jobs.length > 0 && (
            <span className="text-[10px] font-mono text-[#555568]">{jobs.length} lavori</span>
          )}
        </div>
        <GoldBtn onClick={onNew}>
          <Sparkles size={14} />
          Nuova Generazione
        </GoldBtn>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-full gap-2 text-[#555568]">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-sm font-mono">Caricamento...</span>
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4">
            <div className="w-16 h-16 rounded-full bg-[#1e1e2a] flex items-center justify-center">
              <Tv size={28} className="text-[#252533]" />
            </div>
            <p className="text-sm font-mono text-[#555568]">Nessun trailer generato</p>
            <GoldBtn onClick={onNew}>
              <Sparkles size={14} />
              Genera il primo trailer
            </GoldBtn>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
            {jobs.map(job => {
              const meta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.failed
              const hasVideo = job.status === 'done' && job.result?.video_url
              return (
                <div
                  key={job.job_id}
                  onClick={() => onViewDetail(job)}
                  className="rounded-xl border border-[#252533] bg-[#16161f] p-4 cursor-pointer hover:border-[#32324a] hover:bg-[#1e1e2a] transition-colors group"
                >
                  {/* Thumb / placeholder */}
                  <div
                    className="rounded-lg mb-3 overflow-hidden flex items-center justify-center"
                    style={{ aspectRatio: '16/9', background: '#0f0f18', border: '1px solid #252533' }}
                  >
                    {hasVideo ? (
                      <video
                        src={`${BACKEND_ORIGIN}${job.result.video_url}`}
                        className="w-full h-full object-cover"
                        muted
                        onMouseEnter={e => e.target.play()}
                        onMouseLeave={e => { e.target.pause(); e.target.currentTime = 0 }}
                      />
                    ) : (
                      <Film size={24} style={{ color: meta.color, opacity: 0.4 }} />
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <p className="text-[11px] font-mono text-[#e8e4dd] truncate flex-1 min-w-0">
                      {job.audio_name}
                    </p>
                    <StatusBadge status={job.status} small />
                  </div>

                  <p className="text-[9px] font-mono text-[#555568] mb-2">{timeAgo(job.created_at)}</p>

                  {/* Config chips */}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {[
                      job.config?.aspect_ratio,
                      `${job.config?.width}×${job.config?.height}`,
                      `${job.config?.duration_sec}s`,
                      job.result?.clip_count != null ? `${job.result.clip_count} clip` : null,
                      job.result?.duration_sec != null ? formatDuration(job.result.duration_sec) : null,
                    ].filter(Boolean).map(v => (
                      <span key={v} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#555568]">{v}</span>
                    ))}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1.5">
                    <button
                      onClick={e => { e.stopPropagation(); onViewDetail(job) }}
                      className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-[9px] font-mono border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#32324a] transition-colors"
                    >
                      <ChevronRight size={10} />
                      Dettagli
                    </button>
                    <button
                      onClick={e => handleDelete(e, job)}
                      disabled={deletingId === job.job_id}
                      className="flex items-center justify-center gap-1 px-2 py-1.5 rounded text-[9px] font-mono border border-[#252533] text-[#555568] hover:text-[#ef4444] hover:border-[#ef4444]/40 transition-colors disabled:opacity-40"
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

// ── Job Detail View ───────────────────────────────────────────────────────────

function JobDetailView({ job, projectId, onBack, onRestart, onDelete }) {
  const [deleting, setDeleting] = useState(false)
  const videoUrl = job.result?.video_url ? `${BACKEND_ORIGIN}${job.result.video_url}` : null

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/trailer/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=true`,
        { method: 'DELETE' },
      )
      if (res.ok) onDelete()
      else console.error('Delete job failed', res.status, await res.text().catch(() => ''))
    } catch (err) {
      console.error('Delete job failed', err)
    } finally {
      setDeleting(false)
    }
  }

  const storageId = job.storage_project_id || job.project_id
  const rows = [
    { label: 'Stato',      value: <StatusBadge status={job.status} /> },
    { label: 'Job ID',     value: <code className="text-[#c9a84c]">{job.job_id}</code> },
    {
      label: 'Cartella progetto',
      value: (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[#c9a84c] hover:text-[#e6c46a]"
          title="Clicca per copiare"
          onClick={async () => {
            try { await navigator.clipboard.writeText(storageId) } catch { /* ignore */ }
          }}
        >
          <code>{storageId}</code>
          <Copy size={10} />
        </button>
      ),
    },
    { label: 'Creato',     value: new Date(job.created_at).toLocaleString('it-IT') },
    { label: 'Audio',      value: job.audio_name },
    { label: 'Durata target', value: `${job.config?.duration_sec}s` },
    { label: 'Formato',    value: `${job.config?.aspect_ratio} · ${job.config?.width}×${job.config?.height}` },
    { label: 'FPS',        value: job.config?.fps },
    { label: 'Stile',      value: job.config?.style },
    ...(job.result ? [
      { label: 'Durata finale', value: formatDuration(job.result.duration_sec), accent: true },
      { label: 'Clip',     value: job.result.clip_count, accent: true },
      { label: 'Dimensione', value: job.result.size_bytes ? formatBytes(job.result.size_bytes) : '—', accent: true },
    ] : []),
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-[10px] font-mono text-[#9090a8] hover:text-[#e8e4dd] transition-colors"
          >
            <ChevronRight size={12} className="rotate-180" />
            Lista
          </button>
          <span className="text-[#252533]">/</span>
          <Tv size={16} className="text-[#c9a84c]" />
          <p className="text-sm font-mono text-[#e8e4dd] truncate max-w-xs">{job.audio_name}</p>
          <StatusBadge status={job.status} small />
        </div>
        <div className="flex gap-2">
          <GoldBtn onClick={() => onRestart(job)}>
            {job.status === 'awaiting_storyboard' ? <Check size={13} /> : <RefreshCw size={13} />}
            {job.status === 'awaiting_storyboard' ? 'Approvazione storyboard' : 'Riavvia'}
          </GoldBtn>
          <GhostBtn onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Elimina
          </GhostBtn>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-2 gap-5">
          {/* Left — video + audio */}
          <div className="space-y-3">
            {job.audio_path && (
              <AudioPlayerCard
                filePath={job.audio_path}
                label="Traccia Sorgente"
                displayName={job.audio_name}
              />
            )}
            {job.result?.trailer_audio_path && (
              <AudioPlayerCard
                filePath={job.result.trailer_audio_path}
                label="Trailer Audio"
                highlight
              />
            )}
            <Card className="p-0 overflow-hidden">
              {videoUrl ? (
                <video
                  src={videoUrl}
                  controls
                  autoPlay
                  className="w-full rounded-xl"
                  style={{ maxHeight: '55vh', background: '#07070d' }}
                />
              ) : job.status === 'failed' ? (
                <div className="flex flex-col items-center gap-3 p-8">
                  <AlertCircle size={28} className="text-[#ef4444]" />
                  <p className="text-[10px] font-mono text-[#9090a8] text-center">{job.error ?? 'Errore sconosciuto'}</p>
                </div>
              ) : (
                <div className="flex items-center justify-center py-16">
                  <Film size={28} className="text-[#252533]" />
                </div>
              )}
            </Card>

            {videoUrl && (
              <div className="flex gap-2">
                <GhostBtn onClick={() => window.studio?.shell?.openPath?.(job.result.video_path)} className="flex-1 justify-center">
                  <Film size={12} />
                  Apri file
                </GhostBtn>
                <GhostBtn
                  onClick={() => { const a = document.createElement('a'); a.href = videoUrl; a.download = job.result.filename ?? 'trailer.mp4'; a.click() }}
                  className="flex-1 justify-center"
                >
                  <Upload size={12} />
                  Scarica
                </GhostBtn>
              </div>
            )}
          </div>

          {/* Right — metadata */}
          <Card>
            <SectionLabel>Dettagli</SectionLabel>
            <div className="space-y-2.5">
              {rows.map(({ label, value, accent }) => value != null && (
                <div key={label} className="flex items-start gap-3">
                  <span className="text-[9px] font-mono text-[#555568] w-28 shrink-0 pt-0.5">{label}</span>
                  <span className={clsx(
                    'text-[10px] font-mono break-all',
                    accent ? 'text-[#c9a84c]' : 'text-[#e8e4dd]'
                  )}>
                    {typeof value === 'object' ? value : String(value)}
                  </span>
                </div>
              ))}
            </div>

            {job.config?.style && (
              <div className="mt-4 pt-3 border-t border-[#252533]">
                <SectionLabel>Stile visivo</SectionLabel>
                <p className="text-[10px] font-mono text-[#9090a8] leading-relaxed">{job.config.style}</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

// ── Audio Player Card ─────────────────────────────────────────────────────────
// Generic single-source player. Pass a filePath to load; it reloads automatically
// when the path changes. highlight=true renders a gold accent border.

/** Stream audio dal backend (evita file:// e base64 pesante via IPC). */
function trailerAudioStreamUrl(filePath) {
  if (!filePath) return null
  return `${BACKEND_ORIGIN}/api/trailer/source?path=${encodeURIComponent(filePath)}`
}

function AudioPlayerCard({ filePath, label, displayName, analysisData, highlight = false }) {
  const audioRef = useRef(null)
  const streamUrl = trailerAudioStreamUrl(filePath)
  const [ready, setReady]               = useState(false)
  const [playing, setPlaying]           = useState(false)
  const [currentTime, setCurrentTime]   = useState(0)
  const [duration, setDuration]         = useState(0)
  const [loadError, setLoadError]       = useState(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    setLoadError(null)
    setReady(false)
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    if (!streamUrl) {
      el.removeAttribute('src')
      el.load()
      return
    }
    el.src = streamUrl
    el.volume = 1
    el.load()
  }, [streamUrl])

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0

  function toggle() {
    if (!audioRef.current || !ready) return
    if (playing) {
      audioRef.current.pause()
      setPlaying(false)
    } else {
      audioRef.current.play()
        .then(() => setPlaying(true))
        .catch(e => console.error('[AudioPlayer] play() rejected:', e?.message))
    }
  }

  function handleSeek(e) {
    if (!audioRef.current) return
    const rect  = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = ratio * (audioRef.current.duration || 0)
  }

  const BAR_HEIGHTS = [3, 5, 7, 4, 8, 6, 4, 7, 5, 3, 6, 4, 7, 5, 6]
  const accentColor = highlight ? '#c9a84c' : '#3b82f6'

  return (
    <div
      className="rounded-lg p-3 shrink-0"
      style={{
        background:   highlight ? '#c9a84c0a' : '#0f0f18',
        border:       `1px solid ${highlight ? '#c9a84c44' : '#252533'}`,
      }}
    >
      {/* src and load() are managed imperatively via useEffect — no key/src props */}
      <audio
        ref={audioRef}
        preload="metadata"
        crossOrigin="anonymous"
        onCanPlay={() => setReady(true)}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          setDuration(audioRef.current?.duration ?? 0)
          setReady(true)
        }}
        onEnded={() => { setPlaying(false); setCurrentTime(0) }}
        onError={() => {
          const code = audioRef.current?.error?.code
          const msg = code === 4 ? 'Formato non supportato' : (loadError || 'Impossibile caricare l\'audio')
          setLoadError(msg)
          setReady(false)
          setPlaying(false)
          console.error('[AudioPlayer]', label, filePath, audioRef.current?.error)
        }}
      />

      {/* Label row */}
      <div className="flex items-center justify-between mb-2">
        <span
          className="text-[8px] font-mono uppercase tracking-wider font-semibold"
          style={{ color: accentColor }}
        >
          {label}
        </span>
        {!ready && !loadError && streamUrl && (
          <Loader2 size={9} className="animate-spin" style={{ color: accentColor }} />
        )}
        {loadError && (
          <span className="text-[8px] font-mono text-[#ef4444]" title={loadError}>errore</span>
        )}
      </div>

      {/* Waveform bars + filename */}
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex items-end gap-[2px] shrink-0">
          {BAR_HEIGHTS.map((h, i) => (
            <div
              key={i}
              className="w-[2px] rounded-full"
              style={{
                height: `${playing ? h * 2.2 : h * 1.4}px`,
                background: playing ? accentColor : '#32324a',
                transition: 'height 0.15s ease',
              }}
            />
          ))}
        </div>
        <p className="text-[10px] font-mono text-[#9090a8] truncate flex-1 min-w-0">
          {displayName ?? filePath?.split(/[\\/]/).pop() ?? '—'}
        </p>
      </div>

      {/* Seek bar */}
      <div
        className="h-[3px] rounded-full bg-[#1e1e2a] mb-2.5 cursor-pointer overflow-hidden"
        onClick={handleSeek}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${accentColor}, ${accentColor}cc)`,
            transition: 'width 0.2s linear',
          }}
        />
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-mono text-[#555568] w-8 tabular-nums">
          {formatTime(currentTime)}
        </span>

        <button
          onClick={toggle}
          disabled={!ready}
          className="flex items-center justify-center rounded-full transition-all disabled:opacity-30 shrink-0"
          style={{
            width: 24, height: 24,
            background: playing ? accentColor : '#1e1e2a',
            border: playing ? 'none' : '1px solid #252533',
          }}
        >
          {playing
            ? <Pause size={8} style={{ color: '#07070d' }} />
            : <Play  size={8} style={{ color: ready ? '#9090a8' : '#555568', marginLeft: 1 }} />}
        </button>

        <span className="text-[9px] font-mono text-[#555568] w-8 text-right tabular-nums">
          {formatTime(duration)}
        </span>

        {analysisData && (
          <div className="flex gap-2 ml-auto">
            {[
              { lbl: 'BPM', val: Math.round(analysisData.bpm) },
              { lbl: 'Sez', val: analysisData.sections },
            ].map(({ lbl, val }) => (
              <div key={lbl} className="text-center">
                <p className="text-[7px] font-mono text-[#555568]">{lbl}</p>
                <p className="text-[9px] font-mono" style={{ color: accentColor }}>{val}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step Result Cards ─────────────────────────────────────────────────────────

const ENERGY_COLORS = { low: '#555568', medium: '#3b82f6', high: '#f59e0b', peak: '#ef4444' }
const SECTION_TYPE_COLORS = { chorus: '#c9a84c', verse: '#3b82f6', hook: '#22c55e', drop: '#ef4444', bridge: '#a855f7', intro: '#555568', outro: '#555568' }

function StepResultCard({ result }) {
  const [open, setOpen] = useState(true)

  const phaseLabel = {
    audio_analysis:   'Analisi Audio',
    director_llm:     'Director LLM',
    edl_validator:    'Validazione EDL',
    audio_compositor: 'Mix Audio',
    cinematographer:  'Direttore Fotografia',
    prompt_gen:       'Prompt Generati',
  }[result.phase] ?? result.phase

  return (
    <div className="rounded-lg border border-[#252533] bg-[#0f0f18] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-[#16161f] transition-colors"
      >
        <CheckCircle size={11} className="text-[#22c55e] shrink-0" />
        <span className="text-[10px] font-mono text-[#e8e4dd] flex-1 text-left">{phaseLabel}</span>
        <ChevronRight
          size={11}
          className="text-[#555568] transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1">
          {result.phase === 'audio_analysis' && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: 'BPM',     value: Math.round(result.data.bpm) },
                  { label: 'Sezioni', value: result.data.sections },
                  { label: 'Durata',  value: formatDuration(result.data.duration_sec) },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded bg-[#16161f] p-2 text-center">
                    <p className="text-[8px] font-mono text-[#555568] mb-0.5">{label}</p>
                    <p className="text-[11px] font-mono text-[#c9a84c]">{value}</p>
                  </div>
                ))}
              </div>
              {result.data.energyBreakdown && (
                <div className="flex gap-1.5 flex-wrap mt-1">
                  {Object.entries(result.data.energyBreakdown).map(([energy, count]) => (
                    <span
                      key={energy}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded"
                      style={{ background: ENERGY_COLORS[energy] + '22', color: ENERGY_COLORS[energy] }}
                    >
                      {energy} ×{count}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {result.phase === 'edl_validator' && (
            <div className="space-y-1.5">
              {result.data.fallback && (
                <div className="flex items-center gap-1.5 text-[9px] font-mono text-[#f59e0b] mb-2">
                  <AlertCircle size={10} />
                  Fallback greedy applicato
                </div>
              )}
              {(result.data.slots ?? []).map(slot => (
                <div key={slot.slot_id} className="flex items-center gap-2 py-1 border-b border-[#1e1e2a] last:border-0">
                  <span className="text-[8px] font-mono text-[#555568] w-14 shrink-0">{slot.slot_id}</span>
                  <span
                    className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: (SECTION_TYPE_COLORS[slot.section_type] ?? '#555568') + '22', color: SECTION_TYPE_COLORS[slot.section_type] ?? '#555568' }}
                  >
                    {slot.section_type}
                  </span>
                  <span
                    className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0"
                    style={{ background: (ENERGY_COLORS[slot.energy] ?? '#555568') + '22', color: ENERGY_COLORS[slot.energy] ?? '#555568' }}
                  >
                    {slot.energy}
                  </span>
                  <span className="text-[8px] font-mono text-[#9090a8] ml-auto shrink-0">{formatDuration(slot.duration_sec)}</span>
                  <span className="text-[9px] font-mono text-[#555568] truncate min-w-0">{slot.visual_hint}</span>
                </div>
              ))}
            </div>
          )}

          {result.phase === 'cinematographer' && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
              {(result.data.plans ?? []).map((plan, i) => (
                <div key={plan.slot_id ?? i} className="rounded bg-[#16161f] p-2">
                  <p className="text-[8px] font-mono text-[#c9a84c] mb-1">{plan.slot_id}</p>
                  <p className="text-[9px] font-mono text-[#9090a8]">
                    {[plan.shot_type, plan.lens_mm ? `${plan.lens_mm}mm` : null, plan.camera_movement]
                      .filter(Boolean).join(' · ')}
                  </p>
                  {plan.scene_description && (
                    <p className="text-[9px] font-mono text-[#555568] mt-1 line-clamp-3">
                      {plan.scene_description}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {result.phase === 'prompt_gen' && (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {(result.data.clips ?? []).length === 0 ? (
                <p className="text-[9px] font-mono text-[#555568]">In attesa prompt…</p>
              ) : (result.data.clips ?? []).map((clip, i) => (
                <div key={clip.clip_id ?? i} className="rounded bg-[#16161f] p-2 space-y-1.5">
                  <p className="text-[8px] font-mono text-[#c9a84c]">{clip.clip_id}</p>
                  {[
                    { label: 'Scene',      value: clip.scene_prompt },
                    { label: 'Frame 1',    value: clip.first_frame_prompt },
                    { label: 'Frame Last', value: clip.last_frame_prompt },
                    { label: 'Motion',     value: clip.motion_prompt, accent: true },
                  ].map(({ label, value, accent }) => value ? (
                    <div key={label}>
                      <span className="text-[7px] font-mono text-[#555568] uppercase tracking-wider block mb-0.5">{label}</span>
                      <p className={clsx('text-[9px] font-mono leading-snug whitespace-pre-wrap break-words', accent ? 'text-[#c9a84c]' : 'text-[#9090a8]')}>
                        {value}
                      </p>
                    </div>
                  ) : null)}
                </div>
              ))}
            </div>
          )}

          {result.phase === 'audio_compositor' && (
            <p className="text-[9px] font-mono text-[#22c55e]">
              Audio tagliato e concatenato — {formatDuration(result.data.duration_sec)}
            </p>
          )}

          {result.phase === 'director_llm' && (
            <p className="text-[9px] font-mono text-[#9090a8]">
              EDL generato da LLM — {result.data.attempts} tentativo/i
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Audio Drop Zone ──────────────────────────────────────────────────────────

function AudioDropZone({ audioFile, onPick, onDrop }) {
  const [dragging, setDragging] = useState(false)
  const zoneRef = useRef(null)

  function handleDragOver(e) {
    e.preventDefault()
    setDragging(true)
  }

  function handleDragLeave() {
    setDragging(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      const ext = file.name.split('.').pop().toLowerCase()
      if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'].includes(ext)) {
        onDrop({ path: file.path, name: file.name, size: file.size })
      }
    }
  }

  if (audioFile) {
    return (
      <div className="rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5 p-4 flex items-center gap-3">
        <div className="flex items-center gap-1.5 shrink-0">
          {[3, 5, 7, 4, 6, 5, 3].map((h, i) => (
            <div
              key={i}
              className="w-0.5 rounded-full bg-[#c9a84c] opacity-80"
              style={{ height: `${h * 3}px` }}
            />
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-[#e8e4dd] truncate">{audioFile.name}</p>
          <p className="text-[10px] text-[#9090a8] mt-0.5">{formatBytes(audioFile.size)}</p>
        </div>
        <button
          onClick={() => onDrop(null)}
          className="text-[#555568] hover:text-[#ef4444] transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      ref={zoneRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onPick}
      className={clsx(
        'rounded-lg border-2 border-dashed p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors',
        dragging
          ? 'border-[#c9a84c] bg-[#c9a84c]/10'
          : 'border-[#252533] hover:border-[#32324a] hover:bg-[#1e1e2a]/40',
      )}
    >
      <Music2 size={22} className="text-[#555568]" />
      <p className="text-xs font-mono text-[#9090a8]">Trascina un file audio o clicca per sfogliare</p>
      <p className="text-[10px] text-[#555568]">mp3, wav, m4a, flac, aac, ogg</p>
    </div>
  )
}

// ── Workflow Selector ────────────────────────────────────────────────────────

function WorkflowSelect({ value, onChange, workflows, placeholder }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full appearance-none rounded px-3 py-1.5 text-[11px] font-mono border border-[#252533] bg-[#1e1e2a] text-[#e8e4dd] pr-7 focus:outline-none focus:border-[#c9a84c]/50"
      >
        <option value="">{placeholder}</option>
        {workflows.map(w => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
      <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#555568] pointer-events-none" />
    </div>
  )
}

// ── Pipeline Info Box ────────────────────────────────────────────────────────

function PipelineInfoBox() {
  const stages = [
    { n: 1, label: 'Analisi Audio' },
    { n: 2, label: 'Director LLM' },
    { n: 3, label: 'Validazione EDL' },
    { n: 4, label: 'Mix Audio' },
    { n: 5, label: 'DP + Prompt AI' },
    { n: 6, label: 'Storyboard anteprima' },
    { n: 7, label: 'Approvazione' },
    { n: 8, label: 'ComfyUI HD + Video' },
    { n: 9, label: 'Assemblaggio FFmpeg' },
  ]
  return (
    <div className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3">
      <p className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2">Pipeline 7 Fasi</p>
      <div className="space-y-1">
        {stages.map(s => (
          <div key={s.n} className="flex items-center gap-2">
            <span className="w-4 h-4 rounded-full bg-[#1e1e2a] text-[#555568] text-[9px] font-mono flex items-center justify-center shrink-0">
              {s.n}
            </span>
            <span className="text-[10px] text-[#9090a8] font-mono">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Jobs Panel (compact, used inside SetupView right col) ────────────────────

function JobsPanel({ projectId, onRestart }) {
  const [jobs, setJobs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(null)

  async function fetchJobs() {
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/trailer/jobs?project_id=${encodeURIComponent(projectId)}`)
      const data = await res.json()
      setJobs(data.jobs ?? [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { fetchJobs() }, [projectId])

  async function handleDelete(job, withFiles) {
    setDeleting(job.job_id)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/trailer/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=${withFiles}`,
        { method: 'DELETE' },
      )
      if (res.ok) {
        setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
      } else {
        console.error('Delete job failed', res.status, await res.text().catch(() => ''))
      }
    } catch (err) {
      console.error('Delete job failed', err)
    } finally {
      setDeleting(null)
    }
  }

  if (loading) return null
  if (jobs.length === 0) return null

  return (
    <div className="mt-4">
      <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2 flex items-center gap-2">
        <Clock size={10} />
        Lavori Recenti
      </div>
      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        {jobs.map(job => {
          const meta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.failed
          const date = new Date(job.created_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
          const canRestart = !!job.audio_path
          return (
            <div
              key={job.job_id}
              className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3"
            >
              {/* Header row */}
              <div className="flex items-start gap-2 mb-2">
                <div
                  className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: meta.color }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-mono text-[#e8e4dd] truncate">{job.audio_name}</p>
                  <p className="text-[8px] font-mono text-[#555568] mt-0.5">{date} · {meta.label}</p>
                </div>
              </div>

              {/* Config chips */}
              <div className="flex flex-wrap gap-1 mb-2">
                {[
                  `${job.config.duration_sec}s`,
                  job.config.aspect_ratio,
                  `${job.config.width}×${job.config.height}`,
                ].map(v => (
                  <span key={v} className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#555568]">{v}</span>
                ))}
                {job.result?.clip_count != null && (
                  <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#555568]">
                    {job.result.clip_count} clip
                  </span>
                )}
                {job.result?.duration_sec != null && (
                  <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#22c55e]/10 text-[#22c55e]">
                    {formatDuration(job.result.duration_sec)}
                  </span>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-1.5">
                {canRestart && (
                  <button
                    onClick={() => onRestart(job)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono transition-colors"
                    style={{ background: 'var(--gold-dim)', color: 'var(--gold)' }}
                  >
                    <RefreshCw size={9} />
                    Riavvia
                  </button>
                )}
                {job.result?.video_url && (
                  <button
                    onClick={() => window.studio?.shell?.openPath?.(job.result.video_path)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd] transition-colors"
                  >
                    <Film size={9} />
                    Apri
                  </button>
                )}
                <button
                  onClick={() => handleDelete(job, true)}
                  disabled={deleting === job.job_id}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono border border-[#252533] text-[#555568] hover:text-[#ef4444] hover:border-[#ef4444]/40 transition-colors ml-auto disabled:opacity-40"
                >
                  {deleting === job.job_id ? <Loader2 size={9} className="animate-spin" /> : <X size={9} />}
                  Elimina
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Storyboard thumbnail (non in Media Library — solo path progetto) ─────────

function StoryboardThumb({ clip, projectId, jobId, className = 'w-full h-full object-cover pointer-events-none' }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    setFailed(false)

    async function load() {
      const mediaIds = [
        projectId,
        jobId && `trailer_${jobId}`,
        'trailer_standalone',
      ].filter(Boolean)
      const seen = new Set()
      const urls = []
      for (const pid of mediaIds) {
        if (seen.has(pid)) continue
        seen.add(pid)
        const sb = clipStoryboardPreviewUrl(clip, pid)
        const frame = clipFramePreviewUrl(clip, pid)
        if (sb) urls.push(sb)
        if (frame && frame !== sb) urls.push(frame)
      }

      const localPath = clip?.storyboard_path || clip?.first_frame_path
      if (localPath && window.studio?.trailer?.readImageLocal) {
        const r = await window.studio.trailer.readImageLocal(localPath)
        if (!cancelled && r?.ok && r.dataUrl) {
          setSrc(r.dataUrl)
          return
        }
      }

      if (window.studio?.trailer?.fetchImageUrl) {
        for (const httpUrl of urls) {
          const sep = httpUrl.includes('?') ? '&' : '?'
          const r = await window.studio.trailer.fetchImageUrl(`${httpUrl}${sep}v=${retry}`)
          if (!cancelled && r?.ok && r.dataUrl) {
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
    clip?.storyboard_filename,
    clip?.storyboard_url,
    clip?.storyboard_clip_url,
    clip?.preview_url,
    clip?.frame_url,
    clip?.first_frame_path,
    projectId,
    jobId,
    retry,
  ])

  // File su disco può arrivare dopo l'evento SSE — riprova ogni 2s
  useEffect(() => {
    if (src || failed || !clip?.clip_id) return undefined
    const iv = setInterval(() => setRetry(r => r + 1), 2000)
    return () => clearInterval(iv)
  }, [clip?.clip_id, src, failed])

  const isPlaceholder = clip?.storyboard_placeholder === true
    || clip?.storyboard_ok === false

  const loading = !src && !failed && !isPlaceholder && (
    clip?.status === 'generating'
    || clip?.status === 'storyboard'
    || clip?.status === 'waiting'
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

  if (isPlaceholder || (!src && clip?.storyboard_ok === false)) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-[#0f0f18] text-[#f59e0b] px-1">
        <AlertCircle size={14} />
        <span className="text-[7px] font-mono text-center leading-tight">ComfyUI fallito</span>
      </div>
    )
  }

  if (!src || failed) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-[#0f0f18] text-[#555568]">
        <ImageIcon size={14} />
        <span className="text-[7px] font-mono px-1 text-center">anteprima</span>
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={clip?.clip_id || 'storyboard'}
      className={className}
      onError={() => {
        if (retry < 3 && clip?.clip_id && projectId) {
          setRetry(r => r + 1)
          return
        }
        setFailed(true)
      }}
    />
  )
}

// ── Clip Grid ────────────────────────────────────────────────────────────────

function ClipGrid({ clips, aspectRatio, projectId, jobId, onEditPrompts }) {
  const isPortrait = aspectRatio === '9:16'
  const [expandedId, setExpandedId] = useState(null)

  return (
    <div className="space-y-3">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
        {clips.map(clip => {
          const hasPrompts = !!(clip.scene_prompt || clip.first_frame_prompt || clip.motion_prompt)
          const hasStoryboard = !!(clip.clip_id && (clip.storyboard_path || clip.storyboard_filename || clip.frame_url || clip.status === 'storyboard' || clip.status === 'generating'))
          return (
            <button
              key={clip.clip_id}
              type="button"
              onClick={() => hasPrompts && setExpandedId(id => id === clip.clip_id ? null : clip.clip_id)}
              className={clsx(
                'rounded-lg overflow-hidden border transition-colors relative text-left',
                clip.status === 'done'       && 'border-[#22c55e]/50',
                clip.status === 'generating' && 'border-[#c9a84c]/50 animate-pulse',
                clip.status === 'storyboard' && 'border-[#3b82f6]/40',
                clip.status === 'waiting'    && 'border-[#252533]',
                clip.status === 'error'      && 'border-[#ef4444]/50',
                expandedId === clip.clip_id && 'ring-1 ring-[#c9a84c]/60',
                hasPrompts && 'cursor-pointer',
              )}
              style={{ aspectRatio: isPortrait ? '9/16' : '16/9' }}
            >
              {clip.status === 'done' && clip.clip_url ? (
                <video
                  src={clip.clip_url}
                  className="w-full h-full object-cover pointer-events-none"
                  muted
                  playsInline
                  preload="metadata"
                />
              ) : hasStoryboard || clip.status === 'storyboard' || clip.status === 'generating' ? (
                <StoryboardThumb clip={clip} projectId={projectId} jobId={jobId} />
              ) : (
                <div className="w-full h-full bg-[#0f0f18] flex items-center justify-center">
                  {clip.status === 'waiting' && (
                    <Film size={14} className="text-[#252533]" />
                  )}
                  {clip.status === 'error' && (
                    <AlertCircle size={14} className="text-[#ef4444]" />
                  )}
                </div>
              )}

              {clip.status === 'done' && (
                <div className="absolute top-1 right-1 pointer-events-none">
                  <CheckCircle size={10} className="text-[#22c55e]" />
                </div>
              )}

              {hasPrompts && (
                <div className="absolute top-1 left-1 pointer-events-none">
                  <Sparkles size={9} className="text-[#c9a84c]" />
                </div>
              )}

              <div className="absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/60 pointer-events-none">
                <p className="text-[8px] font-mono text-[#9090a8] truncate">{clip.clip_id}</p>
              </div>
            </button>
          )
        })}
      </div>

      {expandedId && (() => {
        const clip = clips.find(c => c.clip_id === expandedId)
        if (!clip) return null
        return (
          <div className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3 space-y-2">
            <p className="text-[9px] font-mono text-[#c9a84c]">{clip.clip_id}</p>
            {[
              { label: 'Scene (txt2img)', value: clip.scene_prompt },
              { label: 'Primo frame', value: clip.first_frame_prompt },
              { label: 'Ultimo frame', value: clip.last_frame_prompt },
              { label: 'Motion (img2video)', value: clip.motion_prompt, accent: true },
            ].map(({ label, value, accent }) => value ? (
              <div key={label}>
                <p className="text-[7px] font-mono text-[#555568] uppercase tracking-wider mb-0.5">{label}</p>
                <p className={clsx('text-[9px] font-mono leading-snug whitespace-pre-wrap break-words', accent ? 'text-[#c9a84c]' : 'text-[#9090a8]')}>
                  {value}
                </p>
              </div>
            ) : null)}
            {onEditPrompts && (
              <button
                type="button"
                onClick={() => onEditPrompts(clip)}
                className="mt-2 flex items-center gap-1.5 text-[9px] font-mono text-[#c9a84c] hover:text-[#e6c46a]"
              >
                <Wand2 size={11} />
                Modifica e migliora prompt
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}

// ── EDL Timeline Bar ─────────────────────────────────────────────────────────

function EDLTimelineBar({ edl }) {
  const [tooltip, setTooltip] = useState(null)

  if (!edl?.slots?.length) return null

  const totalDur = edl.slots.reduce((sum, s) => sum + (s.duration_sec || 0), 0) || 1

  return (
    <div className="mt-4">
      <SectionLabel>EDL Timeline</SectionLabel>
      <div className="relative h-6 rounded-full overflow-hidden flex gap-px bg-[#0f0f18]">
        {edl.slots.map((slot, i) => {
          const pct = ((slot.duration_sec || 0) / totalDur) * 100
          const color = SECTION_COLORS[slot.section_type] ?? SECTION_COLORS.intro
          return (
            <div
              key={slot.slot_id ?? i}
              className="h-full cursor-pointer transition-opacity hover:opacity-80 relative"
              style={{ width: `${pct}%`, background: color, minWidth: 2 }}
              onMouseEnter={e => setTooltip({ slot, x: e.currentTarget.getBoundingClientRect().left })}
              onMouseLeave={() => setTooltip(null)}
            />
          )
        })}
      </div>

      {tooltip && (
        <div className="mt-1 rounded border border-[#252533] bg-[#16161f] px-3 py-2 text-[10px] font-mono text-[#9090a8]">
          <span className="text-[#e8e4dd]">{tooltip.slot.slot_id}</span>
          {' — '}
          {tooltip.slot.section_type}
          {' · '}
          {formatDuration(tooltip.slot.duration_sec)}
          {tooltip.slot.clip_count != null && ` · ${tooltip.slot.clip_count} clip`}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        {Object.entries(SECTION_COLORS).filter(([k]) => k !== 'intro' && k !== 'outro').map(([type, color]) => (
          <div key={type} className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full" style={{ background: color }} />
            <span className="text-[9px] font-mono text-[#555568] capitalize">{type}</span>
          </div>
        ))}
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-full" style={{ background: SECTION_COLORS.intro }} />
          <span className="text-[9px] font-mono text-[#555568]">intro/outro</span>
        </div>
      </div>
    </div>
  )
}


const LS_TR_OVERRIDES_KEY = (wfId) => `cinematic_model_overrides_${wfId}`

function loadWfOverrides(wfId) {
  if (!wfId) return null
  try { return JSON.parse(localStorage.getItem(LS_TR_OVERRIDES_KEY(wfId)) || 'null') }
  catch { return null }
}

function TrailerModelOverridesSection({ config, onChange }) {
  const [open, setOpen] = useState(false)
  const [nodeModels, setNodeModels] = useState(null)
  const [wfModelNodes, setWfModelNodes] = useState({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [overrides, setOverrides] = useState(() => ({
    txt2img: loadWfOverrides(config.txt2img_workflow) || {},
    video:   loadWfOverrides(config.img2video_workflow) || {},
  }))

  useEffect(() => {
    setOverrides({
      txt2img: loadWfOverrides(config.txt2img_workflow) || {},
      video:   loadWfOverrides(config.img2video_workflow) || {},
    })
  }, [config.txt2img_workflow, config.img2video_workflow])

  useEffect(() => {
    const merged = {}
    if (overrides.txt2img?.checkpoint)  merged.checkpoint  = overrides.txt2img.checkpoint
    if (overrides.video?.video_model)   merged.video_model = overrides.video.video_model
    const loras = overrides.video?.loras || overrides.txt2img?.loras || []
    if (loras.length > 0) merged.loras = loras
    onChange(Object.keys(merged).length > 0 ? merged : null)
  }, [overrides])

  async function fetchModels() {
    if (nodeModels) return
    setLoadingModels(true)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/comfyui/nodes/0/models`)
      const data = await res.json()
      setNodeModels(data)
      const wfIds = [config.txt2img_workflow, config.img2video_workflow].filter(Boolean)
      const results = {}
      await Promise.all(wfIds.map(async (id) => {
        try {
          const r = await fetch(`${BACKEND_ORIGIN}/api/comfyui/workflow/${id}/model-nodes`)
          results[id] = await r.json()
        } catch {}
      }))
      setWfModelNodes(results)
    } catch {}
    setLoadingModels(false)
  }

  function handleToggle() {
    if (!open) fetchModels()
    setOpen(o => !o)
  }

  const checkpoints = nodeModels?.checkpoints  || []
  const videoModels = nodeModels?.video_models || []
  const loras       = nodeModels?.loras        || []
  const t2iNodes = wfModelNodes[config.txt2img_workflow]
  const vidNodes = wfModelNodes[config.img2video_workflow]
  const cpNodes   = t2iNodes?.checkpoint_nodes  || []
  const vmNodes   = vidNodes?.video_model_nodes || []
  const loraNodes = vidNodes?.lora_nodes        || []
  const hasOverrides = !!(overrides.txt2img?.checkpoint || overrides.video?.video_model ||
    (overrides.video?.loras || []).some(l => l?.lora_name))

  return (
    <div className="mt-4 rounded border border-[#252533] overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-[#16161f] hover:bg-[#1e1e2a] transition-colors"
      >
        <Settings2 size={12} className="text-[#9090a8] shrink-0" />
        <span className="text-[10px] font-mono text-[#9090a8] flex-1 text-left">Modelli & LoRA</span>
        {hasOverrides && (
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#c9a84c]/10 border border-[#c9a84c]/30 text-[#c9a84c]">attivo</span>
        )}
        <ChevronDown size={12} className={"text-[#555568] transition-transform " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div className="border-t border-[#252533] bg-[#0f0f18] p-3 space-y-3">
          {loadingModels && (
            <div className="flex items-center gap-2 text-[#555568]">
              <Loader2 size={12} className="animate-spin" />
              <span className="text-[10px] font-mono">Caricamento...</span>
            </div>
          )}
          {!loadingModels && nodeModels && (
            <>
              {(cpNodes.length > 0 || checkpoints.length > 0) && (
                <div>
                  <p className="text-[9px] font-mono text-[#555568] mb-1">Checkpoint (txt2img)</p>
                  <select
                    value={overrides.txt2img?.checkpoint || ''}
                    onChange={e => setOverrides(o => ({ ...o, txt2img: { ...o.txt2img, checkpoint: e.target.value || undefined } }))}
                    className="w-full text-[10px] bg-[#16161f] text-[#e8e4dd] rounded px-2 py-1.5 border border-[#252533] font-mono"
                  >
                    <option value="">(dal workflow JSON)</option>
                    {checkpoints.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
              {(vmNodes.length > 0 || videoModels.length > 0) && (
                <div>
                  <p className="text-[9px] font-mono text-[#555568] mb-1">Video Model (img2video)</p>
                  <select
                    value={overrides.video?.video_model || ''}
                    onChange={e => setOverrides(o => ({ ...o, video: { ...o.video, video_model: e.target.value || undefined } }))}
                    className="w-full text-[10px] bg-[#16161f] text-[#e8e4dd] rounded px-2 py-1.5 border border-[#252533] font-mono"
                  >
                    <option value="">(dal workflow JSON)</option>
                    {videoModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              )}
              {loraNodes.map((loraNode, idx) => {
                const ov = (overrides.video?.loras || [])[idx] || {}
                const smVal = ov.strength_model ?? loraNode.strength_model ?? 1.0
                return (
                  <div key={loraNode.node_id}>
                    <p className="text-[9px] font-mono text-[#555568] mb-1">LoRA slot {idx + 1}</p>
                    <select
                      value={ov.lora_name || ''}
                      onChange={e => {
                        setOverrides(o => {
                          const ls = [...(o.video?.loras || [])]
                          if (!ls[idx]) ls[idx] = { lora_name: '', strength_model: 1.0, strength_clip: 1.0 }
                          ls[idx] = { ...ls[idx], lora_name: e.target.value }
                          return { ...o, video: { ...o.video, loras: ls } }
                        })
                      }}
                      className="w-full text-[10px] bg-[#16161f] text-[#e8e4dd] rounded px-2 py-1.5 border border-[#252533] font-mono mb-2"
                    >
                      <option value="">(dal workflow JSON)</option>
                      {loras.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-mono text-[#555568] w-16">strength</span>
                      <input
                        type="range" min={0} max={1.5} step={0.05}
                        value={parseFloat(smVal)}
                        onChange={e => {
                          setOverrides(o => {
                            const ls = [...(o.video?.loras || [])]
                            if (!ls[idx]) ls[idx] = { lora_name: '', strength_model: 1.0, strength_clip: 1.0 }
                            ls[idx] = { ...ls[idx], strength_model: parseFloat(e.target.value), strength_clip: parseFloat(e.target.value) }
                            return { ...o, video: { ...o.video, loras: ls } }
                          })
                        }}
                        className="flex-1 h-1.5 accent-[#c9a84c] cursor-pointer"
                      />
                      <span className="text-[9px] font-mono text-[#c9a84c] w-8 text-right">{parseFloat(smVal).toFixed(2)}</span>
                    </div>
                  </div>
                )
              })}
              {cpNodes.length === 0 && vmNodes.length === 0 && loraNodes.length === 0 && checkpoints.length === 0 && videoModels.length === 0 && (
                <p className="text-[10px] font-mono text-[#555568] italic text-center py-1">Nessun modello trovato. Verifica il nodo.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Setup View ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  duration_sec: 60, aspect_ratio: '9:16', width: 1080, height: 1920,
  fps: 30, style: 'cinematic, dramatic lighting, music video',
  concurrent_jobs: 1, max_clip_sec: 9.5,
  txt2img_workflow: 'z_image_turbo_txt2img',
  img2video_workflow: 'ltx_img2video',
  clip_backend: 'auto',
  allow_ffmpeg_fallback: true,
  storyboard_max_side: 320,
  storyboard_steps: 10,
}

function SetupView({ onGenerate, projectId, onBack, initialAudioFile, initialConfig }) {
  const [modelOverrides, setModelOverrides] = useState(null)
  const [audioFile, setAudioFile] = useState(initialAudioFile ?? null)
  const [lyrics, setLyrics] = useState('')
  const [workflows, setWorkflows] = useState({ txt2img: [], img2video: [] })
  const [config, setConfig] = useState(initialConfig ? { ...DEFAULT_CONFIG, ...initialConfig } : DEFAULT_CONFIG)

  function handleRestartJob(job) {
    const canResume = ['failed', 'interrupted'].includes(job.status)
    const shortAudio = job.result?.duration_sec != null
      && job.config?.duration_sec != null
      && job.result.duration_sec < job.config.duration_sec * 0.92
    setConfig({
      ...DEFAULT_CONFIG,
      ...job.config,
      clip_backend: 'auto',
      allow_ffmpeg_fallback: true,
      ...(canResume && !shortAudio
        ? { resume_job_id: job.job_id, phase: 'production' }
        : {}),
    })
    setAudioFile({ path: job.audio_path, name: job.audio_name, size: null })
  }

  // Load workflow list on mount
  useEffect(() => {
    window.studio?.workflow?.list?.()
      .then(res => {
        const all = res?.workflows ?? res ?? []
        const txt2imgTypes = ['txt2img']
        const videoTypes = ['img2video', 'img2video_lastframe', 'img_audio2video']
        setWorkflows({
          txt2img: all.filter(w => txt2imgTypes.includes(w.type)),
          img2video: all.filter(w => videoTypes.includes(w.type)),
        })
        setConfig(c => ({
          ...c,
          txt2img_workflow: c.txt2img_workflow || 'z_image_txt2img',
          img2video_workflow: c.img2video_workflow || 'ltx_img_audio2video',
          clip_backend: c.clip_backend || 'auto',
        }))
      })
      .catch(() => {})
  }, [])

  function handleSetResolution(ar) {
    const resolutions = RESOLUTION_MAP[ar] ?? []
    const first = resolutions[0] ?? { w: 1080, h: 1920 }
    setConfig(c => ({ ...c, aspect_ratio: ar, width: first.w, height: first.h }))
  }

  function handlePickAudio() {
    window.studio?.trailer?.pickAudio?.()
      .then(f => { if (f) setAudioFile(f) })
      .catch(() => {})
  }

  const canGenerate = !!audioFile
  const sbSize = storyboardPixelSize(config)

  return (
    <div className="flex-1 overflow-auto">
      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18]">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="flex items-center gap-1.5 text-[10px] font-mono text-[#9090a8] hover:text-[#e8e4dd] transition-colors">
              <ChevronRight size={12} className="rotate-180" />
              Lista
            </button>
          )}
          {onBack && <span className="text-[#252533]">/</span>}
          <Tv size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">Nuova Generazione</h1>
        </div>
        <div className="flex items-center gap-2">
          <GoldBtn onClick={() => onGenerate({ audioFile, lyrics, config: { ...config, model_overrides: modelOverrides || undefined } })} disabled={!canGenerate}>
            <Sparkles size={14} />
            Genera
          </GoldBtn>
          <GenQueueBadge kind="image" workflow={config.txt2img_workflow || 'z_image_txt2img'} />
        </div>
      </div>

      {/* Body */}
      <div className="p-6 grid grid-cols-2 gap-5">
        {/* Left — Audio & Lyrics */}
        <div className="space-y-5">
          <Card>
            <SectionLabel>Audio & Liriche</SectionLabel>

            <AudioDropZone
              audioFile={audioFile}
              onPick={handlePickAudio}
              onDrop={setAudioFile}
            />

            {audioFile?.path && (
              <AudioPlayerCard
                filePath={audioFile.path}
                label="Anteprima sorgente"
                displayName={audioFile.name}
              />
            )}

            <div className="mt-4">
              <div className="flex items-center justify-between mb-1">
                <SectionLabel>Liriche (opzionale)</SectionLabel>
                {!lyrics && (
                  <span className="text-[9px] font-mono text-[#c9a84c] border border-[#c9a84c]/30 rounded px-1.5 py-0.5">
                    auto-trascritte
                  </span>
                )}
              </div>
              <textarea
                value={lyrics}
                onChange={e => setLyrics(e.target.value)}
                rows={6}
                placeholder="Incolla qui il testo del brano..."
                className="w-full rounded-lg border border-[#252533] bg-[#0f0f18] px-3 py-2 text-[11px] font-mono text-[#e8e4dd] placeholder:text-[#555568] focus:outline-none focus:border-[#c9a84c]/40 resize-none"
              />
            </div>
          </Card>
        </div>

        {/* Right — Settings */}
        <div className="space-y-5">
          <Card>
            <SectionLabel>Impostazioni</SectionLabel>

            {/* Duration */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-mono text-[#9090a8]">Durata</label>
                <span className="text-[10px] font-mono text-[#c9a84c]">{config.duration_sec}s</span>
              </div>
              <input
                type="range"
                min={30}
                max={180}
                step={5}
                value={config.duration_sec}
                onChange={e => setConfig(c => ({ ...c, duration_sec: Number(e.target.value) }))}
                className="w-full accent-[#c9a84c]"
              />
              <div className="flex justify-between text-[9px] font-mono text-[#555568] mt-0.5">
                <span>30s</span><span>180s</span>
              </div>
            </div>

            {/* Aspect Ratio */}
            <div className="mb-4">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Formato</label>
              <div className="grid grid-cols-5 gap-1">
                {ASPECT_RATIO_OPTIONS.map(ar => (
                  <button
                    key={ar}
                    onClick={() => handleSetResolution(ar)}
                    className={clsx(
                      'py-1 rounded text-[9px] font-mono border transition-colors',
                      config.aspect_ratio === ar
                        ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                    )}
                  >
                    {ar}
                  </button>
                ))}
              </div>
            </div>

            {/* Resolution */}
            <div className="mb-4">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Risoluzione</label>
              <div className="relative">
                <select
                  value={`${config.width}x${config.height}`}
                  onChange={e => {
                    const [w, h] = e.target.value.split('x').map(Number)
                    setConfig(c => ({ ...c, width: w, height: h }))
                  }}
                  className="w-full appearance-none rounded px-3 py-1.5 text-[11px] font-mono border border-[#252533] bg-[#1e1e2a] text-[#e8e4dd] pr-7 focus:outline-none focus:border-[#c9a84c]/50"
                >
                  {(RESOLUTION_MAP[config.aspect_ratio] ?? []).map(r => (
                    <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#555568] pointer-events-none" />
              </div>
            </div>

            {/* FPS */}
            <div className="mb-4">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">FPS</label>
              <div className="grid grid-cols-4 gap-1">
                {FPS_OPTIONS.map(fps => (
                  <button
                    key={fps}
                    onClick={() => setConfig(c => ({ ...c, fps }))}
                    className={clsx(
                      'py-1 rounded text-[9px] font-mono border transition-colors',
                      config.fps === fps
                        ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                    )}
                  >
                    {fps}
                  </button>
                ))}
              </div>
            </div>

            {/* Style */}
            <div className="mb-4">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Stile visivo</label>
              <input
                type="text"
                value={config.style}
                onChange={e => setConfig(c => ({ ...c, style: e.target.value }))}
                className="w-full rounded px-3 py-1.5 text-[11px] font-mono border border-[#252533] bg-[#1e1e2a] text-[#e8e4dd] placeholder:text-[#555568] focus:outline-none focus:border-[#c9a84c]/50"
              />
            </div>

            {/* Concurrent jobs */}
            <div className="mb-5">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Job paralleli</label>
              <div className="relative">
                <select
                  value={config.concurrent_jobs}
                  onChange={e => setConfig(c => ({ ...c, concurrent_jobs: Number(e.target.value) }))}
                  className="w-full appearance-none rounded px-3 py-1.5 text-[11px] font-mono border border-[#252533] bg-[#1e1e2a] text-[#e8e4dd] pr-7 focus:outline-none focus:border-[#c9a84c]/50"
                >
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#555568] pointer-events-none" />
              </div>
            </div>
          </Card>

          <Card>
            <SectionLabel>Storyboard (anteprima immagini)</SectionLabel>
            <p className="text-[9px] font-mono text-[#555568] mb-3 leading-relaxed">
              Risoluzione e step per le anteprime txt2img prima dell&apos;approvazione. I frame HD finali usano la risoluzione video sopra.
            </p>

            <div className="mb-4">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-mono text-[#9090a8]">Dimensione</label>
                <span className="text-[10px] font-mono text-[#c9a84c]">
                  {sbSize.w}×{sbSize.h}px
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1">
                {STORYBOARD_SIZE_OPTS.map(opt => (
                  <button
                    key={opt.maxSide}
                    type="button"
                    title={opt.hint}
                    onClick={() => setConfig(c => ({ ...c, storyboard_max_side: opt.maxSide }))}
                    className={clsx(
                      'py-1.5 rounded text-[9px] font-mono border transition-colors flex flex-col items-center gap-0.5',
                      (config.storyboard_max_side ?? 320) === opt.maxSide
                        ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                    )}
                  >
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
              <p className="text-[9px] font-mono text-[#555568] mt-1">
                Lato lungo max · proporzioni {config.aspect_ratio}
              </p>
            </div>

            <div className="mb-1">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Qualità (step)</label>
              <div className="grid grid-cols-4 gap-1">
                {STORYBOARD_STEPS_OPTS.map(opt => (
                  <button
                    key={opt.steps}
                    type="button"
                    title={opt.hint}
                    onClick={() => setConfig(c => ({ ...c, storyboard_steps: opt.steps }))}
                    className={clsx(
                      'py-1.5 rounded text-[9px] font-mono border transition-colors',
                      (config.storyboard_steps ?? 10) === opt.steps
                        ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[9px] font-mono text-[#555568] mt-1">
                {(STORYBOARD_STEPS_OPTS.find(o => o.steps === (config.storyboard_steps ?? 10)) ?? STORYBOARD_STEPS_OPTS[1]).hint}
              </p>
            </div>
          </Card>

          {/* Workflow */}
          <Card>
            <SectionLabel>Workflow</SectionLabel>

            <div className="space-y-3 mb-4">
              <div>
                <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">
                  Frame (txt2img)
                </label>
                {workflows.txt2img.length === 0 ? (
                  <p className="text-[10px] font-mono text-[#555568] italic">Nessun workflow configurato</p>
                ) : (
                  <WorkflowSelect
                    value={config.txt2img_workflow}
                    onChange={v => setConfig(c => ({ ...c, txt2img_workflow: v }))}
                    workflows={workflows.txt2img}
                    placeholder="-- Seleziona --"
                  />
                )}
              </div>

              <div>
                <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">
                  Video (img2video)
                </label>
                {workflows.img2video.length === 0 ? (
                  <p className="text-[10px] font-mono text-[#555568] italic">Nessun workflow configurato</p>
                ) : (
                  <WorkflowSelect
                    value={config.img2video_workflow}
                    onChange={v => setConfig(c => ({ ...c, img2video_workflow: v }))}
                    workflows={workflows.img2video}
                    placeholder="-- Seleziona --"
                  />
                )}
              </div>
            </div>
            <div className="mb-3">
              <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Backend clip</label>
              <div className="grid grid-cols-3 gap-1">
                {[
                  { id: 'auto', label: 'Auto' },
                  { id: 'comfyui', label: 'LTX' },
                  { id: 'ffmpeg', label: 'Cut' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setConfig(c => ({ ...c, clip_backend: opt.id }))}
                    className={clsx(
                      'py-1 rounded text-[9px] font-mono border transition-colors',
                      config.clip_backend === opt.id
                        ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-2 mb-3 cursor-pointer">
              <input
                type="checkbox"
                checked={!!config.allow_ffmpeg_fallback}
                onChange={e => setConfig(c => ({ ...c, allow_ffmpeg_fallback: e.target.checked }))}
                className="mt-0.5 accent-[#c9a84c]"
              />
              <span className="text-[9px] font-mono text-[#9090a8] leading-relaxed">
                Fallback FFmpeg se ComfyUI non risponde (proxy RunPod). Consigliato con nodo remoto.
              </span>
            </label>

            <p className="text-[9px] font-mono text-[#555568] leading-relaxed -mt-1">
              Music video: Z-Image (frame) + LTX Image+Audio→Video da{' '}
              <span className="text-[#9090a8]">base_workflow_comfyui</span>.
              LTX richiede ComfyUI locale (:8188) o tunnel diretto al pod.
            </p>

            <PipelineInfoBox />
            <TrailerModelOverridesSection config={config} onChange={setModelOverrides} />
          </Card>

          <JobsPanel projectId={projectId} onRestart={handleRestartJob} />
        </div>
      </div>
    </div>
  )
}

// ── Storyboard Review (approvazione prima di HD) ─────────────────────────────

function StoryboardReviewView({
  clips, edl, config, audioFile, trailerAudioPath, audioAnalysis,
  mediaProjectId, storageProjectId, projectDir, jobId, onApprove, onRegenerate, onCancel,
}) {
  const ar = config?.aspect_ratio ?? '16:9'
  const isPortrait = ar === '9:16'
  const withThumb = clips.filter(c => c.storyboard_url)
  const sbDims = storyboardPixelSize(config || DEFAULT_CONFIG)
  const sbSteps = config?.storyboard_steps ?? 10

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <LayoutGrid size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">
            Storyboard — Revisione
          </h1>
          <span className="text-[10px] font-mono text-[#9090a8]">
            {withThumb.length}/{clips.length} · {sbDims.w}×{sbDims.h} · {sbSteps} step
          </span>
        </div>
        <div className="flex items-center gap-2">
          <GhostBtn onClick={onRegenerate}>
            <RefreshCw size={12} />
            Rigenera storyboard
          </GhostBtn>
          <GhostBtn onClick={onCancel}>
            <X size={12} />
            Annulla
          </GhostBtn>
          <GoldBtn onClick={onApprove}>
            <Check size={14} />
            Approva e genera HD + Video
          </GoldBtn>
        </div>
      </div>

      <div className="px-6 py-2 shrink-0 border-b border-[#252533]/50">
        <ProjectDirBanner
          storageProjectId={storageProjectId}
          jobId={jobId}
          projectDir={projectDir}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        <p className="text-[11px] font-mono text-[#9090a8] max-w-3xl">
          Anteprima visiva dei frame prima della generazione ad alta risoluzione e dei clip video.
          Verifica inquadrature e coerenza; dopo l&apos;approvazione partono ComfyUI (frame HD + LTX).
          Le immagini storyboard restano nella cartella progetto e non vengono aggiunte alla Media Library.
        </p>

        {edl && <EDLTimelineBar edl={edl} />}

        {audioFile && (
          <div className="max-w-md">
            <AudioPlayerCard
              filePath={trailerAudioPath || audioFile.path}
              label={trailerAudioPath ? 'Trailer Audio' : 'Traccia Sorgente'}
              displayName={audioFile.name}
              analysisData={audioAnalysis}
              highlight={!!trailerAudioPath}
            />
          </div>
        )}

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
        >
          {clips.map((clip, i) => {
            return (
              <div
                key={clip.clip_id ?? i}
                className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden"
              >
                <div
                  className="bg-[#0f0f18] flex items-center justify-center overflow-hidden"
                  style={{ aspectRatio: isPortrait ? '9/16' : '16/9', minHeight: 80 }}
                >
                  <StoryboardThumb
                    clip={clip}
                    projectId={mediaProjectId}
                    jobId={jobId}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="p-2 space-y-1">
                  <p className="text-[8px] font-mono text-[#c9a84c] truncate">{clip.clip_id}</p>
                  <p className="text-[8px] font-mono text-[#555568] line-clamp-2">
                    {clip.scene_prompt || clip.first_frame_prompt || '—'}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Generating View ──────────────────────────────────────────────────────────

function GeneratingView({
  phases, clips, setClips, globalPct, edl, config, audioFile, trailerAudioPath, audioAnalysis,
  stepResults, mediaProjectId, storageProjectId, jobId, projectDir, onCancel,
  trailerEnhanceContext,
}) {
  const resultsRef = useRef(null)
  const doneCount = clips.filter(c => c.status === 'done').length
  const [promptClip, setPromptClip] = useState(null)
  const [promptDraft, setPromptDraft] = useState({})

  function openPromptEditor(clip) {
    setPromptDraft({
      scene_prompt: clip.scene_prompt || '',
      first_frame_prompt: clip.first_frame_prompt || '',
      last_frame_prompt: clip.last_frame_prompt || '',
      motion_prompt: clip.motion_prompt || '',
      ltx_video_prompt: clip.ltx_video_prompt || '',
    })
    setPromptClip(clip)
  }

  const promptEditorContext = useMemo(() => {
    if (!trailerEnhanceContext || !promptClip) return trailerEnhanceContext
    return buildTrailerEnhanceContext({
      config: { style: trailerEnhanceContext.style },
      mediaProjectId: trailerEnhanceContext.project_id,
      clipId: promptClip.clip_id,
      directorNarrative: {
        narrative_arc: trailerEnhanceContext.director_narrative,
        logline: trailerEnhanceContext.logline,
        visual_theme: trailerEnhanceContext.visual_theme,
        mood: trailerEnhanceContext.mood,
      },
      brief: trailerEnhanceContext.brief,
    })
  }, [trailerEnhanceContext, promptClip])

  useEffect(() => {
    if (resultsRef.current) {
      resultsRef.current.scrollTop = resultsRef.current.scrollHeight
    }
  }, [stepResults.length])

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <Tv size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">
            Trailer Generator
            <span className="ml-3 text-sm font-['JetBrains_Mono'] text-[#9090a8] font-normal">
              — Generazione in corso...
            </span>
          </h1>
          <Loader2 size={15} className="text-[#c9a84c] animate-spin" />
        </div>
        <GhostBtn onClick={onCancel}>
          <X size={13} />
          Annulla
        </GhostBtn>
      </div>

      <div className="px-6 py-2 shrink-0">
        <ProjectDirBanner
          storageProjectId={storageProjectId}
          jobId={jobId}
          projectDir={projectDir}
        />
      </div>

      <div className="flex-1 overflow-hidden p-6 grid grid-cols-[200px_1fr_280px] gap-5">

        {/* Col 1 — Phases */}
        <div className="flex flex-col gap-4 overflow-hidden">
          <Card className="shrink-0">
            <SectionLabel>Fasi Pipeline</SectionLabel>
            <div className="space-y-1.5">
              {phases.map(phase => {
                const meta = PHASE_LABELS[phase.key]
                if (!meta) return null
                const IconComponent = meta.icon
                return (
                  <div
                    key={phase.key}
                    className={clsx(
                      'flex items-center gap-2 py-1.5 px-2 rounded transition-colors',
                      phase.status === 'running' && 'bg-[#c9a84c]/8',
                      phase.status === 'done'    && 'opacity-60',
                      phase.status === 'error'   && 'bg-[#ef4444]/8',
                    )}
                  >
                    <PhaseIcon status={phase.status} IconComponent={IconComponent} />
                    <span className={clsx(
                      'text-[11px] font-mono',
                      phase.status === 'running' ? 'text-[#c9a84c]' :
                      phase.status === 'done'    ? 'text-[#22c55e]' :
                      phase.status === 'error'   ? 'text-[#ef4444]' :
                      'text-[#555568]'
                    )}>
                      {meta.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* Source audio player */}
          {audioFile && (
            <AudioPlayerCard
              filePath={audioFile.path}
              label="Traccia Sorgente"
              displayName={audioFile.name}
              analysisData={audioAnalysis}
            />
          )}

          {/* Trailer audio player — appears when Phase 4 completes */}
          {trailerAudioPath && (
            <AudioPlayerCard
              filePath={trailerAudioPath}
              label="Trailer Audio"
              highlight
            />
          )}

          {/* Global progress */}
          <Card className="shrink-0">
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>Progresso</SectionLabel>
              <span className="text-[10px] font-mono text-[#c9a84c]">{Math.round(globalPct)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-[#0f0f18] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${globalPct}%`, background: 'linear-gradient(90deg, #c9a84c, #e6c46a)' }}
              />
            </div>
          </Card>
        </div>

        {/* Col 2 — Step Results */}
        <div className="flex flex-col gap-4 overflow-hidden">
          <div ref={resultsRef} className="flex-1 overflow-y-auto space-y-2 pr-1">
            {stepResults.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#252533] gap-2 py-12">
                <Sparkles size={28} />
                <p className="text-[10px] font-mono">I risultati appariranno qui</p>
              </div>
            ) : (
              stepResults.map((r, i) => <StepResultCard key={`${r.phase}-${i}`} result={r} />)
            )}
          </div>
        </div>

        {/* Col 3 — Clip grid + EDL */}
        <div className="flex flex-col gap-4 overflow-hidden">
          <Card className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-3 shrink-0">
              <SectionLabel>Clip / Storyboard</SectionLabel>
              <span className="text-[10px] font-mono text-[#9090a8]">{doneCount}/{clips.length}</span>
            </div>
            <p className="text-[8px] font-mono text-[#555568] mb-2 -mt-1">
              Anteprime solo in progetto — non in Media Library
            </p>
            <div className="overflow-y-auto flex-1">
              {clips.length > 0 ? (
                <ClipGrid
                  clips={clips}
                  aspectRatio={config?.aspect_ratio ?? '9:16'}
                  projectId={mediaProjectId}
                  jobId={jobId}
                  onEditPrompts={trailerEnhanceContext?.project_id ? openPromptEditor : undefined}
                />
              ) : (
                <div className="flex items-center justify-center py-10 text-[#252533]">
                  <Film size={22} />
                </div>
              )}
            </div>
          </Card>

          {edl && <EDLTimelineBar edl={edl} />}
        </div>

      </div>

      <ReelPromptEditorModal
        open={Boolean(promptClip)}
        clipId={promptClip?.clip_id}
        draft={promptDraft}
        setDraft={setPromptDraft}
        hasLastFrame={Boolean((promptDraft.last_frame_prompt || '').trim())}
        saving={false}
        saved={false}
        isDirty
        onClose={() => setPromptClip(null)}
        onSave={() => {
          if (promptClip && setClips) {
            setClips(prev => prev.map(c => (
              c.clip_id === promptClip.clip_id ? { ...c, ...promptDraft } : c
            )))
          }
          setPromptClip(null)
        }}
        projectContext={promptEditorContext}
      />
    </div>
  )
}

// ── Done View ────────────────────────────────────────────────────────────────

function DoneView({ result, error, edl, clips, audioFile, trailerAudioPath, audioAnalysis, onNew }) {
  // Use the pre-built URL from the backend when available; fall back to constructing it
  const videoUrl = result?.video_url
    ? `${BACKEND_ORIGIN}${result.video_url}`
    : result?.video_path
      ? (() => {
          // Handle both Windows (\) and POSIX (/) separators
          const filename = result.video_path.replace(/\\/g, '/').split('/').pop()
          const pid = result.project_id ?? 'trailer_standalone'
          return `${BACKEND_ORIGIN}/api/trailer/output/${pid}/${filename}`
        })()
      : null

  function handleOpenFile() {
    if (result?.video_path) {
      window.studio?.shell?.openPath?.(result.video_path)
    }
  }

  const clipsDone = clips.filter(c => c.status === 'done').length

  return (
    <div className="flex-1 overflow-auto">
      {/* Topbar */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18]">
        <div className="flex items-center gap-3">
          <Tv size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">
            Trailer Generator
          </h1>
          {error ? (
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-[#ef4444]">
              <AlertCircle size={13} />
              Errore
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-[#22c55e]">
              <CheckCircle size={13} />
              Completato
            </span>
          )}
        </div>
        <GoldBtn onClick={onNew}>
          <ChevronRight size={13} className="rotate-180" />
          Torna alla lista
        </GoldBtn>
      </div>

      <div className="p-6">
        {error ? (
          <Card className="border-[#ef4444]/30">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="text-[#ef4444] shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-mono text-[#ef4444] mb-1">Generazione fallita</p>
                <p className="text-[11px] font-mono text-[#9090a8]">{error}</p>
              </div>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-2 gap-5">
            {/* Left — Video player */}
            <div className="space-y-3">
              <Card className="p-0 overflow-hidden">
                {videoUrl ? (
                  <video
                    src={videoUrl}
                    controls
                    autoPlay
                    className="w-full rounded-xl"
                    style={{ maxHeight: '50vh', background: '#07070d' }}
                  />
                ) : (
                  <div className="flex items-center justify-center py-16 text-[#252533]">
                    <Video size={32} />
                  </div>
                )}
              </Card>

              <div className="flex gap-2">
                <GhostBtn onClick={handleOpenFile} className="flex-1 justify-center">
                  <Film size={13} />
                  Apri file
                </GhostBtn>
                {videoUrl && (
                  <GhostBtn
                    onClick={() => {
                      const a = document.createElement('a')
                      a.href = videoUrl
                      a.download = result?.filename ?? 'trailer.mp4'
                      a.click()
                    }}
                    className="flex-1 justify-center"
                  >
                    <Upload size={13} />
                    Scarica
                  </GhostBtn>
                )}
              </div>
            </div>

            {/* Right — Audio + Details */}
            <div className="space-y-4">
              {audioFile?.path && (
                <AudioPlayerCard
                  filePath={audioFile.path}
                  label="Traccia Sorgente"
                  displayName={audioFile.name}
                  analysisData={audioAnalysis}
                />
              )}
              {(trailerAudioPath || result?.trailer_audio_path) && (
                <AudioPlayerCard
                  filePath={trailerAudioPath || result.trailer_audio_path}
                  label="Trailer Audio"
                  highlight
                />
              )}
              <Card>
                <SectionLabel>Dettagli</SectionLabel>
                <div className="space-y-2">
                  {[
                    { label: 'Durata',       value: result?.duration_sec != null ? formatDuration(result.duration_sec) : '—' },
                    { label: 'Risoluzione',  value: result?.width && result?.height ? `${result.width}×${result.height}` : '—' },
                    { label: 'Clip generate', value: clipsDone > 0 ? String(clipsDone) : (result?.clip_count != null ? String(result.clip_count) : '—') },
                    { label: 'Dimensione',   value: result?.size_bytes != null ? formatBytes(result.size_bytes) : '—' },
                    { label: 'FPS',          value: result?.fps != null ? `${result.fps} fps` : '—' },
                  ].map(row => (
                    <div key={row.label} className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-[#9090a8]">{row.label}</span>
                      <span className="text-[10px] font-mono text-[#e8e4dd]">{row.value}</span>
                    </div>
                  ))}
                </div>
              </Card>

              {edl && <EDLTimelineBar edl={edl} />}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Screen ──────────────────────────────────────────────────────────────

export default function TrailerScreen() {
  const { id: routeProjectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  /** Catalogo job (trailer_jobs.json): trailer_standalone o UUID progetto collegato */
  const catalogProjectId = routeProjectId ?? 'trailer_standalone'
  /** Cartella artefatti su disco — assegnata dal backend (es. trailer_54115b9727) */
  const [storageProjectId, setStorageProjectId] = useState(null)
  const [view, setView] = useState('list')   // list | detail | setup | generating | storyboard | done
  const [activeJobId, setActiveJobId] = useState(null)
  const mediaProjectId = resolveTrailerMediaProjectId(
    storageProjectId,
    activeJobId,
    catalogProjectId,
  )
  const [selectedJob, setSelectedJob]       = useState(null)
  const [listRefreshKey, setListRefreshKey] = useState(0)
  // initial values for setup form when restarting a job
  const [setupInitial, setSetupInitial]     = useState({ audioFile: null, config: null })

  // Generation state
  const [phases, setPhases]       = useState(INITIAL_PHASES)
  const [clips, setClips]         = useState([])
  const [globalPct, setGlobalPct] = useState(0)
  const [logs, setLogs]           = useState([])
  const [edl, setEdl]             = useState(null)
  const [result, setResult]             = useState(null)
  const [error, setError]               = useState(null)
  const [activeConfig, setActiveConfig]         = useState(null)
  const [activeAudioFile, setActiveAudioFile]   = useState(null)
  const [trailerAudioPath, setTrailerAudioPath] = useState(null)
  const [audioAnalysis, setAudioAnalysis]       = useState(null)
  const [stepResults, setStepResults]           = useState([])
  const [projectDir, setProjectDir] = useState(null)

  // track LLM attempt count for director_llm result card
  const llmAttemptRef = useRef(0)
  // accumulate clip prompts until prompts_ready fires
  const pendingClipsRef = useRef([])

  const cancelRef = useRef(false)
  const storyboardPauseRef = useRef(false)
  const runTrailerRef = useRef(null)
  const reconcileAutoContinueRef = useRef(null)

  const stuckClipsKey = clips
    .filter(clipNeedsMediaRecovery)
    .map(c => c.clip_id)
    .sort()
    .join(',')

  const trailerEnhanceContext = useMemo(
    () => buildTrailerEnhanceContext({
      config: activeConfig,
      mediaProjectId,
      dopPlans: stepResults.find(r => r.phase === 'cinematographer')?.data?.plans,
      brief: activeConfig?.style || '',
    }),
    [activeConfig, mediaProjectId, stepResults],
  )

  const handleProgress = useCallback((data) => {
    if (cancelRef.current) return

    if (data.event === 'start' && data.job_id) {
      setActiveJobId(data.job_id)
      if (data.storage_project_id || data.project_id) {
        setStorageProjectId(data.storage_project_id || data.project_id)
      }
      if (data.project_dir) setProjectDir(data.project_dir)
    }

    if (data.event === 'phase') {
      setPhases(prev => prev.map(p =>
        p.key === data.phase
          ? { ...p, status: 'running', msg: data.msg ?? '' }
          : p.status === 'running' && p.key !== data.phase
            ? { ...p, status: 'done' }
            : p
      ))
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'phase_done') {
      setPhases(prev => prev.map(p =>
        p.key === data.phase ? { ...p, status: 'done' } : p
      ))
    }

    if (data.event === 'phase_error') {
      setPhases(prev => prev.map(p =>
        p.key === data.phase ? { ...p, status: 'error', msg: data.msg ?? '' } : p
      ))
    }

    if (data.event === 'llm_attempt') {
      llmAttemptRef.current = data.attempt
    }

    if (data.event === 'audio_analysis_done') {
      const breakdown = {}
      // pct update
      if (data.pct != null) setGlobalPct(data.pct * 100)
      setAudioAnalysis({ bpm: data.bpm, sections: data.sections, duration_sec: data.duration_sec })
      setStepResults(prev => [...prev, {
        phase: 'audio_analysis',
        data: { bpm: data.bpm, sections: data.sections, duration_sec: data.duration_sec },
      }])
    }

    if (data.event === 'edl_validation_error') {
      const msg = (data.errors || []).join('; ')
      setLogs(prev => [...prev.slice(-40), `EDL tentativo ${data.attempt}: ${msg}`])
    }

    if (data.event === 'edl_fallback') {
      const mode = data.mode === 'contiguous' ? 'estratto continuo 60s' : (data.mode || 'automatico')
      setLogs(prev => [...prev.slice(-40),
        `EDL: fallback ${mode}${data.reason ? ` — ${data.reason}` : ''}`])
      setStepResults(prev => [
        ...prev,
        { phase: 'director_llm', data: { attempts: llmAttemptRef.current || 3 } },
        {
          phase: 'edl_validator',
          data: {
            slots: data.edl?.slots ?? [],
            fallback: true,
            mode: data.mode || 'contiguous',
            reason: data.reason,
          },
        },
      ])
    }

    if (data.event === 'edl_ready') {
      setStepResults(prev => {
        // edl_fallback already added both cards — only add if not yet present
        const hasDirector  = prev.some(r => r.phase === 'director_llm')
        const hasValidator = prev.some(r => r.phase === 'edl_validator')
        const next = [...prev]
        if (!hasDirector)  next.push({ phase: 'director_llm',  data: { attempts: llmAttemptRef.current || 1 } })
        if (!hasValidator) next.push({ phase: 'edl_validator', data: { slots: data.edl?.slots ?? [], fallback: false } })
        return next
      })
    }

    if (data.event === 'audio_ready') {
      console.log('[Trailer] audio_ready — path:', data.path, 'duration:', data.duration_sec)
      if (data.pct != null) setGlobalPct(data.pct * 100)
      if (data.path) setTrailerAudioPath(data.path)
      setStepResults(prev => [...prev, {
        phase: 'audio_compositor',
        data: { duration_sec: data.duration_sec },
      }])
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
      const sbUrl = sbOk ? clipStoryboardPreviewUrl(framePayload, mediaProjectId) : null
      setClips(prev => {
        const exists = prev.some(c => c.clip_id === data.clip_id)
        const sbName = data.storyboard_filename || `${data.clip_id}_sb.png`
        const entry = {
          clip_id: data.clip_id,
          slot_id: data.slot_id ?? data.slot,
          status: sbOk ? 'storyboard' : 'storyboard_failed',
          storyboard_ok: sbOk,
          storyboard_placeholder: !sbOk,
          ...framePayload,
          storyboard_filename: sbOk ? sbName : undefined,
          frame_url: sbUrl || (sbOk ? clipStoryboardPreviewUrl(
            { clip_id: data.clip_id, storyboard_filename: sbName, ...framePayload },
            mediaProjectId,
          ) : null),
        }
        if (exists) {
          return prev.map(c => c.clip_id === data.clip_id ? { ...c, ...entry } : c)
        }
        return [...prev, entry]
      })
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'storyboard_ready' || data.event === 'awaiting_storyboard_approval') {
      if (data.job_id) setActiveJobId(data.job_id)
      if (data.edl) setEdl(data.edl)
      if (data.storyboard?.length) {
        setClips(data.storyboard.map(f => {
          const sbOk = f.storyboard_ok !== false && !f.storyboard_placeholder
          const sbName = f.storyboard_filename || `${f.clip_id}_sb.png`
          const row = {
            ...f,
            clip_id: f.clip_id,
            slot_id: f.slot_id,
            status: sbOk ? 'storyboard' : 'storyboard_failed',
            storyboard_ok: sbOk,
            storyboard_placeholder: !sbOk,
            storyboard_url: f.url,
            storyboard_path: f.path,
            storyboard_filename: sbName,
            preview_url: f.preview_url,
            storyboard_clip_url: f.storyboard_clip_url,
            scene_prompt: f.scene_prompt,
            first_frame_prompt: f.first_frame_prompt,
          }
          return { ...row, frame_url: clipStoryboardPreviewUrl(row, mediaProjectId) }
        }))
      }
      setPhases(prev => prev.map(p =>
        p.key === 'storyboard' ? { ...p, status: 'done' } : p,
      ))
      if (data.pct != null) setGlobalPct(data.pct * 100)
      if (data.event === 'awaiting_storyboard_approval') {
        storyboardPauseRef.current = true
        setView('storyboard')
      }
    }

    if (data.event === 'dop_plan_ready') {
      setStepResults(prev => [...prev, {
        phase: 'cinematographer',
        data: { plans: data.plans ?? [] },
      }])
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'prompts_ready') {
      const clipPayloads = Array.isArray(data.clips)
        ? data.clips
        : pendingClipsRef.current
      if (data.pct != null) setGlobalPct(data.pct * 100)
      setStepResults(prev => {
        const without = prev.filter(r => r.phase !== 'prompt_gen')
        return [...without, { phase: 'prompt_gen', data: { clips: clipPayloads } }]
      })
      setClips(prev => {
        const byId = new Map(prev.map(c => [c.clip_id, c]))
        for (const p of clipPayloads) {
          if (!p?.clip_id) continue
          const existing = byId.get(p.clip_id) ?? { clip_id: p.clip_id, status: 'waiting', frame_url: null }
          byId.set(p.clip_id, {
            ...existing,
            slot_id: p.slot ?? p.slot_id ?? existing.slot_id,
            scene_prompt: p.scene_prompt,
            first_frame_prompt: p.first_frame_prompt,
            last_frame_prompt: p.last_frame_prompt,
            motion_prompt: p.motion_prompt,
          })
        }
        return [...byId.values()]
      })
      pendingClipsRef.current = []
    }

    if (data.event === 'progress') {
      if (data.msg) setLogs(prev => [...prev.slice(-50), data.msg])
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'edl_ready') {
      setEdl(data.edl ?? null)
      // Pre-populate clip grid from EDL slots (one cell per slot, more added on clip_queued)
      const initialClips = (data.edl?.slots ?? []).map(s => ({
        clip_id: `${s.slot_id}_preview`,
        slot_id: s.slot_id,
        status: 'waiting',
        frame_url: null,
      }))
      if (initialClips.length > 0) setClips(initialClips)
    }

    if (data.event === 'clip_queued') {
      const promptEntry = {
        clip_id: data.clip_id,
        slot_id: data.slot ?? data.slot_id,
        duration_sec: data.duration_sec,
        scene_prompt: data.scene_prompt,
        first_frame_prompt: data.first_frame_prompt,
        last_frame_prompt: data.last_frame_prompt,
        motion_prompt: data.motion_prompt,
      }
      pendingClipsRef.current.push(promptEntry)
      setClips(prev => {
        const slotKey = data.slot ?? data.slot_id
        const filtered = prev.filter(c => c.clip_id !== `${slotKey}_preview`)
        const exists = filtered.some(c => c.clip_id === data.clip_id)
        if (exists) {
          return filtered.map(c =>
            c.clip_id === data.clip_id
              ? { ...c, ...promptEntry, status: c.status === 'waiting' ? 'generating' : c.status }
              : c,
          )
        }
        return [...filtered, { ...promptEntry, status: 'generating', frame_url: null }]
      })
    }

    if (data.event === 'frame_done' || data.event === 'frames_ready') {
      const frameUrl = resolveBackendUrl(data.frame_url)
        || trailerFrameClipUrl(mediaProjectId, data.clip_id)
        || resolveBackendUrl(data.url)
      if (frameUrl) {
        setClips(prev => prev.map(c =>
          c.clip_id === data.clip_id
            ? {
                ...c,
                frame_url: frameUrl,
                first_frame_path: data.path || data.first_path || c.first_frame_path,
                frame_placeholder: Boolean(data.placeholder),
                status: data.placeholder ? c.status : 'generating',
              }
            : c,
        ))
      }
    }

    if (data.event === 'phase' && data.phase === 'video_clips') {
      setLogs(prev => [...prev.slice(-50), data.msg || 'Generazione clip video…'])
    }

    if (data.event === 'clip_comfyui_progress') {
      if (data.comfyui_max > 1) {
        const clipPct = Math.round((data.comfyui_value / data.comfyui_max) * 100)
        const label = data.kind === 'storyboard' ? 'Storyboard' : 'ComfyUI'
        setLogs(prev => [...prev.slice(-50),
          `${data.clip_id}: ${label} ${data.comfyui_value}/${data.comfyui_max} (${clipPct}%)`])
      }
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id
          ? {
              ...c,
              comfyuiPct: data.comfyui_pct,
              comfyuiMsg: data.msg,
              status: c.status === 'done'
                ? 'done'
                : (c.frame_url || c.storyboard_path)
                  ? 'storyboard'
                  : 'generating',
            }
          : c,
      ))
    }

    if (data.event === 'generation_progress') {
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'comfyui_probe') {
      if (data.status === 'start') {
        setLogs(prev => [...prev.slice(-50), 'Verifica nodi ComfyUI…'])
      } else if (data.status === 'done') {
        setLogs(prev => [...prev.slice(-50),
          data.backend === 'ffmpeg' ? 'ComfyUI non esegue — modalità FFmpeg' : 'ComfyUI OK — LTX attivo'])
      }
    }

    if (data.event === 'clip_backend') {
      const msg = data.backend === 'ffmpeg'
        ? `⚠ ${data.reason || 'Cut statici — non LTX animato'}`
        : `LTX: ${data.txt2img || 'z_image'} → ${data.img2video || 'ltx_img_audio2video'}`
      setLogs(prev => [...prev.slice(-50), msg])
    }

    if (data.event === 'frame_placeholder') {
      setLogs(prev => [...prev.slice(-50), `Frame placeholder: ${data.clip_id}`])
    }

    if (data.event === 'clip_done') {
      const clipUrl = resolveBackendUrl(data.url)
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id
          ? { ...c, status: 'done', clip_url: clipUrl || c.clip_url }
          : c
      ))
      if (data.pct != null) setGlobalPct(data.pct * 100)
    }

    if (data.event === 'clip_error') {
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id ? { ...c, status: 'error' } : c
      ))
    }

    if (data.done) {
      setPhases(prev => prev.map(p =>
        p.status === 'running' ? { ...p, status: 'done' } : p
      ))
      setGlobalPct(100)
      if (data.trailer_audio_path) setTrailerAudioPath(data.trailer_audio_path)
      setResult(data)
      setView('done')
    }

    if (data.error) {
      const staleDisconnect = typeof data.error === 'string'
        && data.error.includes('Connessione al backend interrotta')
      if (staleDisconnect && storyboardPauseRef.current) {
        return
      }
      setError(data.error)
      setView('done')
    }
  }, [mediaProjectId])

  async function runTrailerPipeline({ audioFile, lyrics, config }) {
    const params = {
      project_id: catalogProjectId,
      audio_path: audioFile.path,
      audio_name: audioFile.name,
      lyrics: lyrics || null,
      phase: config.phase || 'full',
      ...config,
    }
    try {
      await window.studio?.trailer?.generate?.(params, handleProgress)
    } catch (err) {
      setError(err?.message ?? 'Errore sconosciuto')
      setView('done')
    }
  }

  async function handleApproveStoryboard() {
    if (!activeAudioFile || !activeConfig || !activeJobId) return
    cancelRef.current = false
    storyboardPauseRef.current = false
    setView('generating')
    setPhases(prev => prev.map(p => {
      if (p.key === 'storyboard') return { ...p, status: 'done' }
      if (p.key === 'comfyui') return { ...p, status: 'running' }
      return p
    }))
    setGlobalPct(46)
    await runTrailerPipeline({
      audioFile: activeAudioFile,
      lyrics: null,
      config: {
        ...activeConfig,
        resume_job_id: activeJobId,
        phase: 'production',
      },
    })
  }

  async function handleRegenerateStoryboard() {
    if (!activeAudioFile || !activeConfig || !activeJobId) return
    setView('generating')
    setPhases(prev => prev.map(p =>
      p.key === 'storyboard' ? { ...p, status: 'running', msg: '' } : p,
    ))
    await runTrailerPipeline({
      audioFile: activeAudioFile,
      lyrics: null,
      config: {
        ...activeConfig,
        resume_job_id: activeJobId,
        phase: 'storyboard',
      },
    })
  }

  runTrailerRef.current = runTrailerPipeline

  useMediaReconcile({
    enabled: Boolean(activeJobId && catalogProjectId),
    kind: 'trailer',
    catalogProjectId,
    jobId: activeJobId,
    stuckKey: stuckClipsKey,
    alwaysPoll: view === 'generating' || view === 'storyboard',
    onResult: (data) => {
      if (data.recovered?.length) {
        setClips(prev => prev.map(c => {
          let next = c
          for (const ev of data.recovered) {
            if (ev.clip_id === c.clip_id) {
              next = mergeClipRecoveryEvent(next, ev, mediaProjectId, 'trailer')
            }
          }
          return next
        }))
        const videoN = data.recovered.filter(e => e.event === 'clip_done').length
        const frameN = data.count - videoN
        if (videoN || frameN) {
          setLogs(prev => [...prev.slice(-50),
            `Recuperati ${videoN ? `${videoN} video` : ''}${videoN && frameN ? ', ' : ''}${frameN ? `${frameN} frame/storyboard` : ''} (ComfyUI/disco)`,
          ])
        }
      }
      const prodReady = data.storyboard_approved || (data.checkpoint_phase ?? 0) >= 55
      if (
        prodReady
        && data.all_clips_ready
        && activeAudioFile
        && activeConfig
        && reconcileAutoContinueRef.current !== activeJobId
      ) {
        reconcileAutoContinueRef.current = activeJobId
        setLogs(prev => [...prev.slice(-50), 'Tutte le clip pronte — ripresa automatica verso assemblaggio'])
        runTrailerRef.current?.({
          audioFile: activeAudioFile,
          lyrics: null,
          config: { ...activeConfig, resume_job_id: activeJobId, phase: 'production' },
        })
      }
    },
  })

  async function handleGenerate({ audioFile, lyrics, config }) {
    cancelRef.current = false
    storyboardPauseRef.current = false
    llmAttemptRef.current = 0
    pendingClipsRef.current = []
    setView('generating')
    setPhases(INITIAL_PHASES)
    setClips([])
    setGlobalPct(0)
    setLogs([])
    setEdl(null)
    setResult(null)
    setError(null)
    setActiveConfig(config)
    setActiveAudioFile(audioFile)
    setAudioAnalysis(null)
    setStepResults([])

    await runTrailerPipeline({
      audioFile,
      lyrics,
      config: { phase: 'full', ...config },
    })
  }

  function handleCancel() {
    cancelRef.current = true
    // Let the pipeline finish/fail naturally; go back to list immediately
    handleGoList()
  }

  function _resetGenState() {
    cancelRef.current = false
    storyboardPauseRef.current = false
    llmAttemptRef.current = 0
    pendingClipsRef.current = []
    setPhases(INITIAL_PHASES)
    setClips([])
    setGlobalPct(0)
    setLogs([])
    setEdl(null)
    setResult(null)
    setError(null)
    setActiveConfig(null)
    setActiveAudioFile(null)
    setTrailerAudioPath(null)
    setAudioAnalysis(null)
    setStepResults([])
    setActiveJobId(null)
    setStorageProjectId(null)
    setProjectDir(null)
  }

  function handleGoList() {
    _resetGenState()
    setSelectedJob(null)
    setSetupInitial({ audioFile: null, config: null })
    setListRefreshKey(k => k + 1)
    setView('list')
  }

  function handleNew() {
    setSetupInitial({ audioFile: null, config: null })
    setView('setup')
  }

  useEffect(() => {
    if (!location.state?.newProject) return
    handleNew()
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: {} },
    )
  }, [location.state?.newProject])

  function handleViewDetail(job) {
    setSelectedJob(job)
    setView('detail')
  }

  const viewDetailRef = useRef(handleViewDetail)
  viewDetailRef.current = handleViewDetail
  useJobQueryDeepLink({
    catalogProjectId,
    apiPrefix: 'trailer',
    onOpenJob: (job) => viewDetailRef.current(job),
  })

  function handleRestartJob(job) {
    if (job.status === 'awaiting_storyboard' && job.audio_path) {
      setActiveJobId(job.job_id)
      setStorageProjectId(job.storage_project_id || job.project_id || null)
      setActiveConfig({ ...DEFAULT_CONFIG, ...job.config })
      setActiveAudioFile({ path: job.audio_path, name: job.audio_name, size: null })
      setClips((job.result?.storyboard ?? []).map(f => ({
        clip_id: f.clip_id,
        slot_id: f.slot_id,
        status: 'storyboard',
        storyboard_url: f.url,
        storyboard_path: f.path,
        storyboard_filename: f.storyboard_filename,
        preview_url: f.preview_url,
        storyboard_clip_url: f.storyboard_clip_url,
        frame_url: clipStoryboardPreviewUrl(
          f,
          job.storage_project_id || job.project_id || catalogProjectId,
        ),
        scene_prompt: f.scene_prompt,
        first_frame_prompt: f.first_frame_prompt,
      })))
      setView('storyboard')
      return
    }

    const canResume = ['failed', 'interrupted'].includes(job.status)
    const shortAudio = job.result?.duration_sec != null
      && job.config?.duration_sec != null
      && job.result.duration_sec < job.config.duration_sec * 0.92
    setSetupInitial({
      audioFile: { path: job.audio_path, name: job.audio_name, size: null },
      config: {
        ...DEFAULT_CONFIG,
        ...job.config,
        clip_backend: 'auto',
        allow_ffmpeg_fallback: true,
        ...(canResume && !shortAudio
          ? { resume_job_id: job.job_id, phase: 'production' }
          : {}),
      },
    })
    setView('setup')
  }

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: 'var(--bg0)', color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace" }}
    >
      {view === 'list' && (
        <JobsListView
          projectId={catalogProjectId}
          refreshKey={listRefreshKey}
          onNew={handleNew}
          onViewDetail={handleViewDetail}
        />
      )}

      {view === 'detail' && selectedJob && (
        <JobDetailView
          job={selectedJob}
          projectId={catalogProjectId}
          onBack={() => setView('list')}
          onRestart={handleRestartJob}
          onDelete={handleGoList}
        />
      )}

      {view === 'setup' && (
        <SetupView
          onGenerate={handleGenerate}
          onBack={() => setView('list')}
          projectId={catalogProjectId}
          initialAudioFile={setupInitial.audioFile}
          initialConfig={setupInitial.config}
        />
      )}

      {view === 'storyboard' && (
        <StoryboardReviewView
          clips={clips}
          edl={edl}
          config={activeConfig}
          audioFile={activeAudioFile}
          trailerAudioPath={trailerAudioPath}
          audioAnalysis={audioAnalysis}
          mediaProjectId={mediaProjectId}
          storageProjectId={storageProjectId}
          projectDir={projectDir}
          jobId={activeJobId}
          onApprove={handleApproveStoryboard}
          onRegenerate={handleRegenerateStoryboard}
          onCancel={handleGoList}
        />
      )}

      {view === 'generating' && (
        <GeneratingView
          phases={phases}
          clips={clips}
          setClips={setClips}
          globalPct={globalPct}
          edl={edl}
          config={activeConfig}
          audioFile={activeAudioFile}
          trailerAudioPath={trailerAudioPath}
          audioAnalysis={audioAnalysis}
          stepResults={stepResults}
          mediaProjectId={mediaProjectId}
          storageProjectId={storageProjectId}
          jobId={activeJobId}
          projectDir={projectDir}
          onCancel={handleCancel}
          trailerEnhanceContext={trailerEnhanceContext}
        />
      )}

      {view === 'done' && (
        <DoneView
          result={result}
          error={error}
          edl={edl}
          clips={clips}
          audioFile={activeAudioFile}
          trailerAudioPath={trailerAudioPath}
          audioAnalysis={audioAnalysis}
          onNew={handleGoList}
        />
      )}
    </div>
  )
}
