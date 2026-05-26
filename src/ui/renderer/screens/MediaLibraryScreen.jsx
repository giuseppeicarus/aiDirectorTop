import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Image as ImageIcon, Film, Music, Upload, Search, Trash2,
  ExternalLink, FolderOpen, X, ChevronDown, Eye, Layers,
  Tag, Info, Check, Loader2, RefreshCw, Grid2X2, LayoutList,
  Play, Volume2, ZoomIn, ArrowLeft, ArrowRight, Link2, AlertTriangle,
  Download, UserRound,
} from 'lucide-react'
import clsx from 'clsx'
import ImageLightbox from '../components/ImageLightbox'
import MediaImageContextMenu from '../components/MediaImageContextMenu'
import ElegantLoader from '../components/ElegantLoader'
import { mediaFileUrl, mediaThumbUrl } from '../utils/mediaUrl'
import { downloadMediaItem } from '../utils/mediaDownload'
import {
  imageSourceFromMediaItem,
  setPendingImg2Video,
} from '../utils/toolsAnimate'

import { API_BASE } from '../utils/apiClient'

const API = API_BASE

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_TABS = [
  { key: 'all',   label: 'Tutto',    Icon: Layers  },
  { key: 'image', label: 'Immagini', Icon: ImageIcon },
  { key: 'video', label: 'Video',    Icon: Film    },
  { key: 'audio', label: 'Audio',    Icon: Music   },
  { key: 'characters', label: 'Personaggi', Icon: UserRound },
]

const SOURCE_OPTS = [
  { key: 'all',       label: 'Tutti i sorgenti' },
  { key: 'uploaded',  label: 'Caricati'         },
  { key: 'generated', label: 'Generati dalla pipeline' },
  { key: 'character', label: 'Personaggi' },
]

const SORT_OPTS = [
  { key: 'date_desc', label: 'Data ↓' },
  { key: 'date_asc',  label: 'Data ↑' },
  { key: 'name',      label: 'Nome'   },
  { key: 'size',      label: 'Dimensione' },
]

const ACCEPT_TYPES = 'image/*,video/*,audio/*'
const GRID_SIZES = ['sm', 'md', 'lg']
/** Colonne fluide: si adattano alla larghezza finestra (anche fullscreen). */
const GRID_TEMPLATE = {
  sm: 'repeat(auto-fill, minmax(9rem, 1fr))',
  md: 'repeat(auto-fill, minmax(11rem, 1fr))',
  lg: 'repeat(auto-fill, minmax(14rem, 1fr))',
}
/** Limite altezza anteprima per non dominare la griglia con portrait molto alti. */
const THUMB_MAX_H = { sm: 'max-h-28', md: 'max-h-44', lg: 'max-h-60' }
const THUMB_MIN_H = { sm: 'min-h-[5.5rem]', md: 'min-h-[7rem]', lg: 'min-h-[9rem]' }

function mediaAspectRatio(item) {
  const w = Number(item.width) || 0
  const h = Number(item.height) || 0
  if (w > 0 && h > 0) {
    const r = w / h
    return Math.min(2.5, Math.max(0.4, r))
  }
  if (item.type === 'video') return 16 / 9
  if (item.type === 'image') return 1
  return 1
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`
  return `${(n / 1_073_741_824).toFixed(2)} GB`
}

function fmtDur(sec) {
  if (!sec) return null
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`
}

function fileType(mimeOrExt) {
  const s = (mimeOrExt || '').toLowerCase()
  if (s.startsWith('image') || /\.(jpg|jpeg|png|webp|gif|bmp|tiff?)$/.test(s)) return 'image'
  if (s.startsWith('video') || /\.(mp4|mov|avi|mkv|webm|wmv)$/.test(s)) return 'video'
  if (s.startsWith('audio') || /\.(mp3|wav|m4a|ogg|flac|aac)$/.test(s)) return 'audio'
  return null
}

