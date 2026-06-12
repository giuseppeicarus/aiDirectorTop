import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Image, Film, Music, Wand2, Sparkles, Download,
  Upload, FolderOpen, X, Play, Loader2, AlertTriangle,
  ChevronDown, ZoomIn, Maximize2, Minimize2, Trash2,
} from 'lucide-react'
import ImageLightbox from '../components/ImageLightbox'
import MediaImageContextMenu from '../components/MediaImageContextMenu'
import clsx from 'clsx'
import { BACKEND_ORIGIN, resolveBackendUrl, mediaThumbUrl } from '../utils/mediaUrl'
import {
  consumePendingImg2Video,
  imageSourceFromMediaItem,
  setPendingImg2Video,
} from '../utils/toolsAnimate'
import {
  buildToolsSourceFromMediaRecord,
  normalizeMediaList,
  mediaItemType,
  uploadBrowserFileToToolsMedia,
  uploadDiskFileToToolsMedia,
} from '../utils/toolsMediaSource'
import {
  normalizeUnifiedPrompt,
  splitPositiveAndNegative,
} from '../utils/promptEnhance'
import { useToolsJobStore } from '../stores/toolsJobStore'

// ── Module-level queue state (survives navigation) ────────────────────────────
const _runningRef      = { current: false }
const _queueRef        = { current: [] }
const _queueEpochRef   = { current: 0 }
const _cancelledJobIds = { current: new Set() }

// ── Constants ─────────────────────────────────────────────────────────────────

const TOOLS = [
  { id: 'txt2img',         label: 'Text → Image',          Icon: Image,  needsImage: false, needsAudio: false, isVideo: false },
  { id: 'txt2video',       label: 'Text → Video',          Icon: Film,   needsImage: false, needsAudio: false, isVideo: true  },
  { id: 'img2video',       label: 'Image → Video',         Icon: Play,   needsImage: true,  needsAudio: false, isVideo: true  },
  { id: 'img_audio2video', label: 'Image + Audio → Video', Icon: Music,  needsImage: true,  needsAudio: true,  isVideo: true  },
  { id: 'img2img',         label: 'Image → Image',         Icon: Image,  needsImage: true,  needsAudio: false, isVideo: false },
]

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '21:9', '4:3']

const RESOLUTIONS_BY_RATIO = {
  '16:9': [
    { w: 640,  h: 360,  label: '640×360',   badge: null   },
    { w: 1280, h: 720,  label: '1280×720',  badge: 'HD'   },
    { w: 1920, h: 1080, label: '1920×1080', badge: 'FHD'  },
    { w: 2560, h: 1440, label: '2560×1440', badge: 'QHD'  },
    { w: 3840, h: 2160, label: '3840×2160', badge: '4K'   },
  ],
  '9:16': [
    { w: 360,  h: 640,  label: '360×640',   badge: null   },
    { w: 720,  h: 1280, label: '720×1280',  badge: 'HD'   },
    { w: 1080, h: 1920, label: '1080×1920', badge: 'FHD'  },
    { w: 1440, h: 2560, label: '1440×2560', badge: 'QHD'  },
    { w: 2160, h: 3840, label: '2160×3840', badge: '4K'   },
  ],
  '1:1': [
    { w: 512,  h: 512,  label: '512×512',   badge: null   },
    { w: 768,  h: 768,  label: '768×768',   badge: null   },
    { w: 1024, h: 1024, label: '1024×1024', badge: 'HD'   },
    { w: 1536, h: 1536, label: '1536×1536', badge: '1.5K' },
    { w: 2048, h: 2048, label: '2048×2048', badge: '2K'   },
    { w: 4096, h: 4096, label: '4096×4096', badge: '4K'   },
  ],
  '21:9': [
    { w: 840,  h: 360,  label: '840×360',   badge: null   },
    { w: 1344, h: 576,  label: '1344×576',  badge: 'HD'   },
    { w: 2520, h: 1080, label: '2520×1080', badge: 'FHD'  },
    { w: 3360, h: 1440, label: '3360×1440', badge: 'QHD'  },
    { w: 5040, h: 2160, label: '5040×2160', badge: '4K'   },
  ],
  '4:3': [
    { w: 640,  h: 480,  label: '640×480',   badge: null   },
    { w: 1024, h: 768,  label: '1024×768',  badge: 'XGA'  },
    { w: 1600, h: 1200, label: '1600×1200', badge: 'UXGA' },
    { w: 2048, h: 1536, label: '2048×1536', badge: '2K'   },
    { w: 4096, h: 3072, label: '4096×3072', badge: '4K'   },
  ],
}

const DEFAULT_RES = { '16:9': 1, '9:16': 1, '1:1': 2, '21:9': 1, '4:3': 1 }

const QUALITY_OPTS = [
  { id: 'low',   label: 'Low',   desc: '15 steps — rapido' },
  { id: 'medium',label: 'Med',   desc: '25 steps — bilanciato' },
  { id: 'high',  label: 'High',  desc: '40 steps — qualità' },
  { id: 'ultra', label: 'Ultra', desc: '60 steps — massima' },
]

const FPS_OPTS  = [8, 12, 16, 24, 25, 30]
const DUR_OPTS  = [2, 3, 4, 6, 8, 10, 12, 16]

// Which workflow types are compatible with each tool
const TOOL_WORKFLOW_TYPES = {
  txt2img:         ['txt2img'],
  txt2video:       ['txt2video'],
  img2video:       ['img2video', 'img2video_lastframe'],
  img_audio2video: ['img_audio2video', 'img_audio2video_lastframe'],
  img2img:         ['img2img'],
}

// ── CompactSelect ─────────────────────────────────────────────────────────────

function CompactSelect({ label, displayValue, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className={clsx(
          'flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors whitespace-nowrap',
          open
            ? 'border-[var(--gold)] bg-[var(--gold)]/12 text-[var(--gold)]'
            : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--border2)] hover:text-[var(--text)]'
        )}
      >
        <span className="text-[9px] text-[var(--text3)] uppercase tracking-wide mr-0.5">{label}</span>
        {displayValue}
        <ChevronDown size={9} className={clsx('ml-0.5 transition-transform duration-150', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-1.5 left-0 z-50 rounded-xl border border-[var(--border2)] bg-[var(--bg1)] shadow-2xl p-1.5 min-w-[140px]"
             onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  )
}

function SelectOption({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-mono text-left transition-colors',
        active ? 'bg-[var(--gold)]/15 text-[var(--gold)]' : 'text-[var(--text2)] hover:bg-[var(--bg3)]'
      )}
    >
      {children}
    </button>
  )
}

// ── JobCard ───────────────────────────────────────────────────────────────────

function jobPreviewSrc(result) {
  if (!result) return null
  if (result.preview_url) return resolveBackendUrl(result.preview_url)
  if (result.media_id) return resolveBackendUrl(`/api/media/file/${result.media_id}`)
  if (result.filename) return resolveBackendUrl(`/api/tools/output/${result.filename}`)
  return null
}