function sortItems(items, sortKey) {
  const arr = [...items]
  switch (sortKey) {
    case 'date_asc':  return arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    case 'name':      return arr.sort((a, b) => a.filename.localeCompare(b.filename))
    case 'size':      return arr.sort((a, b) => b.size_bytes - a.size_bytes)
    default:          return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
}

// ── Anteprima in griglia (img / video / audio) ───────────────────────────────

function MediaLibraryImage({ src, alt, className, onPreview, onContextMenu, reportSize, onError }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative w-full h-full flex items-center justify-center bg-[#0f0f18] min-h-[5.5rem] md:min-h-[7rem] lg:min-h-[9rem] overflow-hidden">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0f0f18] z-10">
          <Loader2 size={16} className="text-[#c9a84c] animate-spin" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        onLoad={(e) => {
          setLoaded(true)
          reportSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)
        }}
        onError={onError}
        onClick={onPreview}
        onContextMenu={onContextMenu}
        className={clsx(
          className,
          "transition-all duration-500",
          loaded ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-95 blur-sm"
        )}
      />
    </div>
  )
}
function MediaLibraryVideo({ src, className, onPreview, reportSize }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative w-full h-full flex items-center justify-center bg-[#0f0f18] min-h-[5.5rem] md:min-h-[7rem] lg:min-h-[9rem] overflow-hidden">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0f0f18] z-10">
          <Loader2 size={16} className="text-[#c9a84c] animate-spin" />
        </div>
      )}
      <video
        src={src}
        muted
        playsInline
        preload="metadata"
        onLoadedData={() => setLoaded(true)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          reportSize(v.videoWidth, v.videoHeight)
        }}
        onClick={onPreview}
        className={clsx(
          className,
          "transition-all duration-500 bg-black",
          loaded ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-95 blur-sm"
        )}
      />
    </div>
  )
}

function MediaGridPreview({ item, onPreview, onImageContextMenu, onIntrinsicSize }) {
  const fileUrl = mediaFileUrl(item.id)
  const [imgSrc, setImgSrc] = useState(() => mediaThumbUrl(item.id) || fileUrl)

  const reportSize = (w, h) => {
    if (w > 0 && h > 0) onIntrinsicSize?.(w, h)
  }

  if (!fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 text-[var(--text3)]">
        <AlertTriangle size={20} className="opacity-40" />
        <span className="text-[9px] font-mono">File assente</span>
      </div>
    )
  }

  if (item.type === 'image') {
    return (
      <>
        <MediaLibraryImage
          src={imgSrc}
          alt={item.filename}
          className="max-w-full max-h-full w-auto h-auto object-contain cursor-zoom-in pointer-events-auto"
          onPreview={(e) => { e.stopPropagation(); onPreview(item) }}
          onContextMenu={(e) => onImageContextMenu?.(e, item)}
          reportSize={reportSize}
          onError={() => {
            if (imgSrc !== fileUrl) setImgSrc(fileUrl)
          }}
        />
        <button
          type="button"
          title="Galleria fullscreen"
          onClick={(e) => { e.stopPropagation(); onPreview(item) }}
          className="absolute bottom-1.5 right-1.5 z-20 p-1.5 rounded-md bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/75 transition-opacity pointer-events-auto"
        >
          <ZoomIn size={12} />
        </button>
      </>
    )
  }

  if (item.type === 'video') {
    return (
      <>
        <MediaLibraryVideo
          src={fileUrl}
          className="max-w-full max-h-full w-auto h-auto object-contain cursor-pointer pointer-events-auto bg-black"
          onPreview={(e) => { e.stopPropagation(); onPreview(item) }}
          reportSize={reportSize}
        />
        <button
          type="button"
          title="Riproduci a schermo intero"
          onClick={(e) => { e.stopPropagation(); onPreview(item) }}
          className="absolute bottom-1.5 right-1.5 z-20 p-1.5 rounded-md bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/75 transition-opacity pointer-events-auto"
        >
          <Play size={12} />
        </button>
      </>
    )
  }

  if (item.type === 'audio') {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center gap-2 px-2 py-2 pointer-events-auto"
        onClick={e => e.stopPropagation()}
      >
        <Volume2 size={22} className="text-[var(--gold)] opacity-60 shrink-0" />
        <audio
          src={fileUrl}
          controls
          preload="metadata"
          className="w-full max-w-full h-8"
        />
        {item.duration_sec > 0 && (
          <span className="text-[9px] text-[var(--text3)] font-mono">{fmtDur(item.duration_sec)}</span>
        )}
      </div>
    )
  }

  return null
}

// ── Resolution badge helper ───────────────────────────────────────────────────