function JobCard({ job, selected, onSelect, onOpenPreview }) {
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => { setPreviewFailed(false) }, [job.id, job.result?.preview_url, job.result?.filename])
  const src = previewFailed ? null : jobPreviewSrc(job.result)
  const ratio = job.resolution ? `${job.resolution.w}/${job.resolution.h}` : '16/9'
  const canPreview = job.status === 'done' && src

  return (
    <div
      className={clsx(
        'group relative rounded-xl overflow-hidden border cursor-pointer transition-all',
        selected
          ? 'border-[var(--gold)] ring-1 ring-[var(--gold)]/30'
          : 'border-[var(--border)] hover:border-[var(--border2)]'
      )}
      style={{ aspectRatio: ratio }}
      onClick={() => onSelect(job)}
    >
      {/* Loading / queued */}
      {job.status === 'queued' && (
        <div className="absolute inset-0 bg-[var(--bg2)] flex flex-col items-center justify-center gap-2">
          <div className="w-6 h-6 rounded-full border-2 border-[var(--border2)] border-t-[var(--gold)] animate-spin" />
          <p className="text-[9px] text-[var(--text3)] font-mono">In coda…</p>
        </div>
      )}

      {job.status === 'running' && (
        <div className="absolute inset-0 bg-[var(--bg2)] flex flex-col items-center justify-center gap-3 p-4">
          <Loader2 size={20} className="animate-spin text-[var(--gold)]/70" />
          <div className="w-full">
            <div className="h-1 rounded-full bg-[var(--bg3)] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-150"
                style={{
                  width: `${Math.max(3, (job.progress || 0) * 100)}%`,
                  background: 'linear-gradient(90deg, var(--gold), var(--gold2))',
                }}
              />
            </div>
            <p className="text-[9px] text-[var(--text3)] font-mono mt-1 text-center truncate">
              {job.progressMsg || 'Elaborazione…'}
            </p>
            {job.comfyuiPct != null && job.comfyuiPct > 0 && (
              <p className="text-[8px] text-[var(--gold)] font-mono mt-0.5 text-center">
                Sampling {job.comfyuiPct}%
              </p>
            )}
          </div>
        </div>
      )}

      {job.status === 'cancelled' && (
        <div className="absolute inset-0 bg-[var(--bg2)] flex flex-col items-center justify-center gap-2 p-3">
          <X size={18} className="text-[var(--text3)]" />
          <p className="text-[9px] text-[var(--text3)] text-center font-mono">Cancellata</p>
        </div>
      )}

      {/* Error */}
      {job.status === 'error' && (
        <div className="absolute inset-0 bg-red-950/40 flex flex-col items-center justify-center gap-2 p-3">
          <AlertTriangle size={18} className="text-red-400" />
          <p className="text-[9px] text-red-400 text-center line-clamp-3 font-mono">{job.error}</p>
        </div>
      )}

      {/* Result — click apre galleria fullscreen */}
      {canPreview && (
        job.result.type === 'image'
          ? (
            <img
              src={src}
              alt=""
              className="w-full h-full object-cover cursor-zoom-in"
              onError={() => setPreviewFailed(true)}
              onClick={(e) => { e.stopPropagation(); onOpenPreview?.(job) }}
            />
          ) : (
            <video
              src={src}
              className="w-full h-full object-cover cursor-pointer"
              onError={() => setPreviewFailed(true)}
              onClick={(e) => { e.stopPropagation(); onOpenPreview?.(job) }}
            />
          )
      )}
      {canPreview && (
        <button
          type="button"
          title="Schermo intero"
          onClick={(e) => { e.stopPropagation(); onOpenPreview?.(job) }}
          className="absolute bottom-1.5 right-1.5 z-20 p-1.5 rounded-md bg-black/55 text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/75 transition-opacity pointer-events-auto"
        >
          <ZoomIn size={12} />
        </button>
      )}
      {job.status === 'done' && (!src || previewFailed) && job.result?.path && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 bg-[var(--bg2)]">
          <Image size={16} className="text-[var(--text3)]" />
          <p className="text-[9px] text-[var(--text3)] text-center font-mono">Anteprima non caricata</p>
        </div>
      )}

      {/* Tool badge */}
      <div className="absolute top-1.5 left-1.5 text-[9px] px-1.5 py-0.5 rounded font-mono bg-black/60 text-white/60">
        {job.tool}
      </div>

      {/* Download on hover (done only) — non blocca il pulsante lente */}
      {job.status === 'done' && src && (
        <div className="absolute inset-0 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 flex items-start justify-end p-1.5 pointer-events-none">
          <a
            href={src}
            download={job.result?.filename}
            onClick={e => e.stopPropagation()}
            className="w-7 h-7 rounded-md bg-white/10 hover:bg-white/20 flex items-center justify-center pointer-events-auto"
          >
            <Download size={11} className="text-white" />
          </a>
        </div>
      )}
    </div>
  )
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

// ── MediaCard (for all-media view from library) ───────────────────────────────

function MediaCard({ item, selected, onSelect, onOpenPreview, onImageContextMenu,
  onAnimate, onAnimateAudio, onUseAsRef, hasAudio, hasImg2img }) {
  const src = resolveBackendUrl(`/api/media/file/${item.id}`)
  const isImage = item.media_type === 'image' || item.type === 'image'

  return (
    <div
      className={clsx(
        'group relative rounded-xl overflow-hidden border cursor-pointer transition-all aspect-video',
        selected ? 'border-[var(--gold)] ring-1 ring-[var(--gold)]/30' : 'border-[var(--border)] hover:border-[var(--border2)]'
      )}
      onClick={() => onSelect(item)}
      onContextMenu={isImage ? (e) => onImageContextMenu?.(e, item) : undefined}
    >
      {/* Media content */}
      {isImage
        ? (
          <img
            src={src}
            alt=""
            className="w-full h-full object-cover cursor-zoom-in"
            onClick={(e) => { e.stopPropagation(); onOpenPreview?.(item) }}
          />
        ) : (
          <video
            src={src}
            className="w-full h-full object-cover cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onOpenPreview?.(item) }}
          />
        )}

      {/* Dark scrim on hover */}
      <div className="absolute inset-0 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-black/40 pointer-events-none" />

      {/* Top-left badges: resolution + project tag */}
      <div className="absolute top-1.5 left-1.5 z-20 flex flex-col gap-0.5 items-start pointer-events-none">
        {(() => { const r = resolutionLabel(item.width, item.height); return r ? (
          <span className={clsx('text-[8px] px-1.5 py-[1px] rounded font-mono font-semibold border tracking-wide', r.cls)}>
            {r.label}
          </span>
        ) : null })()}
        <span className="text-[9px] px-1.5 py-0.5 rounded font-mono bg-black/60 text-white/60">
          {item.project_title || 'tools'}
        </span>
      </div>

      {/* Top-right controls — zoom + download */}
      <div className="absolute top-1.5 right-1.5 z-20 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          title="Schermo intero"
          onClick={(e) => { e.stopPropagation(); onOpenPreview?.(item) }}
          className="w-6 h-6 rounded-md bg-black/60 text-white/80 hover:bg-black/80 flex items-center justify-center"
        >
          <ZoomIn size={11} />
        </button>
        <a
          href={src}
          download={item.filename}
          onClick={e => e.stopPropagation()}
          className="w-6 h-6 rounded-md bg-black/60 text-white/80 hover:bg-black/80 flex items-center justify-center"
        >
          <Download size={11} />
        </a>
      </div>

      {/* Action bar — bottom, images only */}
      {isImage && (
        <div className="absolute bottom-0 left-0 right-0 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="flex items-stretch bg-black/80 backdrop-blur-sm border-t border-white/10">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAnimate?.(item) }}
              className="flex-1 py-1.5 text-[10px] text-white/75 hover:text-white hover:bg-white/10 transition-colors text-center leading-none"
            >
              Anima video
            </button>
            {hasAudio && (
              <>
                <div className="w-px bg-white/15 self-stretch" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onAnimateAudio?.(item) }}
                  className="flex-1 py-1.5 text-[10px] text-[var(--gold)]/80 hover:text-[var(--gold)] hover:bg-[var(--gold)]/10 transition-colors text-center leading-none"
                >
                  Anima+audio
                </button>
              </>
            )}
            {hasImg2img && (
              <>
                <div className="w-px bg-white/15 self-stretch" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onUseAsRef?.(item) }}
                  className="flex-1 py-1.5 text-[10px] text-blue-300/80 hover:text-blue-300 hover:bg-blue-500/10 transition-colors text-center leading-none"
                >
                  Referenza img
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Detail sidebar ────────────────────────────────────────────────────────────

function MetaRow({ label, value }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 border-b border-[var(--border)]/40">
      <span className="text-[10px] text-[var(--text3)] shrink-0">{label}</span>
      <span className="text-[10px] text-[var(--text)] font-mono text-right break-all">{value}</span>
    </div>
  )
}

function DetailSidebar({ job, libraryItem, onClose, onOpenPreview }) {
  const isJob = !!job
  const src = isJob
    ? jobPreviewSrc(job.result)
    : (libraryItem ? resolveBackendUrl(`/api/media/file/${libraryItem.id}`) : null)

  const mediaType = isJob ? job.result?.type : (libraryItem?.media_type || libraryItem?.type)
  const tool = isJob ? TOOLS.find(t => t.id === job?.tool) : null

  if (!isJob && !libraryItem) return null

  return (
    <div className="w-[272px] shrink-0 border-l border-[var(--border)] bg-[var(--bg1)] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
        <span className="text-xs font-semibold text-[var(--text2)]">Dettagli</span>
        <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]">
          <X size={14} />
        </button>
      </div>

      {/* Preview */}
      <div className="shrink-0 p-3 bg-black/20">
        {src ? (
          mediaType === 'image' || mediaType === 'IMG'
            ? (
              <button
                type="button"
                className="w-full rounded-lg overflow-hidden cursor-zoom-in group/prev relative"
                onClick={() => onOpenPreview?.(isJob ? job : libraryItem)}
              >
                <img src={src} className="w-full object-contain max-h-44" alt="" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover/prev:bg-black/30 transition-colors">
                  <ZoomIn size={20} className="text-white opacity-0 group-hover/prev:opacity-100" />
                </span>
              </button>
            )
            : <video src={src} controls className="w-full rounded-lg max-h-44" />
        ) : job?.status === 'running' ? (
          <div className="w-full h-28 rounded-lg bg-[var(--bg2)] flex flex-col items-center justify-center gap-2">
            <Loader2 size={18} className="animate-spin text-[var(--gold)]/60" />
            <div className="w-3/4 h-0.5 rounded-full bg-[var(--bg3)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--gold)] transition-all duration-150"
                   style={{ width: `${Math.max(3, (job.progress || 0) * 100)}%` }} />
            </div>
          </div>
        ) : (
          <div className="w-full h-28 rounded-lg bg-[var(--bg2)] flex items-center justify-center">
            <Wand2 size={20} className="text-[var(--text3)] opacity-30" />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Properties */}
        <div>
          <p className="text-[9px] text-[var(--text3)] uppercase tracking-widest mb-1.5">Proprietà</p>
          <div>
            {isJob ? (
              <>
                <MetaRow label="Tool" value={tool?.label || job.tool} />
                {job.resolution && <MetaRow label="Risoluzione" value={`${job.resolution.w}×${job.resolution.h}`} />}
                {job.resolution?.badge && <MetaRow label="Preset" value={job.resolution.badge} />}
                <MetaRow label="Aspect Ratio" value={job.aspectRatio || '—'} />
                <MetaRow label="Qualità AI" value={QUALITY_OPTS.find(q => q.id === job.quality)?.label || job.quality || '—'} />
                {job.tool !== 'txt2img' && <MetaRow label="FPS" value={`${job.fps} fps`} />}
                {job.tool !== 'txt2img' && <MetaRow label="Durata" value={`${job.duration}s`} />}
                {job.workflowId && <MetaRow label="Workflow" value={job.workflowId} />}
                <MetaRow label="Ora" value={job.time || '—'} />
                {job.result?.type && <MetaRow label="Tipo file" value={job.result.type} />}
              </>
            ) : (
              <>
                <MetaRow label="File" value={libraryItem.filename} />
                <MetaRow label="Tipo" value={libraryItem.media_type} />
                {libraryItem.width > 0 && <MetaRow label="Risoluzione" value={`${libraryItem.width}×${libraryItem.height}`} />}
                {libraryItem.size_bytes > 0 && <MetaRow label="Dimensione" value={`${(libraryItem.size_bytes / 1024 / 1024).toFixed(1)} MB`} />}
                <MetaRow label="Progetto" value={libraryItem.project_title || '—'} />
                <MetaRow label="Sorgente" value={libraryItem.source || '—'} />
              </>
            )}
          </div>
        </div>

        {/* Prompt / caption */}
        {(isJob ? job.prompt : null) && (
          <div>
            <p className="text-[9px] text-[var(--text3)] uppercase tracking-widest mb-1.5">Prompt</p>
            <p className="text-[10px] text-[var(--text2)] leading-relaxed font-mono bg-[var(--bg3)] rounded-lg p-2.5">
              {job.prompt}
            </p>
          </div>
        )}


        {/* Download */}
        {src && (
          <a href={src} download={isJob ? job.result?.filename : libraryItem?.filename}
             className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-[var(--bg3)] hover:bg-[var(--border)] text-xs text-[var(--text2)] transition-colors">
            <Download size={13} /> Scarica
          </a>
        )}
      </div>
    </div>
  )
}

// ── MediaPickerModal ──────────────────────────────────────────────────────────

function MediaPickerModal({ onSelect, onClose, type = 'image' }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const loadMedia = window.studio?.tools?.media
      ? window.studio.tools.media()
      : fetch(`${BACKEND_ORIGIN}/api/media/?limit=500`).then(r => r.ok ? r.json() : [])
    loadMedia
      .then((data) => {
        const list = normalizeMediaList(data)
        const want = type === 'image' ? 'image' : 'audio'
        setItems(list.filter(m => mediaItemType(m) === want))
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false))
  }, [type])

  const modal = (
    <div
      className="fixed inset-0 z-[10050] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative w-full max-w-[600px] max-h-[70vh] rounded-2xl border border-[var(--border2)] bg-[var(--bg1)] flex flex-col overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
          <span className="text-sm font-semibold text-[var(--text)]">
            Scegli {type === 'image' ? 'immagine' : 'audio'} da Media Library
          </span>
          <button type="button" onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 min-h-0">
          {loading ? (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin text-[var(--text3)]" />
            </div>
          ) : items.length === 0 ? (
            <p className="text-center py-8 text-[var(--text3)] text-sm">Nessun elemento nella libreria</p>
          ) : (
            <div className={type === 'image' ? 'grid grid-cols-4 gap-2' : 'space-y-1'}>
              {items.map(item => {
                const src = buildToolsSourceFromMediaRecord(item)
                return type === 'image' ? (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(src)}
                    className="aspect-square rounded-lg overflow-hidden border border-[var(--border)] hover:border-[var(--gold)] transition-colors"
                  >
                    <img
                      src={mediaThumbUrl(item.id) || resolveBackendUrl(`/api/media/file/${item.id}`)}
                      alt={item.filename}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(src)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] hover:border-[var(--gold)] text-left text-xs text-[var(--text2)] w-full"
                  >
                    <Music size={12} className="text-[var(--gold)] shrink-0" />
                    <span className="truncate">{item.filename}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal
}

// ── SourceThumb ───────────────────────────────────────────────────────────────

function SourceThumb({ source, label, onPickFile, onPickMedia, onDropPath, onClear, mediaType = 'image', uploading = false }) {
  const [showPicker, setShowPicker] = useState(false)
  const fileInputRef = useRef(null)
  const accept = mediaType === 'image'
    ? 'image/png,image/jpeg,image/webp,image/bmp'
    : 'audio/mpeg,audio/wav,audio/mp4,audio/flac,audio/ogg,audio/aac'

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer.files[0]
    if (!file) return
    const p = file.path
    if (p && onDropPath) onDropPath(p, file.name)
    else onPickFile?.(file)
  }, [onPickFile, onDropPath])

  function openFilePicker(e) {
    e.stopPropagation()
    const hasNativePicker = mediaType === 'image'
      ? typeof window.studio?.tools?.pickImage === 'function'
      : typeof window.studio?.tools?.pickAudio === 'function'
    if (hasNativePicker) onPickFile?.()
    else fileInputRef.current?.click()
  }

  function handleFileInput(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPickFile?.(file)
  }

  return (
    <>
      <div
        className={clsx(
          'relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors select-none min-w-[120px] h-full overflow-hidden',
          source ? 'border-[var(--gold)]/50 bg-[var(--gold)]/5' : 'border-[var(--border2)] hover:border-[var(--gold)]/30',
          uploading && 'pointer-events-none opacity-70'
        )}
        onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
        onDrop={handleDrop}
        style={{ minHeight: 96 }}
      >
        {uploading && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1 bg-[var(--bg1)]/85 rounded-xl">
            <Loader2 size={16} className="animate-spin text-[var(--gold)]" />
            <span className="text-[9px] text-[var(--text3)] font-mono">Caricamento…</span>
          </div>
        )}

        {source ? (
          <>
            {mediaType === 'image' ? (
              source.preview ? (
                <img src={source.preview} alt="source" className="absolute inset-0 w-full h-full object-cover rounded-xl" />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center p-2">
                  <Image size={18} className="text-[var(--text3)]" />
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center gap-1 p-3 w-full h-full">
                {source.preview ? (
                  <audio src={source.preview} controls className="w-full max-w-[140px]" />
                ) : (
                  <Music size={18} className="text-[var(--gold)]" />
                )}
                <span className="text-[9px] text-[var(--text2)] text-center font-mono break-all line-clamp-2">{source.name}</span>
              </div>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClear?.() }}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 flex items-center justify-center z-10 hover:bg-red-600/80"
            >
              <X size={9} className="text-white" />
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2 p-3 text-center w-full">
            {mediaType === 'image' ? <Image size={18} className="text-[var(--text3)]" /> : <Music size={18} className="text-[var(--text3)]" />}
            <span className="text-[9px] text-[var(--text3)] leading-tight">{label}</span>
            <div className="flex flex-col gap-1 w-full">
              <button
                type="button"
                onClick={openFilePicker}
                className="flex items-center justify-center gap-1 text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)]"
              >
                <Upload size={8} /> Disco
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={accept}
                className="hidden"
                onChange={handleFileInput}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowPicker(true) }}
                className="flex items-center justify-center gap-1 text-[9px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)]"
              >
                <FolderOpen size={8} /> Libreria
              </button>
            </div>
          </div>
        )}
      </div>

      {showPicker && (
        <MediaPickerModal
          type={mediaType}
          onSelect={(s) => { if (s) onPickMedia?.(s); setShowPicker(false) }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ToolsScreen() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const toolFromUrl = searchParams.get('tool')
  const initialTool = TOOLS.some(t => t.id === toolFromUrl) ? toolFromUrl : 'txt2img'
  const [activeTool, setActiveTool]   = useState(initialTool)
  const [prompt, setPrompt]           = useState(() => {
    try { return localStorage.getItem(`cinematic:tools:prompt:${initialTool}`) || '' }
    catch { return '' }
  })
  const [aspectRatio, setAspectRatio] = useState('16:9')
  const [resolution, setResolution]   = useState(RESOLUTIONS_BY_RATIO['16:9'][1])
  const [quality, setQuality]         = useState('medium')
  const [fps, setFps]                 = useState(24)
  const [duration, setDuration]       = useState(6)
  const [imageSource, setImageSource] = useState(null)
  const [audioSource, setAudioSource] = useState(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadingAudio, setUploadingAudio] = useState(false)

  // Queue system — jobs live in a persistent Zustand store so they survive navigation
  const jobs        = useToolsJobStore(s => s.jobs)
  const storeAddJob = useToolsJobStore(s => s.addJob)
  const storeUpdate = useToolsJobStore(s => s.updateJob)

  // Aliases to module-level queue refs (no useState — they must not reset on mount)
  const runningRef        = _runningRef
  const queueRef          = _queueRef
  const queueEpochRef     = _queueEpochRef
  const cancelledJobIdsRef = _cancelledJobIds

  // Detail sidebar — selectedJobId is local (fine: it's just a selection)
  const [selectedJobId, setSelectedJobId]     = useState(null)
  const [selectedLibItem, setSelectedLibItem] = useState(null)

  const selectedJob = useMemo(
    () => jobs.find(j => j.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  )

  // Media switch
  const [showAllMedia, setShowAllMedia]   = useState(false)
  const [allMedia, setAllMedia]           = useState([])
  const [loadingLib, setLoadingLib]       = useState(false)

  // Prompt expand / auto-resize
  const [promptExpanded, setPromptExpanded] = useState(false)
  const textareaRef                         = useRef(null)
  const expandedTextareaRef                 = useRef(null)
  // Tracks current tool for localStorage save (avoids stale closure in save effect)
  const activeToolRef                       = useRef(initialTool)

  // Enhance overlay progress
  const [enhancing, setEnhancing]         = useState(false)
  const [enhancePct, setEnhancePct]       = useState(0)

  const [error, setError]                 = useState(null)
  const [lightbox, setLightbox]           = useState(null) // { items, index }
  const [apiReady, setApiReady]           = useState(false)
  const [workflows, setWorkflows]         = useState([])
  const [workflowId, setWorkflowId]       = useState(null)
  const [ctxMenu, setCtxMenu]               = useState(null)

  const tool = TOOLS.find(t => t.id === activeTool)

  useEffect(() => {
    const t = searchParams.get('tool')
    if (t && TOOLS.some(x => x.id === t) && t !== activeTool) {
      setActiveTool(t)
    }
  }, [searchParams, activeTool])

  // ── Init ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const fromState = location.state?.img2videoSource
    const pending = fromState || consumePendingImg2Video()
    if (!pending?.path) return

    setActiveTool('img2video')
    const src = pending.mediaId
      ? buildToolsSourceFromMediaRecord({
          id: pending.mediaId,
          filepath: pending.path,
          filename: pending.name,
          type: 'image',
        })
      : {
          path: pending.path,
          name: pending.name || pending.path.split(/[\\/]/).pop(),
          preview: pending.preview,
          mediaId: pending.mediaId,
        }
    if (pending.preview && src) src.preview = pending.preview
    setImageSource(src)
    setShowAllMedia(false)
    setError(null)

    if (fromState) {
      navigate('/tools', { replace: true, state: {} })
    }
  }, [location.state, navigate])

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }

    let attempts = 0
    const MAX = 15
    let timer = null

    async function checkBackend() {
      try {
        const r = await fetch(`${BACKEND_ORIGIN}/api/tools/workflows`)
        if (r.ok) {
          const data = await r.json()
          setWorkflows(Array.isArray(data) ? data : [])
          setApiReady(true)
          return
        }
      } catch {}
      attempts++
      if (attempts < MAX) timer = setTimeout(checkBackend, 2000)
    }

    checkBackend()
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!tool.needsImage) setImageSource(null)
    if (!tool.needsAudio) setAudioSource(null)
    const compatible = workflows.filter(w =>
      (TOOL_WORKFLOW_TYPES[activeTool] ?? [activeTool]).includes(w.type)
    )
    const preferred = compatible.find(w => w.default) || compatible[0]
    setWorkflowId(preferred?.id || null)
  }, [activeTool, workflows])

  // Auto-resize inline textarea to fit content
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, 240)
    el.style.height = next + 'px'
  }, [prompt])

  // Focus expanded textarea when modal opens
  useEffect(() => {
    if (promptExpanded && expandedTextareaRef.current) {
      expandedTextareaRef.current.focus()
      const len = expandedTextareaRef.current.value.length
      expandedTextareaRef.current.setSelectionRange(len, len)
    }
  }, [promptExpanded])

  // ── Prompt auto-save per tool ─────────────────────────────────────────────
  // Save whenever the prompt text changes
  useEffect(() => {
    try { localStorage.setItem(`cinematic:tools:prompt:${activeToolRef.current}`, prompt) }
    catch {}
  }, [prompt])

  // On tool switch: save current prompt under the old tool key, then load the
  // saved prompt for the new tool (so each tool remembers its own last prompt)
  useEffect(() => {
    if (activeToolRef.current === activeTool) return
    try { localStorage.setItem(`cinematic:tools:prompt:${activeToolRef.current}`, prompt) }
    catch {}
    activeToolRef.current = activeTool
    try { setPrompt(localStorage.getItem(`cinematic:tools:prompt:${activeTool}`) || '') }
    catch { setPrompt('') }
    // prompt intentionally excluded: we capture it for the save, not to re-run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool])

  // Load all media when switch is toggled ON
  useEffect(() => {
    if (!showAllMedia) return
    setLoadingLib(true)
    const loadMedia = window.studio?.tools?.media
      ? window.studio.tools.media()
      : fetch(`${BACKEND_ORIGIN}/api/media/?limit=500`).then(r => r.ok ? r.json() : [])
    loadMedia
      .then(data => setAllMedia(normalizeMediaList(data)))
      .catch(() => setAllMedia([]))
      .finally(() => setLoadingLib(false))
  }, [showAllMedia])

  // ── Fake enhance progress animation ──────────────────────────────────────

  useEffect(() => {
    if (!enhancing) { setEnhancePct(0); return }
    setEnhancePct(5)
    let p = 5
    const iv = setInterval(() => {
      p = Math.min(88, p + Math.random() * 9 + 2)
      setEnhancePct(Math.round(p))
    }, 350)
    return () => clearInterval(iv)
  }, [enhancing])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function changeAspectRatio(ar) {
    setAspectRatio(ar)
    const resolutions = RESOLUTIONS_BY_RATIO[ar]
    setResolution(resolutions[Math.min(DEFAULT_RES[ar] ?? 1, resolutions.length - 1)])
  }

  function notify(title, body) {
    if (window.studio?.notify) { window.studio.notify(title, body).catch(() => {}); return }
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
  }

  function updateJob(id, patch) {
    storeUpdate(id, patch)
  }

  // ── Queue runner ──────────────────────────────────────────────────────────

  async function runNextJob() {
    if (runningRef.current || queueRef.current.length === 0) return
    const job = queueRef.current.shift()
    if (cancelledJobIdsRef.current.has(job.id)) {
      runNextJob()
      return
    }
    const epoch = queueEpochRef.current
    runningRef.current = true
    updateJob(job.id, { status: 'running', progress: 0, progressMsg: 'Avvio…' })

    let doneReceived = false

    const cleanup = window.studio.tools.onProgress((data) => {
      if (queueEpochRef.current !== epoch || cancelledJobIdsRef.current.has(job.id)) return
      if (data.done) {
        doneReceived = true
        const result = {
          type: data.type,
          filename: data.filename,
          path: data.path,
          media_id: data.media_id,
          preview_url: data.preview_url,
        }
        updateJob(job.id, { status: 'done', progress: 1, progressMsg: 'Completato!', result })
        cleanup?.()
        runningRef.current = false
        notify('CinematicAI Studio', `${TOOLS.find(t => t.id === job.tool)?.label} completato`)
        runNextJob()
      } else if (data.error) {
        doneReceived = true
        updateJob(job.id, { status: 'error', error: data.error, progress: 0 })
        cleanup?.()
        runningRef.current = false
        runNextJob()
      } else if (data.event === 'progress') {
        if (data.progress_kind === 'stage') {
          updateJob(job.id, {
            progressMsg: data.msg || 'Preparazione ComfyUI...',
            comfyuiPct: null,
          })
          return
        }
        const comfyPct = data.comfyui_max > 1
          ? data.comfyui_value / data.comfyui_max
          : null
        const progressMsg = comfyPct != null
          ? `ComfyUI ${data.comfyui_value}/${data.comfyui_max} (${Math.round(comfyPct * 100)}%)${data.comfyui_node ? ` · ${data.comfyui_node}` : ''}`
          : (data.msg || '')
        updateJob(job.id, {
          progress: comfyPct != null ? Math.min(0.99, comfyPct) : (data.pct || 0),
          progressMsg,
          comfyuiPct: data.comfyui_pct,
        })
      }
    })

    try {
      const { positive: runPos, negative: runNeg } = splitPositiveAndNegative(job.prompt, '')
      await window.studio.tools.run({
        tool: job.tool,
        prompt: runPos,
        negative_prompt: runNeg,
        aspect_ratio: job.aspectRatio,
        width: job.resolution.w,
        height: job.resolution.h,
        quality: job.quality,
        fps: job.fps,
        duration_sec: job.duration,
        workflow_id: job.workflowId ?? null,
        image_path: job.imageSource?.path ?? null,
        audio_path: job.audioSource?.path ?? null,
      })
      if (queueEpochRef.current !== epoch || cancelledJobIdsRef.current.has(job.id)) {
        cleanup?.()
        return
      }
      // safety-net: scatta solo se nessun evento done/error è già arrivato via tools:progress
      // (doneReceived=false significa che il backend non ha inviato done — connessione persa)
      if (
        !doneReceived &&
        runningRef.current &&
        queueEpochRef.current === epoch &&
        !cancelledJobIdsRef.current.has(job.id)
      ) {
        updateJob(job.id, { status: 'error', error: 'Nessuna risposta dal backend' })
        cleanup?.()
        runningRef.current = false
        runNextJob()
      }
    } catch (e) {
      if (queueEpochRef.current !== epoch || cancelledJobIdsRef.current.has(job.id)) {
        cleanup?.()
        return
      }
      updateJob(job.id, { status: 'error', error: e?.message || 'Errore di connessione' })
      cleanup?.()
      runningRef.current = false
      runNextJob()
    }
  }

  async function clearGenerationQueue() {
    const activeJobs = jobs.filter(j => j.status === 'queued' || j.status === 'running')
    if (activeJobs.length === 0) return

    queueEpochRef.current += 1
    queueRef.current = []
    runningRef.current = false
    activeJobs.forEach(j => cancelledJobIdsRef.current.add(j.id))

    const patch = { status: 'cancelled', progress: 0, progressMsg: 'Cancellata', error: null }
    activeJobs.forEach(j => storeUpdate(j.id, patch))

    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/queue/comfyui`)
      if (!res.ok) return
      const payload = await res.json()
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : []
      await Promise.all(nodes
        .filter(node => node.online)
        .flatMap(node => [
          fetch(`${BACKEND_ORIGIN}/api/queue/comfyui/interrupt?node_index=${node.index}`, { method: 'POST' }).catch(() => null),
          fetch(`${BACKEND_ORIGIN}/api/queue/comfyui/queue?node_index=${node.index}`, { method: 'DELETE' }).catch(() => null),
        ]))
    } catch {}
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function assignImageFromDisk(filePath, name) {
    setUploadingImage(true)
    setError(null)
    try {
      const src = await uploadDiskFileToToolsMedia(filePath, name, 'image')
      setImageSource(src)
    } catch (e) {
      setError(e?.message || 'Upload immagine fallito')
    } finally {
      setUploadingImage(false)
    }
  }

  async function assignImageFromBrowserFile(file) {
    setUploadingImage(true)
    setError(null)
    try {
      const src = await uploadBrowserFileToToolsMedia(file, 'image')
      setImageSource(src)
    } catch (e) {
      setError(e?.message || 'Upload immagine fallito')
    } finally {
      setUploadingImage(false)
    }
  }

  async function assignAudioFromDisk(filePath, name) {
    setUploadingAudio(true)
    setError(null)
    try {
      const src = await uploadDiskFileToToolsMedia(filePath, name, 'audio')
      setAudioSource(src)
    } catch (e) {
      setError(e?.message || 'Upload audio fallito')
    } finally {
      setUploadingAudio(false)
    }
  }

  async function assignAudioFromBrowserFile(file) {
    setUploadingAudio(true)
    setError(null)
    try {
      const src = await uploadBrowserFileToToolsMedia(file, 'audio')
      setAudioSource(src)
    } catch (e) {
      setError(e?.message || 'Upload audio fallito')
    } finally {
      setUploadingAudio(false)
    }
  }

  async function pickImageFromDisk(file) {
    if (file instanceof File) {
      await assignImageFromBrowserFile(file)
      return
    }
    try {
      if (typeof window.studio?.tools?.pickImage !== 'function') {
        setError('Selettore file non disponibile')
        return
      }
      const r = await window.studio.tools.pickImage()
      if (r?.path) await assignImageFromDisk(r.path, r.name || r.path.split(/[\\/]/).pop())
    } catch (e) {
      setError(e?.message || 'Selezione immagine annullata')
    }
  }

  async function pickAudioFromDisk(file) {
    if (file instanceof File) {
      await assignAudioFromBrowserFile(file)
      return
    }
    try {
      if (typeof window.studio?.tools?.pickAudio !== 'function') {
        setError('Selettore file non disponibile')
        return
      }
      const r = await window.studio.tools.pickAudio()
      if (r?.path) await assignAudioFromDisk(r.path, r.name || r.path.split(/[\\/]/).pop())
    } catch (e) {
      setError(e?.message || 'Selezione audio annullata')
    }
  }

  async function handleEnhance() {
    if (!prompt.trim() || enhancing) return
    if (!apiReady) { setError('Riavvia l\'app per attivare i Tools'); return }
    setEnhancing(true)
    setError(null)
    try {
      const isVideoTool = ['img2video', 'img_audio2video', 'txt2video', 'txt2video_lastframe'].includes(activeTool)
      const res = await window.studio.tools.enhance({
        prompt: prompt.trim(),
        tool: activeTool,
        negative_prompt: '',
        project_context: isVideoTool ? { duration_sec: duration } : undefined,
      })
      const unified = normalizeUnifiedPrompt(res?.enhanced, prompt.trim(), res?.negative_prompt)
      if (unified) {
        setPrompt(unified)
      } else {
        setError('LLM non ha restituito un prompt migliorato')
      }
    } catch (e) {
      setError('Migliora fallito: ' + (e?.message || 'errore sconosciuto'))
    } finally {
      setEnhancePct(100)
      setTimeout(() => setEnhancing(false), 300)
    }
  }

  function handleGenerate() {
    if (!prompt.trim()) return
    if (!apiReady) { setError('Riavvia l\'app per attivare i Tools'); return }
    if (tool.needsImage && !imageSource) { setError('Seleziona un\'immagine sorgente'); return }
    setError(null)

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    const job = {
      id: jobId,
      status: 'queued',
      tool: activeTool,
      prompt: prompt.trim(),
      aspectRatio,
      resolution: { ...resolution },
      quality,
      fps,
      duration,
      workflowId: workflowId ?? null,
      imageSource: imageSource ? { ...imageSource } : null,
      audioSource: audioSource ? { ...audioSource } : null,
      time: new Date().toLocaleTimeString(),
      progress: 0,
      progressMsg: '',
      error: null,
      result: null,
    }

    storeAddJob(job)
    setSelectedJobId(jobId)
    setSelectedLibItem(null)

    queueRef.current.push(job)
    runNextJob()
  }

  function galleryItemsFromJobs() {
    return jobs
      .filter(j => j.status === 'done' && j.result && jobPreviewSrc(j.result))
      .map(j => ({
        id: j.id,
        src: jobPreviewSrc(j.result),
        alt: j.result.filename || j.tool,
        type: j.result.type === 'video' ? 'video' : 'image',
      }))
  }

  function galleryItemsFromLibrary() {
    return allMedia
      .filter(m => m.media_type === 'image' || m.media_type === 'video' || m.type === 'image' || m.type === 'video')
      .map(m => ({
        id: m.id,
        src: resolveBackendUrl(`/api/media/file/${m.id}`),
        alt: m.filename,
        type: (m.media_type || m.type) === 'video' ? 'video' : 'image',
      }))
      .filter(it => it.src)
  }

  function handleImageContextMenu(e, item) {
    const isImage = item.media_type === 'image' || item.type === 'image'
    if (!isImage || !item.filepath) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, item })
  }

  function applyAnimateFromMedia(item) {
    const source = imageSourceFromMediaItem(item)
    if (!source) return
    setPendingImg2Video(source)
    setActiveTool('img2video')
    setImageSource(source)
    setShowAllMedia(false)
    setSelectedLibItem(null)
    setSelectedJobId(null)
    setCtxMenu(null)
    setError(null)
  }

  function applyAnimateAudioFromMedia(item) {
    const source = imageSourceFromMediaItem(item)
    if (!source) return
    setActiveTool('img_audio2video')
    setImageSource(source)
    setShowAllMedia(false)
    setSelectedLibItem(null)
    setSelectedJobId(null)
    setCtxMenu(null)
    setError(null)
  }

  function applyUseAsRefFromMedia(item) {
    const source = imageSourceFromMediaItem(item)
    if (!source) return
    setActiveTool('img2img')
    setImageSource(source)
    setWorkflowId(workflows.find(w => w.type === 'img2img')?.id || null)
    setShowAllMedia(false)
    setSelectedLibItem(null)
    setSelectedJobId(null)
    setCtxMenu(null)
    setError(null)
  }

  const hasImg2img = workflows.some(w => w.type === 'img2img')

  function openPreview(target) {
    if (!target?.id) return
    const isJob = target.status != null
    let items = isJob ? galleryItemsFromJobs() : galleryItemsFromLibrary()
    let idx = items.findIndex(it => it.id === target.id)

    if (idx < 0) {
      const src = isJob
        ? jobPreviewSrc(target.result)
        : resolveBackendUrl(`/api/media/file/${target.id}`)
      const rawType = isJob ? target.result?.type : (target.media_type || target.type)
      const one = src
        ? [{ id: target.id, src, alt: target.filename || target.result?.filename, type: rawType === 'video' ? 'video' : 'image' }]
        : []
      if (!one.length) return
      items = one
      idx = 0
    }

    setLightbox({ items, index: idx })
  }

  function handleSelectJob(job) {
    setSelectedJobId(job?.id ?? null)
    setSelectedLibItem(null)
  }

  function handleSelectLibItem(item) {
    setSelectedLibItem(item)
    setSelectedJobId(null)
  }

  const showDetail = selectedJobId !== null || selectedLibItem !== null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex overflow-hidden" style={{ background: 'var(--bg0)' }}>

      {/* ── Main column ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

        {/* ── Backend warning ── */}
        {!apiReady && (
          <div className="shrink-0 mx-4 mt-3 flex items-center gap-3 px-4 py-2.5 rounded-xl border border-amber-500/40 bg-amber-500/8 text-amber-400">
            <Loader2 size={14} className="shrink-0 animate-spin" />
            <p className="text-[11px] flex-1">Connessione al backend in corso… il servizio si avvia automaticamente.</p>
            <button
              onClick={() => window.location.reload()}
              className="text-[10px] px-2 py-1 rounded border border-amber-500/40 hover:bg-amber-500/10 shrink-0"
            >
              Ricarica
            </button>
          </div>
        )}

        {/* ── Tool tabs ── */}
        <div className="flex items-center gap-1 px-5 pt-4 pb-2 shrink-0 border-b border-[var(--border)]">
          {TOOLS.filter(t => !t.hidden).map(t => {
            const active = t.id === activeTool
            return (
              <button key={t.id} onClick={() => setActiveTool(t.id)}
                className={clsx(
                  'flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-mono transition-all',
                  active
                    ? 'bg-[var(--gold)] text-[var(--bg0)] shadow-md shadow-[var(--gold)]/20'
                    : 'border border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)] hover:border-[var(--border2)]'
                )}>
                <t.Icon size={12} /> {t.label}
              </button>
            )
          })}
        </div>

        {/* ── Gallery area ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* Media switch header */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-xs text-[var(--text3)] font-mono">
              {showAllMedia
                ? `${allMedia.length} media nella libreria`
                : `${jobs.length} generazioni in questa sessione`}
            </span>

            <button
              onClick={() => setShowAllMedia(v => !v)}
              className={clsx(
                'flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-mono border transition-all',
                showAllMedia
                  ? 'border-[var(--gold)] bg-[var(--gold)]/10 text-[var(--gold)]'
                  : 'border-[var(--border)] text-[var(--text3)] hover:border-[var(--border2)] hover:text-[var(--text2)]'
              )}
            >
              <div className={clsx(
                'w-7 h-3.5 rounded-full transition-colors relative',
                showAllMedia ? 'bg-[var(--gold)]' : 'bg-[var(--bg3)]'
              )}>
                <div className={clsx(
                  'absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform',
                  showAllMedia ? 'left-3.5' : 'left-0.5'
                )} />
              </div>
              Tutti i media
            </button>
          </div>

          {/* Gallery grid */}
          {showAllMedia ? (
            loadingLib ? (
              <div className="flex justify-center py-16">
                <Loader2 size={24} className="animate-spin text-[var(--text3)]" />
              </div>
            ) : allMedia.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-[var(--text3)]">
                <Wand2 size={36} className="mb-3 opacity-20" />
                <p className="text-sm">Nessun media nella libreria</p>
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                {allMedia.map(item => (
                  <MediaCard key={item.id} item={item}
                    selected={selectedLibItem?.id === item.id}
                    onSelect={handleSelectLibItem}
                    onOpenPreview={openPreview}
                    onImageContextMenu={handleImageContextMenu}
                    onAnimate={applyAnimateFromMedia}
                    onAnimateAudio={applyAnimateAudioFromMedia}
                    onUseAsRef={applyUseAsRefFromMedia}
                    hasAudio={Boolean(audioSource)}
                    hasImg2img={hasImg2img} />
                ))}
              </div>
            )
          ) : jobs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl border-2 border-dashed border-[var(--border2)] flex items-center justify-center mb-4">
                <Wand2 size={28} className="text-[var(--text3)] opacity-30" />
              </div>
              <p className="text-[var(--text3)] text-sm">I risultati appariranno qui</p>
              <p className="text-[var(--text3)] text-xs mt-1 opacity-60">Scrivi un prompt e premi Genera</p>
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {jobs.map(job => (
                <JobCard key={job.id} job={job}
                  selected={selectedJob?.id === job.id}
                  onSelect={handleSelectJob}
                  onOpenPreview={openPreview} />
              ))}
            </div>
          )}
        </div>

        {/* ── Generate dock ── */}
        <div className="shrink-0 px-4 pb-4 pt-2">
          <div className="rounded-2xl border border-[var(--border2)] p-3 flex flex-col gap-2"
               style={{ background: 'var(--bg1)', boxShadow: '0 -4px 32px rgba(201,168,76,0.04)' }}>

            {/* Sources + Prompt */}
            <div className={clsx('flex gap-2', (tool.needsImage || tool.needsAudio) && 'items-stretch')}
                 style={{ minHeight: (tool.needsImage || tool.needsAudio) ? 96 : undefined }}>
              {tool.needsImage && (
                <SourceThumb
                  source={imageSource}
                  label="Immagine"
                  mediaType="image"
                  uploading={uploadingImage}
                  onPickFile={pickImageFromDisk}
                  onDropPath={assignImageFromDisk}
                  onPickMedia={s => { setImageSource(s); setError(null) }}
                  onClear={() => setImageSource(null)}
                />
              )}
              {tool.needsAudio && (
                <SourceThumb
                  source={audioSource}
                  label="Audio"
                  mediaType="audio"
                  uploading={uploadingAudio}
                  onPickFile={pickAudioFromDisk}
                  onDropPath={assignAudioFromDisk}
                  onPickMedia={s => { setAudioSource(s); setError(null) }}
                  onClear={() => setAudioSource(null)}
                />
              )}

              {/* Prompt textarea with enhance overlay + expand button */}
              <div className="flex-1 relative group/prompt min-h-[56px]">
                <textarea
                  ref={textareaRef}
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Descrivi la scena… Migliora aggiunge --- Negative prompt --- nello stesso testo"
                  disabled={enhancing}
                  style={{ minHeight: (tool.needsImage || tool.needsAudio) ? 72 : 52, transition: 'height 0.2s cubic-bezier(0.4,0,0.2,1)' }}
                  className="w-full resize-none text-sm text-[var(--text)] placeholder-[var(--text3)] bg-transparent focus:outline-none leading-relaxed overflow-hidden"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleGenerate() }}
                />

                {/* Expand button */}
                <button
                  onClick={() => setPromptExpanded(true)}
                  title="Espandi editor prompt"
                  className="absolute top-1 right-1 p-1 rounded opacity-0 group-hover/prompt:opacity-100 transition-opacity text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--bg3)]"
                >
                  <Maximize2 size={11} />
                </button>

                {/* Enhance loading overlay */}
                {enhancing && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-[var(--bg1)]/90 backdrop-blur-sm">
                    <div className="flex items-center gap-2 text-[var(--gold)]">
                      <Sparkles size={14} className="animate-pulse" />
                      <span className="text-xs font-mono">Miglioramento prompt… {enhancePct}%</span>
                    </div>
                    <div className="w-40 h-1 rounded-full bg-[var(--bg3)] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-300"
                           style={{ width: `${enhancePct}%`, background: 'linear-gradient(90deg, var(--gold), var(--gold2))' }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Controls row: compact selects + actions */}
            <div className="flex items-center gap-1.5 flex-wrap">

              {/* Aspect Ratio */}
              <CompactSelect label="AR" displayValue={aspectRatio}>
                {ASPECT_RATIOS.map(ar => (
                  <SelectOption key={ar} active={ar === aspectRatio} onClick={() => changeAspectRatio(ar)}>
                    {ar}
                  </SelectOption>
                ))}
              </CompactSelect>

              {/* Resolution */}
              <CompactSelect label="RES" displayValue={
                <span>{resolution.badge || resolution.label}
                  {resolution.badge && <span className="text-[9px] ml-1 opacity-60">{resolution.label}</span>}
                </span>
              }>
                {(RESOLUTIONS_BY_RATIO[aspectRatio] || []).map(res => (
                  <SelectOption key={res.label}
                    active={resolution.w === res.w && resolution.h === res.h}
                    onClick={() => setResolution(res)}>
                    <span>{res.label}</span>
                    {res.badge && <span className="text-[9px] opacity-60">{res.badge}</span>}
                  </SelectOption>
                ))}
              </CompactSelect>

              {/* Quality */}
              <CompactSelect label="Q" displayValue={QUALITY_OPTS.find(q => q.id === quality)?.label}>
                {QUALITY_OPTS.map(q => (
                  <SelectOption key={q.id} active={quality === q.id} onClick={() => setQuality(q.id)}>
                    <span>{q.label}</span>
                    <span className="text-[9px] text-[var(--text3)]">{q.desc.split(' ')[0]}</span>
                  </SelectOption>
                ))}
              </CompactSelect>

              {/* FPS */}
              {tool.isVideo && (
                <CompactSelect label="FPS" displayValue={fps}>
                  {FPS_OPTS.map(f => (
                    <SelectOption key={f} active={fps === f} onClick={() => setFps(f)}>{f} fps</SelectOption>
                  ))}
                </CompactSelect>
              )}

              {/* Duration */}
              {tool.isVideo && (
                <CompactSelect label="DUR" displayValue={`${duration}s`}>
                  {DUR_OPTS.map(d => (
                    <SelectOption key={d} active={duration === d} onClick={() => setDuration(d)}>{d}s</SelectOption>
                  ))}
                </CompactSelect>
              )}

              {/* Workflow selector — shown when at least 1 matching workflow exists */}
              {(() => {
                const toolWfs = workflows.filter(w =>
                  (TOOL_WORKFLOW_TYPES[activeTool] ?? [activeTool]).includes(w.type)
                )
                if (toolWfs.length === 0) return null
                const defaultWf = toolWfs.find(w => w.default) || toolWfs[0]
                const active = toolWfs.find(w => w.id === workflowId) || defaultWf
                const label  = active ? active.name : 'Default'
                return (
                  <CompactSelect label="WF" displayValue={
                    <span className="max-w-[120px] truncate">{label}</span>
                  }>
                    {defaultWf && toolWfs.length > 1 && (
                      <SelectOption active={active?.id === defaultWf.id} onClick={() => setWorkflowId(defaultWf.id)}>
                        Default: {defaultWf.name}
                      </SelectOption>
                    )}
                    {toolWfs.filter(w => w.id !== defaultWf?.id).map(w => (
                      <SelectOption key={w.id} active={workflowId === w.id} onClick={() => setWorkflowId(w.id)}>
                        <span className="truncate max-w-[160px]">{w.name}</span>
                      </SelectOption>
                    ))}
                  </CompactSelect>
                )
              })()}

              <div className="flex-1" />

              {/* Enhance */}
              <button onClick={handleEnhance} disabled={!prompt.trim() || enhancing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)]/40 hover:text-[var(--gold)] disabled:opacity-40 transition-colors shrink-0">
                {enhancing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                Migliora
              </button>

              {/* Generate — always enabled while prompt is valid (queue) */}
              {jobs.some(j => j.status === 'queued' || j.status === 'running') && (
                <button onClick={clearGenerationQueue}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono border border-[var(--red)]/40 text-[var(--red)] hover:bg-[var(--red)]/10 transition-colors shrink-0">
                  <Trash2 size={11} />
                  Cancella coda
                </button>
              )}

              {(() => {
                const pending = jobs.filter(j => j.status === 'queued' || j.status === 'running').length
                return (
                  <button onClick={handleGenerate} disabled={!prompt.trim()}
                    className={clsx(
                      'flex items-center gap-2 px-5 py-2 rounded-full text-sm font-semibold transition-all disabled:opacity-40 shrink-0',
                      'bg-[var(--gold)] hover:bg-[var(--gold2)] shadow-md shadow-[var(--gold)]/20'
                    )}
                    style={{ color: 'var(--bg0)' }}>
                    <Wand2 size={14} />
                    {pending > 0 ? `Accoda +1 (${pending} attivi)` : 'Genera'}
                  </button>
                )
              })()}
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--red)]/10 border border-[var(--red)]/30">
                <AlertTriangle size={12} className="text-[var(--red)] shrink-0" />
                <span className="text-[11px] text-[var(--red)] flex-1">{error}</span>
                <button onClick={() => setError(null)} className="text-[var(--red)] hover:text-[var(--text)]"><X size={12} /></button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Detail sidebar ── */}
      {showDetail && (
        <DetailSidebar
          job={selectedJob}
          libraryItem={selectedLibItem}
          onClose={() => { setSelectedJobId(null); setSelectedLibItem(null) }}
          onOpenPreview={openPreview}
        />
      )}

      <ImageLightbox
        open={!!lightbox}
        items={lightbox?.items ?? []}
        initialIndex={lightbox?.index ?? 0}
        onClose={() => setLightbox(null)}
      />

      {ctxMenu && (
        <MediaImageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onAnimate={() => applyAnimateFromMedia(ctxMenu.item)}
        />
      )}

      {/* ── Expanded Prompt Editor Modal ── */}
      {promptExpanded && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          style={{ background: 'rgba(7,7,13,0.82)', backdropFilter: 'blur(6px)' }}
          onClick={e => { if (e.target === e.currentTarget) setPromptExpanded(false) }}
        >
          <div
            className="w-full max-w-2xl flex flex-col rounded-2xl border border-[var(--border2)] overflow-hidden"
            style={{
              background: 'var(--bg1)',
              boxShadow: '0 8px 64px rgba(201,168,76,0.10), 0 2px 16px rgba(0,0,0,0.6)',
              animation: 'promptModalIn 0.22s cubic-bezier(0.34,1.56,0.64,1) both',
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)]">
              <div className="flex items-center gap-2">
                <Wand2 size={13} className="text-[var(--gold)]" />
                <span className="text-xs font-medium text-[var(--text2)] uppercase tracking-widest">Editor Prompt</span>
              </div>
              <button
                onClick={() => setPromptExpanded(false)}
                className="p-1.5 rounded-lg text-[var(--text3)] hover:text-[var(--text)] hover:bg-[var(--bg3)] transition-colors"
              >
                <Minimize2 size={13} />
              </button>
            </div>

            {/* Textarea */}
            <div className="relative flex-1 p-4">
              <textarea
                ref={expandedTextareaRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="Descrivi la scena… Migliora aggiunge --- Negative prompt --- nello stesso testo"
                disabled={enhancing}
                className="w-full resize-none text-sm text-[var(--text)] placeholder-[var(--text3)] bg-transparent focus:outline-none leading-relaxed"
                style={{ minHeight: 220, maxHeight: 480, transition: 'height 0.18s ease', overflow: 'auto', height: 'auto' }}
                rows={10}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { setPromptExpanded(false); handleGenerate() } }}
              />
              {/* char count */}
              <span className="absolute bottom-2 right-4 text-[10px] text-[var(--text3)] select-none tabular-nums">
                {prompt.length} car
              </span>
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-[var(--border)] bg-[var(--bg0)]/40">
              <button
                onClick={() => { handleEnhance(); }}
                disabled={!prompt.trim() || enhancing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--gold)]/30 text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-40 transition-colors"
              >
                <Sparkles size={11} />
                Migliora
              </button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--text3)]">Ctrl+Enter per generare</span>
                <button
                  onClick={() => setPromptExpanded(false)}
                  className="px-4 py-1.5 rounded-lg text-xs font-semibold text-[var(--bg0)] transition-colors"
                  style={{ background: 'var(--gold)' }}
                >
                  Fatto
                </button>
              </div>
            </div>
          </div>
          <style>{`
            @keyframes promptModalIn {
              from { opacity: 0; transform: translateY(20px) scale(0.97); }
              to   { opacity: 1; transform: translateY(0)    scale(1);    }
            }
          `}</style>
        </div>,
        document.body
      )}
    </div>
  )
}