function resolutionLabel(w, h) {
  if (!w || !h || w <= 0 || h <= 0) return null
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (long >= 3840 || short >= 2160) return { label: '4K',  cls: 'text-[var(--gold)] bg-[var(--gold)]/20 border-[var(--gold)]/30' }
  if (long >= 2560 || short >= 1440) return { label: '2K',  cls: 'text-blue-300 bg-blue-500/15 border-blue-500/25' }
  if (long >= 1920 || short >= 1080) return { label: 'FHD', cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/25' }
  if (long >= 1280 || short >=  720) return { label: 'HD',  cls: 'text-white/70 bg-white/10 border-white/15' }
  return { label: 'SD', cls: 'text-white/40 bg-white/5 border-white/10' }
}

// ── MediaCard ─────────────────────────────────────────────────────────────────

function MediaCard({ item, thumbSize, onDelete, onPreview, onAssign, onDownload, onImageContextMenu, onOpenCharacter, onUseCharacter }) {
  const isImage = item.type === 'image'
  const isAudio = item.type === 'audio'
  const [intrinsic, setIntrinsic] = useState(null)
  const tags = (() => { try { return JSON.parse(item.tags || '[]') } catch { return [] } })()

  useEffect(() => {
    setIntrinsic(null)
  }, [item.id])

  const dims = intrinsic || (item.width > 0 && item.height > 0
    ? { w: item.width, h: item.height }
    : null)
  const aspectStyle = dims
    ? { aspectRatio: `${dims.w} / ${dims.h}` }
    : { aspectRatio: mediaAspectRatio(item) }

  return (
    <div className="group relative rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--bg2)] hover:border-[var(--gold)]/40 transition-colors flex flex-col">
      {/* Thumbnail — proporzioni da metadati o dimensioni reali del file */}
      <div
        className={clsx(
          'relative overflow-hidden bg-[var(--bg3)] flex items-center justify-center w-full',
          isAudio ? 'min-h-[7.5rem]' : [THUMB_MIN_H[thumbSize], THUMB_MAX_H[thumbSize]],
        )}
        style={isAudio ? undefined : aspectStyle}
        onContextMenu={isImage ? (e) => onImageContextMenu?.(e, item) : undefined}
      >
        <MediaGridPreview
          item={item}
          onPreview={onPreview}
          onImageContextMenu={onImageContextMenu}
          onIntrinsicSize={(w, h) => {
            if (!item.width || !item.height) setIntrinsic({ w, h })
          }}
        />

        {/* Top-left: resolution badge + source badge */}
        <div className="absolute top-1 left-1 flex flex-col gap-0.5 items-start pointer-events-none z-20">
          {(() => {
            const w = dims?.w || item.width
            const h = dims?.h || item.height
            const r = resolutionLabel(w, h)
            return r ? (
              <span className={clsx('text-[8px] px-1.5 py-[1px] rounded font-mono font-semibold border tracking-wide', r.cls)}>
                {r.label}
              </span>
            ) : null
          })()}
          <span className={clsx(
            'text-[9px] px-1.5 py-0.5 rounded font-mono',
            item.source === 'uploaded'
              ? 'bg-blue-500/20 text-blue-400'
              : 'bg-[var(--gold)]/15 text-[var(--gold)]'
          )}>
            {item.source === 'uploaded' ? 'upload' : 'gen'}
          </span>
        </div>

        {/* Hover overlay — pointer-events-none così la lente resta cliccabile */}
        <div className="absolute inset-0 z-10 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 pointer-events-none">
          <ActionBtn icon={Eye}        title="Preview"           onClick={() => onPreview(item)} />
          <ActionBtn icon={Download}  title="Scarica"           onClick={() => onDownload(item)} />
          {item.source === 'character' && (
            <ActionBtn icon={ExternalLink} title="Dettaglio personaggio" onClick={() => onOpenCharacter(item)} gold />
          )}
          <ActionBtn
            icon={Link2}
            title={item.source === 'character' ? 'Usa in CreateReel' : 'Usa nel progetto'}
            onClick={() => (item.source === 'character' ? onUseCharacter(item) : onAssign(item))}
            gold
          />
          <ActionBtn icon={Trash2}     title="Elimina"           onClick={() => onDelete(item.id)} danger />
        </div>
      </div>

      {/* Info */}
      <div className="px-2 py-1.5">
        <p className="text-[10px] text-[var(--text)] truncate font-mono" title={item.filename}>
          {item.filename}
        </p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[9px] text-[var(--text3)] truncate max-w-[70%]">
            {item.project_title !== '__library__' ? item.project_title : 'Libreria'}
          </span>
          <span className="text-[9px] text-[var(--text3)] font-mono shrink-0">{fmtBytes(item.size_bytes)}</span>
        </div>
        {item.width > 0 && (
          <p className="text-[9px] text-[var(--text3)] font-mono">{item.width}×{item.height}</p>
        )}
        {tags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {tags.slice(0, 3).map(t => (
              <span key={t} className="text-[8px] px-1 py-0.5 rounded-sm bg-[var(--bg3)] text-[var(--text3)]">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ActionBtn({ icon: Icon, title, onClick, gold, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      className={clsx(
        'p-1.5 rounded-lg bg-black/40 transition-colors pointer-events-auto',
        gold   ? 'text-[var(--gold)] hover:bg-[var(--gold)]/20' :
        danger ? 'text-[var(--text2)] hover:text-[var(--red)] hover:bg-red-500/20' :
                 'text-[var(--text2)] hover:text-[var(--text)] hover:bg-white/10'
      )}
    >
      <Icon size={13} />
    </button>
  )
}

// ── Upload progress toasts ────────────────────────────────────────────────────

function UploadToasts({ uploads }) {
  if (!uploads.length) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 w-64">
      {uploads.map(u => (
        <div key={u.id} className="bg-[var(--bg2)] border border-[var(--border)] rounded-lg px-3 py-2.5 shadow-xl">
          <div className="flex items-center gap-2 mb-1.5">
            {u.status === 'uploading'
              ? <Loader2 size={12} className="text-[var(--gold)] animate-spin shrink-0" />
              : u.status === 'done'
              ? <Check size={12} className="text-[var(--green)] shrink-0" />
              : <X size={12} className="text-[var(--red)] shrink-0" />
            }
            <span className="text-[11px] text-[var(--text)] truncate">{u.filename}</span>
          </div>
          {u.status === 'uploading' && (
            <div className="h-0.5 rounded-full bg-[var(--bg3)] overflow-hidden">
              <div className="h-full bg-[var(--gold)] animate-pulse rounded-full w-2/3" />
            </div>
          )}
          {u.error && <p className="text-[10px] text-[var(--red)] mt-0.5">{u.error}</p>}
        </div>
      ))}
    </div>
  )
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function PreviewModal({ item, allItems, onClose, onNavigate, onDownload }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft')  onNavigate(-1)
      if (e.key === 'ArrowRight') onNavigate(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate])

  if (!item) return null
  const tags = (() => { try { return JSON.parse(item.tags || '[]') } catch { return [] } })()

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative max-w-5xl w-full max-h-[90vh] flex gap-4" onClick={e => e.stopPropagation()}>
        {/* Media */}
        <div className="flex-1 flex items-center justify-center rounded-xl overflow-hidden bg-black min-h-0">
          {item.type === 'image' && (
            <img
              src={mediaFileUrl(item.id)}
              alt={item.filename}
              className="max-w-full max-h-[80vh] object-contain"
            />
          )}
          {item.type === 'video' && (
            <video
              src={mediaFileUrl(item.id)}
              controls
              autoPlay
              playsInline
              className="max-w-full max-h-[80vh] w-auto h-auto object-contain bg-black"
            />
          )}
          {item.type === 'audio' && (
            <div className="flex flex-col items-center gap-6 p-8 w-full max-w-lg">
              <Volume2 size={48} className="text-[var(--gold)] opacity-50" />
              <p className="text-xs text-[var(--text2)] font-mono text-center break-all">{item.filename}</p>
              <audio src={mediaFileUrl(item.id)} controls autoPlay className="w-full" />
            </div>
          )}
        </div>

        {/* Info sidebar */}
        <div className="w-52 shrink-0 bg-[var(--bg1)] rounded-xl p-4 flex flex-col gap-3 overflow-y-auto">
          <p className="text-xs text-[var(--text)] font-mono break-all leading-snug">{item.filename}</p>
          <div className="space-y-1.5 text-[11px]">
            <InfoRow label="Tipo"     val={item.type} />
            <InfoRow label="Sorgente" val={item.source} />
            <InfoRow label="Progetto" val={item.project_title !== '__library__' ? item.project_title : 'Libreria'} />
            {item.width > 0 && <InfoRow label="Dimensioni" val={`${item.width}×${item.height}`} />}
            {item.duration_sec && <InfoRow label="Durata" val={fmtDur(item.duration_sec)} />}
            <InfoRow label="Peso" val={fmtBytes(item.size_bytes)} />
          </div>
          {tags.length > 0 && (
            <div>
              <p className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1.5">Tag</p>
              <div className="flex flex-wrap gap-1">
                {tags.map(t => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--text2)]">{t}</span>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => onDownload(item)}
            className="mt-auto flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-[var(--bg3)] hover:bg-[var(--border)] text-xs text-[var(--text2)] hover:text-[var(--gold)] transition-colors"
          >
            <Download size={13} />
            Scarica
          </button>
        </div>

        {/* Nav arrows */}
        <button
          onClick={() => onNavigate(-1)}
          className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <button
          onClick={() => onNavigate(1)}
          className="absolute right-[220px] top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <ArrowRight size={18} />
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

function InfoRow({ label, val }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[var(--text3)] w-20 shrink-0">{label}</span>
      <span className="text-[var(--text2)] break-all">{val || '—'}</span>
    </div>
  )
}

// ── Assign panel ──────────────────────────────────────────────────────────────

function AssignPanel({ item, onClose, onDone }) {
  const [projects,  setProjects]  = useState([])
  const [shots,     setShots]     = useState([])
  const [projectId, setProjectId] = useState('')
  const [shotId,    setShotId]    = useState('')
  const [slot,      setSlot]      = useState('first_frame')
  const [loading,   setLoading]   = useState(false)
  const [result,    setResult]    = useState(null)

  // Determine available slot types based on media type
  const slotOptions = item?.type === 'video'
    ? [{ key: 'clip', label: 'Clip video' }]
    : item?.type === 'image'
    ? [{ key: 'first_frame', label: 'First Frame' }, { key: 'last_frame', label: 'Last Frame' }]
    : []

  useEffect(() => {
    fetch(`${API}/projects/`).then(r => r.json())
      .then(d => setProjects(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!projectId) { setShots([]); return }
    fetch(`${API}/media/shots/${projectId}`).then(r => r.json())
      .then(d => setShots(d.shots || []))
      .catch(() => setShots([]))
  }, [projectId])

  async function assign() {
    if (!projectId || !shotId || !slot) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`${API}/media/${item.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, shot_id: shotId, slot }),
      }).then(r => r.json())
      setResult(res)
      if (res.ok) setTimeout(onDone, 1500)
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[var(--bg1)] border border-[var(--border)] rounded-xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text)]">Usa nel progetto</h3>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]"><X size={14} /></button>
        </div>

        {/* File info */}
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-[var(--bg3)]">
          {item.type === 'image' ? <ImageIcon size={14} className="text-[var(--gold)] shrink-0" /> :
           item.type === 'video' ? <Film size={14} className="text-[var(--gold)] shrink-0" /> :
           <Music size={14} className="text-[var(--gold)] shrink-0" />}
          <span className="text-xs text-[var(--text)] truncate font-mono">{item.filename}</span>
        </div>

        <div className="space-y-3">
          {/* Project */}
          <div>
            <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Progetto</label>
            <select
              value={projectId}
              onChange={e => { setProjectId(e.target.value); setShotId('') }}
              className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
            >
              <option value="">Seleziona progetto...</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>

          {/* Slot */}
          {slotOptions.length > 0 && (
            <div>
              <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Slot</label>
              <div className="flex gap-1.5">
                {slotOptions.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setSlot(s.key)}
                    className={clsx(
                      'flex-1 py-1.5 text-xs rounded border transition-colors',
                      slot === s.key
                        ? 'border-[var(--gold)] bg-[var(--gold)]/10 text-[var(--gold)]'
                        : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)]/40'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Shot picker */}
          {projectId && (
            <div>
              <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Shot</label>
              {shots.length === 0 ? (
                <p className="text-xs text-[var(--text3)] py-2">Nessuno shot trovato — avvia prima la pipeline</p>
              ) : (
                <select
                  value={shotId}
                  onChange={e => setShotId(e.target.value)}
                  className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none max-h-24"
                >
                  <option value="">Seleziona shot...</option>
                  {shots.map(s => (
                    <option key={s.shot_id} value={s.shot_id}>
                      {s.shot_id} — {(s.scene_description || '').slice(0, 50)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {result && (
          <div className={clsx(
            'mt-3 px-3 py-2 rounded text-xs',
            result.ok
              ? 'bg-[var(--green)]/10 text-[var(--green)]'
              : 'bg-[var(--red)]/10 text-[var(--red)]'
          )}>
            {result.ok ? `✓ Assegnato a ${result.shot_id} (${result.slot})` : result.error}
          </div>
        )}

        <button
          onClick={assign}
          disabled={!projectId || !shotId || !slot || loading}
          className="w-full mt-4 flex items-center justify-center gap-2 py-2 text-xs rounded bg-[var(--gold)]/20 hover:bg-[var(--gold)]/30 text-[var(--gold)] disabled:opacity-40 transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
          {loading ? 'Assegnazione...' : 'Assegna'}
        </button>
      </div>
    </div>
  )
}

// ── Drop overlay ──────────────────────────────────────────────────────────────

function DropOverlay({ visible }) {
  if (!visible) return null
  return (
    <div className="absolute inset-0 z-30 bg-[var(--gold)]/10 border-2 border-dashed border-[var(--gold)] rounded-xl flex items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center gap-3">
        <Upload size={40} className="text-[var(--gold)]" />
        <p className="text-lg font-display text-[var(--gold)]">Rilascia per caricare</p>
        <p className="text-sm text-[var(--text2)]">Immagini · Video · Audio</p>
      </div>
    </div>
  )
}

// ── Storage stats bar ─────────────────────────────────────────────────────────

function StatsBar({ stats }) {
  if (!stats) return null
  return (
    <div className="flex items-center gap-5 px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg2)] text-[11px]">
      <StatItem label="Totale" val={stats.total} />
      <div className="w-px h-4 bg-[var(--border)]" />
      <StatItem label="Immagini" val={stats.images} Icon={ImageIcon} />
      <StatItem label="Video"    val={stats.videos} Icon={Film}      />
      <StatItem label="Audio"    val={stats.audios || 0} Icon={Music}  />
      <div className="w-px h-4 bg-[var(--border)] ml-auto" />
      <span className="text-[var(--gold)] font-mono">{stats.size_gb || '0'} GB usati</span>
    </div>
  )
}

function StatItem({ label, val, Icon }) {
  return (
    <div className="flex items-center gap-1.5">
      {Icon && <Icon size={11} className="text-[var(--text3)]" />}
      <span className="text-[var(--text2)] font-mono">{val}</span>
      <span className="text-[var(--text3)]">{label}</span>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

const MEDIA_TYPE_KEYS = new Set(['all', 'image', 'video', 'audio', 'characters'])

function mediaTypeFromSearch(params) {
  if (params.get('category') === 'characters') return 'characters'
  const t = params.get('type') || 'all'
  return MEDIA_TYPE_KEYS.has(t) ? t : 'all'
}

export default function MediaLibraryScreen() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [items,      setItems]      = useState([])
  const [stats,      setStats]      = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [typeFilter, setTypeFilter] = useState(() => mediaTypeFromSearch(searchParams))
  const [srcFilter,  setSrcFilter]  = useState('all')
  const [sort,       setSort]       = useState('date_desc')
  const [search,     setSearch]     = useState('')
  const [gridSize,   setGridSize]   = useState('md')
  const [dragging,   setDragging]   = useState(false)
  const [uploads,    setUploads]    = useState([])    // [{id, filename, status, error}]
  const [preview,    setPreview]    = useState(null)  // item
  const [ctxMenu,    setCtxMenu]    = useState(null)  // { x, y, item }
  const [assignItem, setAssignItem] = useState(null)
  const [page,       setPage]       = useState(1)
  const PER_PAGE = 60

  const dropRef  = useRef(null)
  const fileRef  = useRef(null)
  let   dragCounter = useRef(0)

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [itemsRes, statsRes] = await Promise.all([
        fetch(`${API}/media?limit=500${typeFilter === 'characters' ? '&category=characters' : ''}`).then(r => r.json()),
        fetch(`${API}/media/stats`).then(r => r.json()),
      ])
      setItems(Array.isArray(itemsRes) ? itemsRes : (itemsRes.items || []))
      setStats(statsRes)
    } catch { setItems([]) }
    setLoading(false)
  }, [typeFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    setTypeFilter(mediaTypeFromSearch(searchParams))
    setPage(1)
  }, [searchParams])

  function setMediaTypeFilter(key) {
    setTypeFilter(key)
    setPage(1)
    if (key === 'all') {
      setSearchParams({}, { replace: true })
    } else if (key === 'characters') {
      setSearchParams({ category: 'characters' }, { replace: true })
    } else {
      setSearchParams({ type: key }, { replace: true })
    }
  }

  // ── Filtering / sorting ─────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let arr = items
    if (typeFilter === 'characters') arr = arr.filter(i => i.source === 'character')
    else if (typeFilter !== 'all') arr = arr.filter(i => i.type === typeFilter)
    if (srcFilter  !== 'all') arr = arr.filter(i => (i.source || 'generated') === srcFilter)
    if (search) {
      const q = search.toLowerCase()
      arr = arr.filter(i =>
        i.filename.toLowerCase().includes(q) ||
        (i.project_title || '').toLowerCase().includes(q) ||
        (i.tags || '').toLowerCase().includes(q)
      )
    }
    return sortItems(arr, sort)
  }, [items, typeFilter, srcFilter, search, sort])

  const paginated = filtered.slice(0, page * PER_PAGE)
  const hasMore   = paginated.length < filtered.length

  // ── Scan & rescue ───────────────────────────────────────────────────────────

  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)

  async function handleScan() {
    setScanning(true)
    setScanResult(null)
    try {
      const res = await fetch(`${API}/media/scan`, { method: 'POST' }).then(r => r.json())
      setScanResult(res)
      if (res.registered > 0) load()
    } catch (e) {
      setScanResult({ error: e.message })
    } finally {
      setScanning(false)
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(id) {
    if (!confirm('Eliminare questo file dal database e dal disco?')) return
    await fetch(`${API}/media/${id}`, { method: 'DELETE' })
    setItems(prev => prev.filter(i => i.id !== id))
    if (preview?.id === id) setPreview(null)
  }

  async function handleDownload(item) {
    const res = await downloadMediaItem(item)
    if (res?.error && !res?.canceled) {
      console.error('[MediaLibrary] download failed', res.error)
    }
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadFiles(files) {
    const validFiles = Array.from(files).filter(f => {
      const t = fileType(f.type || f.name)
      return t !== null
    })
    if (!validFiles.length) return

    for (const file of validFiles) {
      const uploadId = Math.random().toString(36).slice(2)
      setUploads(prev => [...prev, { id: uploadId, filename: file.name, status: 'uploading' }])
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`${API}/media/upload`, { method: 'POST', body: fd }).then(r => r.json())
        if (res.id) {
          setItems(prev => [res, ...prev])
          setUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'done' } : u))
        } else {
          throw new Error(res.detail || 'Upload fallito')
        }
      } catch (e) {
        setUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'error', error: e.message } : u))
      } finally {
        setTimeout(() => setUploads(prev => prev.filter(u => u.id !== uploadId)), 4000)
      }
    }
    load() // refresh stats
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  function onDragEnter(e) {
    e.preventDefault()
    dragCounter.current++
    setDragging(true)
  }
  function onDragLeave(e) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragging(false)
  }
  function onDragOver(e) { e.preventDefault() }
  function onDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragging(false)
    uploadFiles(e.dataTransfer.files)
  }

  // ── Preview navigation ───────────────────────────────────────────────────────

  function navigatePreview(delta) {
    if (!preview) return
    const idx = filtered.findIndex(i => i.id === preview.id)
    const next = filtered[(idx + delta + filtered.length) % filtered.length]
    if (next) setPreview(next)
  }

  function handleImageContextMenu(e, item) {
    if (item.type !== 'image' || !item.filepath) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, item })
  }

  function goAnimateFromMedia(item) {
    const source = imageSourceFromMediaItem(item)
    if (!source) return
    setPendingImg2Video(source)
    setPreview(null)
    setCtxMenu(null)
    navigate('/tools', { state: { img2videoSource: source } })
  }

  // ── Type counts ──────────────────────────────────────────────────────────────

  const counts = useMemo(() => ({
    all:   items.length,
    image: items.filter(i => i.type === 'image').length,
    video: items.filter(i => i.type === 'video').length,
    audio: items.filter(i => i.type === 'audio').length,
    characters: items.filter(i => i.source === 'character').length,
  }), [items])

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-5 h-full flex flex-col overflow-hidden relative"
      ref={dropRef}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DropOverlay visible={dragging} />

      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <ImageIcon size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Media Library</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="p-1.5 rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--gold)] hover:border-[var(--gold)]/40 transition-colors"
            title="Aggiorna"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] hover:border-[var(--gold)]/40 transition-colors"
            title="Scansiona cartelle progetto e registra media già generati ma non ancora indicizzati"
          >
            <RefreshCw size={13} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scansione...' : 'Recupera media'}
          </button>
          {scanResult && !scanResult.error && (
            <span className="text-xs text-[var(--text3)]">
              +{scanResult.registered} registrati
            </span>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded bg-[var(--gold)]/15 hover:bg-[var(--gold)]/25 text-[var(--gold)] transition-colors"
          >
            <Upload size={13} /> Carica file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_TYPES}
            multiple
            className="hidden"
            onChange={e => { uploadFiles(e.target.files); e.target.value = '' }}
          />
        </div>
      </div>

      {/* Stats bar */}
      <div className="mb-4 shrink-0">
        <StatsBar stats={stats} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 shrink-0 flex-wrap gap-y-2">
        {/* Type tabs */}
        <div className="flex gap-0.5 bg-[var(--bg2)] rounded-lg p-0.5 border border-[var(--border)]">
          {TYPE_TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setMediaTypeFilter(key)}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors',
                typeFilter === key
                  ? 'bg-[var(--gold)] text-black font-medium'
                  : 'text-[var(--text2)] hover:text-[var(--text)]'
              )}
            >
              <Icon size={11} />
              {label}
              <span className={clsx(
                'text-[9px] font-mono',
                typeFilter === key ? 'opacity-70' : 'text-[var(--text3)]'
              )}>
                {counts[key]}
              </span>
            </button>
          ))}
        </div>

        {/* Source filter */}
        <select
          value={srcFilter}
          onChange={e => { setSrcFilter(e.target.value); setPage(1) }}
          className="bg-[var(--bg2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
        >
          {SOURCE_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-32 max-w-60">
          <Search size={11} className="absolute left-2.5 top-2 text-[var(--text3)]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Cerca file, progetto, tag..."
            className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded pl-7 pr-3 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none font-mono"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-2 text-[var(--text3)] hover:text-[var(--text)]">
              <X size={11} />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Sort */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="bg-[var(--bg2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
          >
            {SORT_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>

          {/* Grid size */}
          <div className="flex gap-0.5 bg-[var(--bg2)] rounded border border-[var(--border)] p-0.5">
            {GRID_SIZES.map(s => (
              <button
                key={s}
                onClick={() => setGridSize(s)}
                className={clsx(
                  'px-2 py-1 rounded text-[10px] transition-colors',
                  gridSize === s ? 'bg-[var(--bg3)] text-[var(--text)]' : 'text-[var(--text3)] hover:text-[var(--text2)]'
                )}
              >
                {s === 'sm' ? 'S' : s === 'md' ? 'M' : 'L'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results count */}
      <div className="text-[11px] text-[var(--text3)] mb-3 shrink-0">
        {loading ? 'Caricamento...' : `${filtered.length} file ${search ? `per "${search}"` : ''}`}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto pr-1 relative min-h-[300px]">
        {loading && items.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0a0a0f]/60 backdrop-blur-sm z-30 rounded-xl">
            <ElegantLoader message="Caricamento della galleria multimediale in corso..." />
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ImageIcon size={48} className="text-[var(--text3)] opacity-20 mb-4" />
            <p className="text-[var(--text3)] text-sm mb-2">Nessun file trovato</p>
            <p className="text-[var(--text3)] text-xs opacity-60">
              Trascina file qui o usa "Carica file" per aggiungere media
            </p>
          </div>
        )}

        {paginated.length > 0 && (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: GRID_TEMPLATE[gridSize] }}
          >
            {paginated.map(item => (
              <MediaCard
                key={item.id}
                item={item}
                thumbSize={gridSize}
                onDelete={handleDelete}
                onPreview={setPreview}
                onAssign={setAssignItem}
                onDownload={handleDownload}
                onImageContextMenu={handleImageContextMenu}
                onOpenCharacter={(mediaItem) => {
                  const charId = String(mediaItem.project_id || '').replace('character:', '')
                  if (charId) navigate(`/characters/${charId}`)
                }}
                onUseCharacter={(mediaItem) => {
                  const charId = String(mediaItem.project_id || '').replace('character:', '')
                  if (charId) {
                    navigate('/createreel', { state: { characterId: charId, characterMode: 'character' } })
                  }
                }}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <button
            onClick={() => setPage(p => p + 1)}
            className="w-full mt-4 py-2 text-xs text-[var(--text3)] hover:text-[var(--gold)] border border-[var(--border)] rounded-lg transition-colors"
          >
            Carica altri ({filtered.length - paginated.length})
          </button>
        )}
      </div>

      {/* Drag hint */}
      {!dragging && items.length === 0 && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 opacity-20">
            <Upload size={48} className="text-[var(--text3)]" />
            <p className="text-[var(--text3)]">Trascina file qui per iniziare</p>
          </div>
        </div>
      )}

      {/* Modals */}
      {preview && preview.type === 'image' && (
        <ImageLightbox
          open={true}
          onClose={() => setPreview(null)}
          items={filtered
            .filter(i => i.type === 'image')
            .map(i => ({
              id: i.id,
              src: mediaFileUrl(i.id),
              alt: i.filename,
              type: 'image',
            }))}
          initialIndex={Math.max(
            0,
            filtered.filter(i => i.type === 'image').findIndex(i => i.id === preview.id),
          )}
        />
      )}
      {preview && preview.type !== 'image' && (
        <PreviewModal
          item={preview}
          allItems={filtered}
          onClose={() => setPreview(null)}
          onNavigate={navigatePreview}
          onDownload={handleDownload}
        />
      )}
      {assignItem && (
        <AssignPanel
          item={assignItem}
          onClose={() => setAssignItem(null)}
          onDone={() => setAssignItem(null)}
        />
      )}

      {/* Upload toasts */}
      <UploadToasts uploads={uploads} />

      {ctxMenu && (
        <MediaImageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onAnimate={() => goAnimateFromMedia(ctxMenu.item)}
        />
      )}
    </div>
  )
}
