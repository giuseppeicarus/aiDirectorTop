/**
 * Card clip reel + pannello attività agenti (CreateReel).
 */
import { useState, useEffect } from 'react'
import {
  Loader2, Image as ImageIcon, Film, Camera, Clock, Maximize2,
  Sparkles, Check, Edit3, Save, RotateCcw, X, Wand2, Clapperboard, Download,
} from 'lucide-react'
import { normalizeUnifiedPrompt } from '../utils/promptEnhance'
import clsx from 'clsx'
import {
  BACKEND_ORIGIN,
  clipReelFramePreviewUrl,
  clipReelStoryboardPreviewUrl,
  resolveBackendUrl,
} from '../utils/mediaUrl'

export const REEL_PIPELINE_AGENTS = [
  { role: 'vision_analyst', label: 'Analista Vision', phase: 'vision_analysis' },
  { role: 'narrative_director', label: 'Regista Narrativo', phase: 'reel_director' },
  { role: 'cinematographer', label: 'Direttore della Fotografia', phase: 'prompt_generator' },
  { role: 'prompt_engineer', label: 'Prompt Engineer', phase: 'prompt_generator' },
  { role: 'comfyui', label: 'ComfyUI / Produzione', phase: 'storyboard' },
]

export function buildEstimatedClipRows(config) {
  const n = Math.max(1, Math.ceil((config.duration_sec || 30) / (config.max_clip_sec || 5)))
  const slotDur = (config.duration_sec || 30) / n
  return Array.from({ length: n }, (_, i) => ({
    clip_id: `plan_${String(i + 1).padStart(3, '0')}`,
    slot_id: `slot_${String(i + 1).padStart(3, '0')}`,
    clip_index: i,
    duration_sec: Math.round(slotDur * 10) / 10,
    status: 'planned',
    scene_prompt: '',
    first_frame_prompt: '',
    last_frame_prompt: '',
    motion_prompt: '',
  }))
}

export function attachDopToClip(clip, dopPlans) {
  if (!clip?.slot_id || !dopPlans?.length) return clip
  const plan = dopPlans.find(p => p.slot_id === clip.slot_id)
  if (!plan) return clip
  return {
    ...clip,
    shot_type: plan.shot_type ?? clip.shot_type,
    lens_mm: plan.lens_mm ?? clip.lens_mm,
    camera_movement: plan.camera_movement ?? clip.camera_movement,
    depth_of_field: plan.depth_of_field ?? clip.depth_of_field,
    lighting: plan.lighting ?? clip.lighting,
    emotion: plan.emotion ?? clip.emotion,
  }
}

const PROMPT_PREVIEW_MAX = 72

export function truncatePromptPreview(text, max = PROMPT_PREVIEW_MAX) {
  const t = (text || '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  if (t.length <= max) return t
  return `${t.slice(0, max).trimEnd()}…`
}

export function PromptPreviewRow({ label, value, accent = false }) {
  const preview = truncatePromptPreview(value)
  if (!preview) return null
  return (
    <div className="min-w-0">
      <p className="text-[7px] font-mono text-[#555568] uppercase tracking-wider mb-0.5">{label}</p>
      <p
        className={clsx(
          'text-[9px] font-mono leading-snug truncate',
          accent ? 'text-[#c9a84c]' : 'text-[#9090a8]',
        )}
        title={value}
      >
        {preview}
      </p>
    </div>
  )
}

const PROMPT_FIELD_DEFS = [
  { key: 'scene_prompt', label: 'Scena', rows: 3 },
  { key: 'first_frame_prompt', label: 'First frame (txt2img)', rows: 6 },
  { key: 'last_frame_prompt', label: 'Last frame (txt2img)', rows: 5, optional: true },
  { key: 'motion_prompt', label: 'Motion (img2video)', rows: 4, accent: true },
  { key: 'ltx_video_prompt', label: 'LTX video', rows: 6, optional: true },
]

export function ReelPromptEditorModal({
  open,
  clipId,
  draft,
  setDraft,
  hasLastFrame,
  saving,
  saved,
  isDirty,
  onClose,
  onSave,
  projectContext = null,
}) {
  const [enhancingKey, setEnhancingKey] = useState(null)
  const [enhanceHint, setEnhanceHint] = useState('')

  async function handleEnhanceField(fieldKey) {
    const text = (draft[fieldKey] || '').trim()
    if (!text || enhancingKey) return
    setEnhancingKey(fieldKey)
    setEnhanceHint('')
    try {
      const res = await window.studio?.llm?.enhancePrompt?.({
        prompt: text,
        context: fieldKey,
        project_context: projectContext,
      })
      const improved = normalizeUnifiedPrompt(
        res?.enhanced,
        text,
        res?.negative_prompt,
      )
      if (improved) {
        setDraft(prev => ({ ...prev, [fieldKey]: improved }))
        if (res?.role_label) {
          setEnhanceHint(`Migliorato da ${res.role_label}`)
        }
      }
    } catch {
      setEnhanceHint('Miglioramento non riuscito')
    } finally {
      setEnhancingKey(null)
    }
  }

  if (!open) return null

  const fields = PROMPT_FIELD_DEFS.filter(f => {
    if (f.key === 'last_frame_prompt' && !hasLastFrame) return false
    if (f.optional && !(draft[f.key] || '').trim()) return true
    return true
  })

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center p-4 bg-[#07070d]/85 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl border border-[#32324a] bg-[#16161f] shadow-2xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="reel-prompt-modal-title"
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#252533] shrink-0">
          <div className="min-w-0">
            <p id="reel-prompt-modal-title" className="text-[11px] font-mono text-[#e8e4dd]">
              Prompt completi
            </p>
            <p className="text-[9px] font-mono text-[#c9a84c] truncate">{clipId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-[#555568] hover:text-[#e8e4dd] hover:bg-[#252533]"
            aria-label="Chiudi"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {enhanceHint && (
            <p className="text-[9px] font-mono text-[#9090a8]">{enhanceHint}</p>
          )}
          {fields.map(({ key, label, rows, accent }) => (
            <div key={key}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className={clsx(
                  'text-[8px] font-mono uppercase tracking-wider',
                  accent ? 'text-[#c9a84c]' : 'text-[#555568]',
                )}>
                  {label}
                </label>
                <button
                  type="button"
                  onClick={() => handleEnhanceField(key)}
                  disabled={!(draft[key] || '').trim() || enhancingKey != null}
                  className="flex items-center gap-1 text-[8px] font-mono text-[#555568] hover:text-[#c9a84c] disabled:opacity-40"
                  title="Migliora con il modello LLM della regia più adatto a questo campo"
                >
                  {enhancingKey === key
                    ? <Loader2 size={10} className="animate-spin" />
                    : <Wand2 size={10} />}
                  {enhancingKey === key ? '…' : 'Migliora'}
                </button>
              </div>
              <textarea
                value={draft[key] || ''}
                onChange={e => setDraft(prev => ({ ...prev, [key]: e.target.value }))}
                rows={rows}
                disabled={enhancingKey === key}
                className={clsx(
                  'w-full text-[11px] font-mono bg-[#0f0f18] border rounded px-3 py-2 text-[#e8e4dd]',
                  'resize-y leading-relaxed focus:outline-none focus:border-[#c9a84c]/50',
                  accent ? 'border-[#c9a84c]/30' : 'border-[#252533]',
                  enhancingKey === key && 'opacity-60',
                )}
                spellCheck={false}
              />
            </div>
          ))}
        </div>

        <div className="flex gap-2 px-4 py-3 border-t border-[#252533] shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 rounded text-[10px] font-mono border border-[#32324a] text-[#9090a8] hover:text-[#e8e4dd]"
          >
            Annulla
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !isDirty}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1.5 py-2 rounded text-[10px] font-mono border',
              saved
                ? 'border-[#22c55e]/50 text-[#22c55e] bg-[#22c55e]/10'
                : 'border-[#c9a84c]/50 text-[#c9a84c] hover:bg-[#c9a84c]/10 disabled:opacity-40',
            )}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saved ? 'Salvato' : 'Salva prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}

function emptyPromptDraft(clip) {
  return {
    scene_prompt: clip.scene_prompt || '',
    first_frame_prompt: clip.first_frame_prompt || '',
    last_frame_prompt: clip.last_frame_prompt || '',
    motion_prompt: clip.motion_prompt || '',
    ltx_video_prompt: clip.ltx_video_prompt || '',
  }
}

function FullScreenImageViewer({ src, onClose, title }) {
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleWheel = (e) => {
    e.preventDefault()
    const zoomIntensity = 0.1
    const nextScale = e.deltaY < 0 ? scale + zoomIntensity : scale - zoomIntensity
    setScale(Math.max(0.5, Math.min(5, nextScale)))
  }

  const handleMouseDown = (e) => {
    e.preventDefault()
    setIsDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }

  const handleMouseMove = (e) => {
    if (!isDragging) return
    e.preventDefault()
    setPosition({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const zoomIn = () => setScale(s => Math.min(5, s + 0.25))
  const zoomOut = () => setScale(s => Math.max(0.5, s - 0.25))
  const resetZoom = () => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }

  const handleDownload = () => {
    if (!src) return
    const link = document.createElement('a')
    link.href = src
    const filename = title
      ? title.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.png'
      : 'anteprima.png'
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div 
      className="fixed inset-0 z-[9999] bg-[#07070a]/95 backdrop-blur-md flex flex-col justify-between items-center overflow-hidden select-none"
      onWheel={handleWheel}
    >
      <div className="w-full flex items-center justify-between px-6 py-4 bg-gradient-to-b from-[#07070a] to-transparent z-10">
        <div className="flex flex-col">
          <span className="text-white text-xs font-semibold tracking-wide">
            {title || 'Visualizzazione Anteprima'}
          </span>
          <span className="text-[#8e8ea8] text-[9px] font-mono mt-0.5">
            Trascina per spostare • Usa la rotellina o i pulsanti per lo zoom • Doppio clic per resettare
          </span>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 active:scale-95 transition-all flex items-center justify-center text-[#8e8ea8] hover:text-white border border-white/10"
        >
          <X size={16} />
        </button>
      </div>

      <div 
        className={`w-full flex-1 flex items-center justify-center overflow-hidden relative cursor-${scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <img
          src={src}
          alt="Anteprima a schermo intero"
          className="max-w-[90vw] max-h-[75vh] object-contain transition-transform duration-75 ease-out select-none pointer-events-none rounded border border-[#252533]/50 shadow-2xl"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
          }}
          onDoubleClick={resetZoom}
        />
      </div>

      <div className="px-6 py-4 bg-gradient-to-t from-[#07070a] to-transparent w-full flex items-center justify-center gap-4 z-10 mb-2">
        <div className="flex items-center gap-2 bg-[#101018]/90 backdrop-blur border border-[#252533] px-3 py-1.5 rounded-full shadow-2xl">
          <button
            onClick={zoomOut}
            className="w-7 h-7 rounded-full bg-[#1b1b24] hover:bg-[#252533] active:scale-90 transition-all flex items-center justify-center text-white text-xs font-semibold"
            title="Zoom Out"
          >
            -
          </button>
          
          <span 
            className="text-[10px] text-white font-mono min-w-[45px] text-center cursor-pointer hover:text-[#c9a84c]"
            onClick={resetZoom}
            title="Clicca per resettare lo zoom"
          >
            {Math.round(scale * 100)}%
          </span>
          
          <button
            onClick={zoomIn}
            className="w-7 h-7 rounded-full bg-[#1b1b24] hover:bg-[#252533] active:scale-90 transition-all flex items-center justify-center text-white text-xs font-semibold"
            title="Zoom In"
          >
            +
          </button>
          
          <div className="w-[1px] h-3 bg-[#252533] mx-1" />
          
          <button
            onClick={resetZoom}
            className="px-2.5 py-0.5 rounded text-[9px] uppercase font-mono text-[#c9a84c] border border-[#c9a84c]/20 bg-[#c9a84c]/5 hover:bg-[#c9a84c]/10 active:scale-95 transition-all"
            title="Reset"
          >
            Reset
          </button>

          <div className="w-[1px] h-3 bg-[#252533] mx-1" />

          <button
            onClick={handleDownload}
            className="px-2.5 py-0.5 rounded text-[9px] uppercase font-mono text-white/80 hover:text-white border border-white/20 bg-white/5 hover:bg-white/10 active:scale-95 transition-all flex items-center gap-1"
            title="Scarica risorsa"
          >
            <Download size={10} />
            Download
          </button>
        </div>
      </div>
    </div>
  )
}

function sameFramePath(a, b) {
  if (!a || !b) return false
  return String(a).replace(/\\/g, '/').toLowerCase()
    === String(b).replace(/\\/g, '/').toLowerCase()
}

export function ReelThumb({ clip, projectId, jobId, aspectRatio, kind = 'preview', localPath }) {
  const [src, setSrc] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const isPortrait = aspectRatio === '9:16'
  const isRegeneratingFirstFrame = kind === 'first'
    && clip?.status === 'generating'
    && (clip?.clip_phase === 'frame_gen' || clip?.comfyuiKind === 'frame')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (clip?.clip_url && kind === 'video') {
        const v = clip.clip_url.startsWith('http') ? clip.clip_url : `${BACKEND_ORIGIN}${clip.clip_url}`
        if (!cancelled) setSrc(v)
        return
      }
      const distinctLastPath = clip?.last_frame_path
        && !sameFramePath(clip.last_frame_path, clip?.first_frame_path)
        && !String(clip.last_frame_path).replace(/\\/g, '/').toLowerCase().endsWith('_first.png')
      const path = localPath || (kind === 'first'
        ? clip?.first_frame_path
        : kind === 'last'
          ? (distinctLastPath ? clip.last_frame_path : null)
          : null)
      if (path && window.studio?.reel?.readImageLocal) {
        const r = await window.studio.reel.readImageLocal(path)
        if (!cancelled && r?.ok && r.dataUrl) {
          setSrc(r.dataUrl)
          return
        }
      }
      const urls = []
      if (kind === 'preview') {
        const sb = clipReelStoryboardPreviewUrl(clip, projectId)
        if (sb) urls.push(sb)
        if (clip?.preview_url) {
          const u = resolveBackendUrl(clip.preview_url)
          if (u) urls.unshift(u)
        }
      }
      if (kind === 'first') {
        const hd = clipReelFramePreviewUrl(clip, projectId)
        if (hd) urls.push(hd)
      }
      if (kind === 'last') {
        // Only show the last frame if it was explicitly set — never fall back to
        // the first frame image (last_frame is extracted from the video after gen).
        const explicitLastUrl = resolveBackendUrl(clip?.last_frame_url)
        const hdLast = distinctLastPath ? resolveBackendUrl(null, clip.last_frame_path) : null
        if (explicitLastUrl) urls.push(explicitLastUrl)
        if (hdLast) urls.push(hdLast)
      }
      for (const httpUrl of urls) {
        if (window.studio?.reel?.fetchImageUrl) {
          const r = await window.studio.reel.fetchImageUrl(httpUrl)
          if (!cancelled && r?.ok && r.dataUrl) {
            setSrc(r.dataUrl)
            return
          }
        } else if (!cancelled) {
          setSrc(httpUrl)
          return
        }
      }
      if (!cancelled) setSrc(null)
    }
    load()
    return () => { cancelled = true }
  }, [
    clip?.clip_id,
    clip?.clip_url,
    clip?.first_frame_path,
    clip?.last_frame_path,
    clip?.frame_url,
    clip?.preview_url,
    clip?.storyboard_path,
    clip?.storyboard_url,
    clip?.storyboard_clip_url,
    clip?.storyboard_filename,
    clip?.storyboard_ok,
    clip?.storyboard_placeholder,
    clip?.hd_frame_ready,
    clip?.status,
    clip?.clip_phase,
    projectId,
    jobId,
    kind,
    localPath,
  ])

  const isClickable = kind !== 'video' && src
  const isGeneratingFirstFrame = !src && isRegeneratingFirstFrame
  const step    = clip?.comfyuiStep    ?? 0
  const stepMax = clip?.comfyuiStepMax ?? 0
  const pct     = clip?.comfyuiPct    ?? 0

  return (
    <>
      <div
        className={clsx(
          "relative rounded border overflow-hidden select-none bg-[#0f0f18]",
          isClickable
            ? "border-[#252533] cursor-zoom-in group hover:border-[#c9a84c]/50 transition-colors"
            : isGeneratingFirstFrame
              ? "border-[#c9a84c]/40"
              : "border-[#252533]",
        )}
        style={{ aspectRatio: isPortrait ? '9/16' : '16/9' }}
        onClick={isClickable ? () => setModalOpen(true) : undefined}
      >
        {/* ── video ── */}
        {kind === 'video' && src && (
          <video
            src={src}
            className="w-full h-full object-contain"
            controls
            playsInline
            preload="metadata"
          />
        )}

        {/* ── image (first/last/preview) ── */}
        {kind !== 'video' && src && (
          <>
            <img src={src} alt="" className="w-full h-full object-contain bg-[#07070d]" />
            {isRegeneratingFirstFrame && (
              <div className="absolute inset-x-0 bottom-0 bg-[#07070d]/80 border-t border-[#c9a84c]/30 px-1.5 py-1 flex items-center gap-1">
                <Loader2 size={8} className="animate-spin text-[#c9a84c] shrink-0" />
                <span className="text-[6px] font-mono text-[#c9a84c] truncate">
                  {stepMax > 1 ? `${step}/${stepMax}` : 'Rigenerazione first'}
                </span>
                <div className="h-0.5 flex-1 bg-[#252533] overflow-hidden rounded">
                  <div className="h-full bg-[#c9a84c]" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white/90 backdrop-blur-[1px]">
              <Maximize2 size={12} className="scale-75 group-hover:scale-100 transition-transform duration-200" />
            </div>
          </>
        )}

        {/* ── first frame: real ComfyUI step progress ── */}
        {isGeneratingFirstFrame && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[#07070d]">
            {/* scanline shimmer */}
            <div className="absolute inset-0 overflow-hidden opacity-20 pointer-events-none">
              <div
                className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-[#c9a84c] to-transparent"
                style={{ animation: 'scanline 1.6s linear infinite', top: `${pct}%` }}
              />
            </div>
            <Camera size={11} className="text-[#c9a84c]/70 relative z-10" />
            {stepMax > 1 ? (
              <span className="text-[6px] font-mono text-[#c9a84c] relative z-10 tabular-nums">
                {step} <span className="text-[#555568]">/</span> {stepMax}
              </span>
            ) : (
              <Loader2 size={9} className="animate-spin text-[#c9a84c]/60 relative z-10" />
            )}
            {/* step progress bar */}
            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-[#1a1a24]">
              <div
                className="h-full bg-[#c9a84c] transition-all duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* ── first/preview: idle placeholder ── */}
        {!src && !isGeneratingFirstFrame && kind !== 'last' && kind !== 'video' && (
          <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 text-[#555568]">
            {clip?.status === 'generating'
              ? <Loader2 size={11} className="animate-spin text-[#c9a84c]/50" />
              : <ImageIcon size={11} />}
            <span className="text-[5.5px] font-mono uppercase tracking-wider">{kind}</span>
          </div>
        )}

        {/* ── last frame: static placeholder (image arrives after video gen) ── */}
        {!src && kind === 'last' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center">
            <div className={clsx(
              "flex items-center justify-center w-5 h-5 rounded-full border mb-0.5",
              clip?.clip_phase === 'video_gen'
                ? "bg-[#c9a84c]/10 border-[#c9a84c]/30 text-[#c9a84c]/70"
                : "bg-[#1e1e2a] border-[#32324a] text-[#555568]",
            )}>
              {clip?.clip_phase === 'video_gen'
                ? <Loader2 size={8} className="animate-spin" />
                : <Clapperboard size={8} />}
            </div>
            <span className="text-[5.5px] font-semibold text-[#9090a0] uppercase tracking-wider block leading-tight">
              Last Frame
            </span>
            <span className="text-[5px] text-[#555568] leading-tight block max-w-[68px] mx-auto">
              {clip?.clip_phase === 'video_gen'
                ? 'clip in generazione…'
                : 'estratto dalla clip video'}
            </span>
          </div>
        )}

        {/* ── preview progress bar ── */}
        {clip?.comfyuiPct > 0 && kind === 'preview' && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1e1e2a]/80">
            <div className="h-full bg-[#c9a84c]" style={{ width: `${clip.comfyuiPct}%` }} />
          </div>
        )}
      </div>

      {modalOpen && (
        <FullScreenImageViewer
          src={src}
          onClose={() => setModalOpen(false)}
          title={`Inquadratura ${clip?.slot_id || ''} - ${kind === 'preview' ? 'Anteprima Storyboard' : kind === 'first' ? 'Primo Frame (First)' : 'Ultimo Frame (Last)'}`}
        />
      )}

      <style>{`
        @keyframes scanline {
          from { top: 0% }
          to   { top: 100% }
        }
      `}</style>
    </>
  )
}

function AssetPromptText({ label, value, empty = 'Prompt non disponibile' }) {
  return (
    <div className="min-h-[42px] rounded border border-[#252533] bg-[#0f0f18] px-2 py-1.5">
      <p className="text-[6px] font-mono uppercase tracking-wider text-[#555568] mb-0.5">{label}</p>
      <p className="text-[7px] leading-relaxed text-[#9090a8] line-clamp-3">
        {(value || '').trim() || empty}
      </p>
    </div>
  )
}

function ClipAssetCard({
  title,
  clip,
  projectId,
  jobId,
  aspectRatio,
  kind,
  promptLabel,
  prompt,
  onRegen,
  regenDisabled = false,
  regenTitle = 'Rigenera',
  regenHidden = false,
  regenning = false,
}) {
  const isVideo = kind === 'video'
  return (
    <div className="rounded-lg border border-[#252533] bg-[#0f0f18] overflow-hidden flex flex-col min-w-0">
      <div className="px-2 py-1.5 border-b border-[#252533] flex items-center justify-between gap-2">
        <p className="text-[7px] font-mono uppercase tracking-wider text-[#9090a8] truncate">{title}</p>
        {!regenHidden && onRegen && (
          <button
            type="button"
            onClick={() => onRegen(clip.clip_id, kind)}
            disabled={regenDisabled || regenning}
            title={regenTitle}
            className="shrink-0 inline-flex items-center justify-center gap-1 h-5 px-1.5 rounded border border-[#32324a] text-[6px] font-mono text-[#9090a8] hover:text-[#c9a84c] hover:border-[#c9a84c]/40 disabled:opacity-40 disabled:hover:text-[#9090a8] disabled:hover:border-[#32324a]"
          >
            {regenning ? <Loader2 size={9} className="animate-spin" /> : <RotateCcw size={9} />}
            Rigenera
          </button>
        )}
      </div>
      <div className="p-1.5">
        <div
          className={clsx(
            "rounded border overflow-hidden bg-[#07070d]",
            isVideo ? "border-[#32324a]" : "border-[#252533]",
          )}
          style={{ aspectRatio: aspectRatio === '9:16' ? '9/16' : '16/9' }}
        >
          {isVideo && !clip.clip_url ? (
            <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-[#555568]">
              {clip.clip_phase === 'video_gen'
                ? <Loader2 size={12} className="animate-spin text-[#c9a84c]/70" />
                : <Film size={13} />}
              <span className="text-[6px] font-mono text-center px-1">
                {clip.clip_phase === 'video_gen' ? 'Video in generazione' : 'Video non generato'}
              </span>
            </div>
          ) : (
            <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind={kind} />
          )}
        </div>
        <div className="mt-1.5">
          <AssetPromptText label={promptLabel} value={prompt} />
        </div>
      </div>
    </div>
  )
}

export function ReelClipPlanCard({
  clip,
  projectId,
  jobId,
  aspectRatio,
  config,
  sbSize,
  hdSize,
  onSave,
  onRegen,
  regenning = false,
  projectContext = null,
}) {
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [draft, setDraft] = useState(() => emptyPromptDraft(clip))
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!promptModalOpen) setDraft(emptyPromptDraft(clip))
  }, [
    clip.clip_id,
    clip.scene_prompt,
    clip.first_frame_prompt,
    clip.last_frame_prompt,
    clip.motion_prompt,
    clip.ltx_video_prompt,
    promptModalOpen,
  ])

  const isDirty = PROMPT_FIELD_DEFS.some(
    ({ key }) => (draft[key] || '') !== (clip[key] || ''),
  )

  const hasLast = Boolean((clip.last_frame_prompt || '').trim() || clip.last_frame_path)
  const isPlanned = clip.status === 'planned' || clip.status === 'waiting'

  const promptRows = [
    { label: 'First frame', value: clip.first_frame_prompt },
    hasLast && { label: 'Last frame', value: clip.last_frame_prompt },
    { label: 'Motion', value: clip.motion_prompt, accent: true },
    clip.ltx_video_prompt && { label: 'LTX', value: clip.ltx_video_prompt },
    clip.scene_prompt && { label: 'Scena', value: clip.scene_prompt },
  ].filter(Boolean)

  async function handleSave() {
    if (!onSave) return
    setSaving(true)
    try {
      const payload = {}
      for (const { key } of PROMPT_FIELD_DEFS) {
        if ((draft[key] || '') !== (clip[key] || '')) payload[key] = draft[key] || ''
      }
      await onSave(clip.clip_id, payload)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      setPromptModalOpen(false)
    } finally {
      setSaving(false)
    }
  }

  function openPromptModal() {
    setDraft(emptyPromptDraft(clip))
    setPromptModalOpen(true)
  }

  const regieBits = [
    clip.shot_type && `Inq. ${clip.shot_type}`,
    clip.lens_mm && `${clip.lens_mm}mm`,
    clip.camera_movement,
    clip.depth_of_field && `DoF ${clip.depth_of_field}`,
    clip.lighting,
    clip.emotion,
  ].filter(Boolean)
  const hasVideo = Boolean(clip.clip_url)
  const isRegenerating = clip.status === 'generating'

  return (
    <div className={clsx(
      'rounded-xl border bg-[#16161f] flex flex-col overflow-hidden',
      hasVideo && isRegenerating ? 'border-[#c9a84c]/60'
        : clip.status === 'done' || hasVideo ? 'border-[#22c55e]/40'
        : clip.status === 'generating' ? 'border-[#c9a84c]/50'
          : isPlanned ? 'border-[#32324a] border-dashed'
            : 'border-[#252533]',
    )}>
      <div className="px-3 py-2 border-b border-[#252533] flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-[10px] font-mono text-[#c9a84c] truncate">{clip.clip_id}</p>
            {clip.use_prev_last_frame ? (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[7px] font-mono bg-[#3b82f6]/15 border border-[#3b82f6]/30 text-[#3b82f6] shrink-0">
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none"><path d="M1 4h6M4 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Last→First
              </span>
            ) : clip.scene_transition === 'scene_cut' ? (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[7px] font-mono bg-[#555568]/20 border border-[#555568]/30 text-[#9090a8] shrink-0">
                <svg width="7" height="7" viewBox="0 0 8 8" fill="none"><path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                Cambio scena
              </span>
            ) : null}
          </div>
          {clip.slot_id && clip.slot_id !== clip.clip_id && (
            <p className="text-[8px] font-mono text-[#555568] truncate">{clip.slot_id}</p>
          )}
          {clip.status === 'generating' && (clip.comfyuiMsg || clip.clip_phase) && (
            <p className="text-[8px] font-mono text-[#c9a84c]/90 truncate mt-0.5 flex items-center gap-1">
              <Loader2 size={8} className="animate-spin shrink-0" />
              {clip.comfyuiMsg || (
                clip.clip_phase === 'video_gen' ? 'Generazione video…'
                  : clip.clip_phase === 'frame_gen' ? 'Generazione frame HD…'
                    : 'Generazione…'
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {clip.duration_sec != null && (
            <span className="text-[8px] font-mono text-[#9090a8] flex items-center gap-0.5">
              <Clock size={8} />{clip.duration_sec}s
            </span>
          )}
        </div>
      </div>

      {/* ── Video done: large full-width player + 3-image row below ── */}
      {clip.status === 'done' && clip.clip_url ? (
        <>
          <div className="px-2 pt-2">
            <p className="text-[6px] font-mono text-[#22c55e]/80 uppercase mb-1 flex items-center gap-1">
              <Check size={7} className="text-[#22c55e]" />Clip video pronta
            </p>
            <div className="rounded-lg border border-[#22c55e]/30 overflow-hidden bg-[#0f0f18]"
              style={{ aspectRatio: aspectRatio === '9:16' ? '9/16' : '16/9' }}
            >
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="video" />
            </div>
          </div>
          <div className="p-2 grid grid-cols-3 gap-1.5">
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">Storyboard</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="preview" />
            </div>
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">First Frame</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="first" />
            </div>
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">Last Frame</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="last" />
            </div>
          </div>
        </>
      ) : (
        /* ── Not yet done: 3-col thumbnails + small video placeholder ── */
        <>
          <div className="p-2 grid grid-cols-3 gap-1.5">
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">Anteprima</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="preview" />
            </div>
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">First</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="first" />
            </div>
            <div>
              <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5 text-center">Last</p>
              <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="last" />
            </div>
          </div>
          <div className="px-2 pb-2">
            <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5">Clip video</p>
            <div className="rounded border border-[#252533] overflow-hidden" style={{ maxHeight: 72 }}>
              <div className="w-full h-full min-h-[48px] flex items-center justify-center gap-1 bg-[#0f0f18] text-[#555568]">
                {clip.clip_phase === 'video_gen'
                  ? <Loader2 size={11} className="animate-spin text-[#c9a84c]/60" />
                  : <Film size={12} />}
                <span className="text-[7px] font-mono text-center px-1">
                  {clip.comfyuiMsg
                    || (clip.clip_phase === 'video_gen' ? 'Video in generazione…'
                      : clip.clip_phase === 'frame_gen' ? 'Frame HD…'
                        : 'In attesa')}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <div className="px-3 py-2 border-t border-[#252533] space-y-2 text-[9px]">
        <div className="flex flex-wrap gap-1.5">
          {config && (
            <span className="font-mono text-[#9090a8] flex items-center gap-0.5">
              <Maximize2 size={8} />
              {config.width}×{config.height}
            </span>
          )}
          {sbSize && (
            <span className="font-mono text-[#555568]">SB {sbSize.w}×{sbSize.h}</span>
          )}
          {hdSize && (
            <span className="font-mono text-[#555568]">HD {hdSize.w}×{hdSize.h}</span>
          )}
          {clip.start_sec != null && clip.end_sec != null && (
            <span className="font-mono text-[#555568]">
              {clip.start_sec}s–{clip.end_sec}s
            </span>
          )}
        </div>
        {regieBits.length > 0 && (
          <p className="font-mono text-[#c9a84c]/90 flex items-start gap-1">
            <Camera size={9} className="shrink-0 mt-0.5" />
            <span>{regieBits.join(' · ')}</span>
          </p>
        )}
      </div>

      <div className="px-3 py-2 border-t border-[#252533] bg-[#0f0f18]">
        {isPlanned ? (
          <p className="text-[9px] font-mono text-[#555568]">Prompt in attesa…</p>
        ) : (
          <>
            <div className="space-y-1.5 mb-2">
              {promptRows.map(row => (
                <PromptPreviewRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                  accent={row.accent}
                />
              ))}
            </div>
            {onSave && (
              <button
                type="button"
                onClick={openPromptModal}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded text-[9px] font-mono border border-[#32324a] text-[#9090a8] hover:text-[#c9a84c] hover:border-[#c9a84c]/40"
              >
                <Edit3 size={10} />
                Apri e modifica prompt
              </button>
            )}
          </>
        )}
      </div>
      {promptModalOpen && (
        <ReelPromptEditorModal
          open={promptModalOpen}
          clipId={clip.clip_id}
          draft={draft}
          setDraft={setDraft}
          hasLastFrame={hasLast}
          saving={saving}
          saved={saved}
          isDirty={isDirty}
          onClose={() => setPromptModalOpen(false)}
          onSave={handleSave}
          projectContext={projectContext}
        />
      )}
    </div>
  )
}

export function ReelClipPlanGrid({
  clips,
  projectId,
  jobId,
  aspectRatio,
  config,
  sbSize,
  hdSize,
  dopPlans,
  onSave,
  onRegen,
  regenningId,
  title,
  emptyHint,
  projectContext = null,
}) {
  const sorted = [...clips].sort((a, b) => (a.clip_id || '').localeCompare(b.clip_id || ''))
  const enriched = sorted.map(c => attachDopToClip(c, dopPlans))

  return (
    <div>
      {title && (
        <p className="text-[10px] font-mono text-[#9090a8] mb-3">{title}</p>
      )}
      {enriched.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2 text-[#555568]">
          <ImageIcon size={28} />
          <p className="text-[11px] font-mono">{emptyHint || 'Nessuna clip'}</p>
        </div>
      ) : (
        <div className={clsx(
          'grid gap-3',
          aspectRatio === '9:16'
            ? 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
            : 'grid-cols-1 lg:grid-cols-2',
        )}>
          {enriched.map(clip => (
            <ReelClipPlanCard
              key={clip.clip_id}
              clip={clip}
              projectId={projectId}
              jobId={jobId}
              aspectRatio={aspectRatio}
              config={config}
              sbSize={sbSize}
              hdSize={hdSize}
              onSave={onSave}
              onRegen={onRegen}
              regenning={regenningId === clip.clip_id}
              projectContext={projectContext}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ReelEstimatedClipStrip({ config, sbSize, hdSize }) {
  const rows = buildEstimatedClipRows(config)
  return (
    <ReelClipPlanGrid
      clips={rows}
      aspectRatio={config.aspect_ratio}
      config={config}
      sbSize={sbSize}
      hdSize={hdSize}
      dopPlans={null}
      title={`Piano clip stimato (~${rows.length} clip)`}
      emptyHint=""
    />
  )
}

export function ReelSystemActivityPanel({ activity, agentsStatus, phaseStatus }) {
  const agents = REEL_PIPELINE_AGENTS

  const activeAgent = agents.find(a => {
    const st = agentsStatus[a.role]
    const phaseDone = phaseStatus[a.phase] === 'done'
    return st?.status === 'working' && !phaseDone
  })

  return (
    <div className="rounded-xl border border-[#252533] bg-[#0a0a12] overflow-hidden mb-4">
      {/* Console header */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[#252533] bg-[#07070d]">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#c9a84c] opacity-50" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#c9a84c]" />
        </span>
        <span className="text-[9px] font-mono text-[#c9a84c] uppercase tracking-widest">Pipeline di produzione</span>
        {activeAgent && (
          <span className="ml-auto text-[8px] font-mono text-[#555568]">
            Agente attivo: <span className="text-[#9090a8]">{activeAgent.label}</span>
          </span>
        )}
      </div>

      {/* Current message */}
      {activity?.msg && (
        <div className="px-4 py-2.5 border-b border-[#1a1a26]">
          <div className="flex items-start gap-2">
            {activity.status !== 'done'
              ? <Loader2 size={11} className="animate-spin text-[#c9a84c] shrink-0 mt-0.5" />
              : <Check size={11} className="text-[#22c55e] shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <p className="text-[10px] font-mono leading-snug">
                {activity.agent_label && (
                  <span className="text-[#c9a84c] mr-1">{activity.agent_label}</span>
                )}
                <span className={activity.status === 'done' ? 'text-[#22c55e]' : 'text-[#9090a8]'}>
                  {activity.msg}
                </span>
                {activity.clip_index != null && activity.clip_total != null && (
                  <span className="text-[#555568]"> · clip {activity.clip_index}/{activity.clip_total}</span>
                )}
              </p>
              {activity.model && (
                <p className="text-[8px] font-mono text-[#555568] mt-0.5">{activity.model}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Agent pipeline flow */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-0 overflow-x-auto">
          {agents.map((a, i) => {
            const st = agentsStatus[a.role]
            const phaseDone = phaseStatus[a.phase] === 'done'
            const working = st?.status === 'working' && !phaseDone
            const done = st?.status === 'done' || phaseDone
            return (
              <div key={a.role} className="flex items-center gap-0 shrink-0">
                <div className={clsx(
                  'flex flex-col items-center gap-1 px-2 py-2 rounded-lg border transition-all',
                  working && 'border-[#c9a84c]/50 bg-[#c9a84c]/8',
                  done && !working && 'border-[#22c55e]/25 bg-[#22c55e]/5',
                  !working && !done && 'border-[#1e1e2a] bg-transparent',
                )}>
                  <div className={clsx(
                    'w-5 h-5 rounded-full border flex items-center justify-center',
                    working && 'border-[#c9a84c] bg-[#c9a84c]/20',
                    done && !working && 'border-[#22c55e] bg-[#22c55e]/15',
                    !working && !done && 'border-[#32324a]',
                  )}>
                    {done && !working
                      ? <Check size={9} className="text-[#22c55e]" />
                      : working
                        ? <Loader2 size={9} className="animate-spin text-[#c9a84c]" />
                        : <span className="w-1.5 h-1.5 rounded-full bg-[#32324a]" />}
                  </div>
                  <span className={clsx(
                    'text-[7px] font-mono whitespace-nowrap',
                    working ? 'text-[#c9a84c]' : done ? 'text-[#22c55e]' : 'text-[#3a3a50]',
                  )}>
                    {a.label.split(' ')[0]}
                  </span>
                </div>
                {i < agents.length - 1 && (
                  <div className={clsx(
                    'w-5 h-px shrink-0',
                    done ? 'bg-[#22c55e]/30' : 'bg-[#1e1e2a]',
                  )} />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const CLIP_STATUS_META = {
  done:              { label: 'Completata',   color: '#22c55e', bg: '#22c55e14', border: 'border-[#22c55e]/40' },
  generating:        { label: 'Generando...', color: '#c9a84c', bg: '#c9a84c14', border: 'border-[#c9a84c]/50' },
  storyboard:        { label: 'Storyboard',   color: '#3b82f6', bg: '#3b82f614', border: 'border-[#3b82f6]/30' },
  storyboard_failed: { label: 'SB fallito',   color: '#f59e0b', bg: '#f59e0b14', border: 'border-[#f59e0b]/40' },
  waiting:           { label: 'In attesa',    color: '#555568', bg: '#55556814', border: 'border-[#252533]' },
  planned:           { label: 'Pianificata',  color: '#555568', bg: '#55556808', border: 'border-[#252533] border-dashed' },
  error:             { label: 'Errore',       color: '#ef4444', bg: '#ef444414', border: 'border-[#ef4444]/40' },
}

function ClipStatusPill({ status }) {
  const m = CLIP_STATUS_META[status] ?? CLIP_STATUS_META.waiting
  return (
    <span
      className="text-[8px] font-mono px-1.5 py-0.5 rounded shrink-0 whitespace-nowrap"
      style={{ color: m.color, background: m.bg }}
    >
      {m.label}
    </span>
  )
}

function HorizThumb({ clip, projectId, jobId, aspectRatio }) {
  const [src, setSrc] = useState(null)
  const [retry, setRetry] = useState(0)
  const preferHd = clip?.hd_frame_ready || clip?.status === 'done'
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const localPath = clip?.first_frame_path || clip?.storyboard_path
      if (localPath && window.studio?.reel?.readImageLocal) {
        const r = await window.studio.reel.readImageLocal(localPath)
        if (!cancelled && r?.ok && r.dataUrl) { setSrc(r.dataUrl); return }
      }
      const urls = []
      if (preferHd) {
        const hd = clipReelFramePreviewUrl(clip, projectId)
        if (hd) urls.push(hd)
      }
      const sb = clipReelStoryboardPreviewUrl(clip, projectId)
      if (sb) urls.push(sb)
      if (clip?.preview_url) {
        const u = resolveBackendUrl(clip.preview_url)
        if (u) urls.unshift(u)
      }
      for (const url of urls) {
        if (window.studio?.reel?.fetchImageUrl) {
          const r = await window.studio.reel.fetchImageUrl(url + '?v=' + retry)
          if (!cancelled && r?.ok && r.dataUrl) { setSrc(r.dataUrl); return }
        } else if (!cancelled) { setSrc(url + '?v=' + retry); return }
      }
      if (!cancelled) setSrc(null)
    }
    load()
    return () => { cancelled = true }
  }, [clip?.clip_id, clip?.status, clip?.storyboard_path, clip?.first_frame_path,
      clip?.frame_url, clip?.preview_url, projectId, retry, preferHd])

  useEffect(() => {
    if (src || !clip?.clip_id) return
    const iv = setInterval(() => setRetry(r => r + 1), 3000)
    return () => clearInterval(iv)
  }, [clip?.clip_id, src])

  const isGenerating = clip?.status === 'generating'
  const pct = clip?.comfyuiPct ?? 0
  const isClickable = Boolean(src)

  return (
    <>
      <div
        className={clsx(
          "relative overflow-hidden rounded bg-[#0f0f18] w-full select-none",
          isClickable ? "border border-[#252533] hover:border-[#c9a84c]/50 transition-colors cursor-zoom-in group" : ""
        )}
        style={{ height: 120 }}
        onClick={isClickable ? () => setModalOpen(true) : undefined}
      >
        {src ? (
          <>
            <img src={src} alt="" className="w-full h-full object-contain bg-[#07070d]" />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white/90 backdrop-blur-[1px]">
              <Maximize2 size={12} className="scale-75 group-hover:scale-100 transition-transform duration-200" />
            </div>
          </>
        ) : isGenerating ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1">
            <Loader2 size={12} className="animate-spin text-[#c9a84c]/70" />
            {pct > 0 && <span className="text-[6px] font-mono text-[#c9a84c] tabular-nums">{pct}%</span>}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#3a3a50]">
            <ImageIcon size={14} />
          </div>
        )}
        {pct > 0 && pct < 100 && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1e1e2a]">
            <div className="h-full bg-[#c9a84c] transition-all" style={{ width: pct + '%' }} />
          </div>
        )}
      </div>

      {modalOpen && (
        <FullScreenImageViewer
          src={src}
          onClose={() => setModalOpen(false)}
          title={`Inquadratura ${clip?.slot_id || clip?.clip_id || ''} - Primo Frame (First)`}
        />
      )}
    </>
  )
}

function LastFrameThumb({ clip, projectId, aspectRatio }) {
  const [src, setSrc] = useState(null)
  const [retry, setRetry] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const localPath = clip?.last_frame_path
      if (localPath && window.studio?.reel?.readImageLocal) {
        const r = await window.studio.reel.readImageLocal(localPath)
        if (!cancelled && r?.ok && r.dataUrl) { setSrc(r.dataUrl); return }
      }
      if (clip?.clip_id && projectId) {
        const url = `${BACKEND_ORIGIN}/api/reel/frame/${encodeURIComponent(projectId)}/${encodeURIComponent(clip.clip_id)}/last?v=${retry}`
        if (window.studio?.reel?.fetchImageUrl) {
          const r = await window.studio.reel.fetchImageUrl(url)
          if (!cancelled && r?.ok && r.dataUrl) { setSrc(r.dataUrl); return }
        } else if (!cancelled) { setSrc(url); return }
      }
      if (!cancelled) setSrc(null)
    }
    load()
    return () => { cancelled = true }
  }, [clip?.clip_id, clip?.status, clip?.last_frame_path, projectId, retry])

  if (src) {
    return (
      <>
        <div
          className="relative overflow-hidden rounded bg-[#0f0f18] w-full cursor-zoom-in group border border-[#252533] hover:border-[#c9a84c]/50 transition-colors"
          style={{ height: 120 }}
          onClick={() => setModalOpen(true)}
        >
          <img src={src} alt="" className="w-full h-full object-contain bg-[#07070d]" />
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white/90 backdrop-blur-[1px]">
            <Maximize2 size={12} className="scale-75 group-hover:scale-100 transition-transform duration-200" />
          </div>
        </div>

        {modalOpen && (
          <FullScreenImageViewer
            src={src}
            onClose={() => setModalOpen(false)}
            title={`Inquadratura ${clip?.slot_id || clip?.clip_id || ''} - Ultimo Frame (Last)`}
          />
        )}
      </>
    )
  }
  return (
    <div
      className="w-full flex items-center justify-center rounded border border-dashed border-[#252533] bg-[#0a0a10] text-[8px] font-mono text-[#3a3a50] italic"
      style={{ height: 120 }}
    >
      in attesa di generazione
    </div>
  )
}

function InlineVideoPlayer({ clip }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!clip?.clip_url) { setSrc(null); return }
    const url = clip.clip_url.startsWith('http') ? clip.clip_url : BACKEND_ORIGIN + clip.clip_url
    setSrc(url)
  }, [clip?.clip_url])
  if (!src) return null
  return (
    <div className="rounded border border-[#22c55e]/30 overflow-hidden bg-[#07070d]">
      <video src={src} controls playsInline preload="metadata" className="w-full max-h-[260px] object-contain" />
    </div>
  )
}

export function ReelHorizontalClipRow({
  clip, projectId, jobId, aspectRatio,
  onSave, onRegen, regenning = false, projectContext = null, index = 0,
}) {
  const [expanded, setExpanded] = useState(false)
  const [videoOpen, setVideoOpen] = useState(false)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [draft, setDraft] = useState({
    scene_prompt: clip.scene_prompt || '',
    first_frame_prompt: clip.first_frame_prompt || '',
    last_frame_prompt: clip.last_frame_prompt || '',
    motion_prompt: clip.motion_prompt || '',
    ltx_video_prompt: clip.ltx_video_prompt || '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!promptModalOpen) {
      setDraft({
        scene_prompt: clip.scene_prompt || '',
        first_frame_prompt: clip.first_frame_prompt || '',
        last_frame_prompt: clip.last_frame_prompt || '',
        motion_prompt: clip.motion_prompt || '',
        ltx_video_prompt: clip.ltx_video_prompt || '',
      })
    }
  }, [clip.scene_prompt, clip.first_frame_prompt, clip.last_frame_prompt,
      clip.motion_prompt, clip.ltx_video_prompt, promptModalOpen])

  const isDirty = PROMPT_FIELD_DEFS.some(({ key }) => (draft[key] || '') !== (clip[key] || ''))
  const hasVideo = Boolean(clip.clip_url)
  const isGenerating = clip.status === 'generating'
  const isPlanned = clip.status === 'planned' || clip.status === 'waiting'
  const hasLast = Boolean((clip.last_frame_prompt || '').trim() || clip.last_frame_path)
  const m = CLIP_STATUS_META[clip.status] ?? CLIP_STATUS_META.waiting

  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    if (!isGenerating) return
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 800)
    return () => clearTimeout(t)
  }, [clip.comfyuiPct, clip.clip_phase])

  async function handleSave() {
    if (!onSave) return
    setSaving(true)
    try {
      const payload = {}
      for (const { key } of PROMPT_FIELD_DEFS) {
        if ((draft[key] || '') !== (clip[key] || '')) payload[key] = draft[key] || ''
      }
      await onSave(clip.clip_id, payload)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      setPromptModalOpen(false)
    } finally { setSaving(false) }
  }

  const regieBits = [
    clip.shot_type && `Inq. ${clip.shot_type}`,
    clip.lens_mm && `${clip.lens_mm}mm`,
    clip.camera_movement,
    clip.depth_of_field && `DoF ${clip.depth_of_field}`,
    clip.lighting,
    clip.emotion,
  ].filter(Boolean).slice(0, 4)

  return (
    <div className={clsx(
      'rounded-lg border bg-[#16161f] transition-all duration-200 overflow-hidden',
      pulse && 'ring-1 ring-[#c9a84c]/30',
      m.border,
    )}>
      <div className="flex items-stretch">

        {/* ── LEFT METADATA CARD ──────────────────────────────────────────────────────── */}
        <div
          className="shrink-0 border-r border-[#252533] bg-[#0f0f18] flex flex-col min-w-0"
          style={{ width: 160 }}
        >
          <div className="px-2.5 py-1.5 border-b border-[#252533] flex items-center justify-between gap-1">
            <span className="text-[10px] font-mono text-[#c9a84c] font-bold">
              Clip #{String(index + 1).padStart(2, '0')}
            </span>
            <ClipStatusPill status={clip.status} />
          </div>

          <div className="p-2.5 flex-1 flex flex-col gap-2.5 justify-between">
            <div className="space-y-2">
              <div>
                <p className="text-[6px] font-mono uppercase text-[#555568] tracking-wider mb-0.5">Identificativo</p>
                <p className="text-[8px] font-mono text-[#9090a8] break-all leading-tight">
                  {clip.slot_id || clip.clip_id}
                </p>
              </div>

              <div className="space-y-0.5">
                {clip.duration_sec != null && (
                  <p className="flex items-center gap-1 text-[8px] font-mono text-[#9090a8]">
                    <Clock size={8} className="text-[#555568]" /> {clip.duration_sec}s
                  </p>
                )}
                {clip.start_sec != null && clip.end_sec != null && (
                  <p className="flex items-center gap-1 text-[8px] font-mono text-[#9090a8] truncate">
                    <span className="text-[#555568]">🎵</span> {clip.start_sec}s → {clip.end_sec}s
                  </p>
                )}
              </div>

              {regieBits.length > 0 && (
                <div>
                  <p className="text-[6px] font-mono uppercase text-[#555568] tracking-wider mb-1">Parametri Regia</p>
                  <div className="flex flex-wrap gap-1">
                    {regieBits.map(b => (
                      <span key={b} className="text-[7px] font-mono px-1 py-0.5 rounded bg-[#1e1e2a] border border-[#252533] text-[#9090a8]">
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {isGenerating && clip.clip_phase && (
                <div className="rounded border border-[#c9a84c]/20 bg-[#c9a84c]/5 px-1.5 py-1 flex items-center gap-1">
                  <Loader2 size={7} className="animate-spin text-[#c9a84c] shrink-0" />
                  <span className="text-[7px] font-mono text-[#c9a84c] truncate">
                    {clip.clip_phase === 'video_gen' ? 'generazione video' : clip.clip_phase === 'frame_gen' ? 'frame HD' : clip.clip_phase}
                  </span>
                </div>
              )}
            </div>

            {onSave && (
              <button
                type="button"
                onClick={() => {
                  setDraft({
                    scene_prompt: clip.scene_prompt || '',
                    first_frame_prompt: clip.first_frame_prompt || '',
                    last_frame_prompt: clip.last_frame_prompt || '',
                    motion_prompt: clip.motion_prompt || '',
                    ltx_video_prompt: clip.ltx_video_prompt || '',
                  })
                  setPromptModalOpen(true)
                }}
                className="w-full flex items-center justify-center gap-1 py-1.5 rounded text-[8px] font-mono border border-[#32324a] bg-[#16161f] text-[#9090a8] hover:text-[#c9a84c] hover:border-[#c9a84c]/40 transition-colors"
                title="Modifica prompt"
              >
                <Edit3 size={9} /> Modifica
              </button>
            )}
          </div>
        </div>

        {/* ── CENTER: 4 strictly horizontal columns (Anteprima + First Frame + Last Frame + Video Player) ── */}
        <div className="flex-1 min-w-0 grid grid-cols-4 gap-3 p-3 bg-[#111119]/30">

          {/* Storyboard Preview */}
          <ClipAssetCard
            title="Anteprima Storyboard"
            clip={clip}
            projectId={projectId}
            jobId={jobId}
            aspectRatio={aspectRatio}
            kind="preview"
            promptLabel="Descrizione Scena"
            prompt={clip.scene_prompt}
            onRegen={onRegen}
            regenDisabled={regenning || isPlanned || clip.status === 'generating'}
            regenning={regenning && clip.comfyuiKind === 'preview'}
            regenHidden={isPlanned}
          />

          {/* First frame */}
          <ClipAssetCard
            title="Primo Frame (First)"
            clip={clip}
            projectId={projectId}
            jobId={jobId}
            aspectRatio={aspectRatio}
            kind="first"
            promptLabel="Prompt Immagine (First)"
            prompt={clip.first_frame_prompt}
            onRegen={onRegen}
            regenDisabled={regenning || isPlanned || clip.status === 'generating'}
            regenning={regenning && clip.comfyuiKind === 'first'}
            regenHidden={isPlanned}
          />

          {/* Last frame */}
          <ClipAssetCard
            title="Ultimo Frame (Last)"
            clip={clip}
            projectId={projectId}
            jobId={jobId}
            aspectRatio={aspectRatio}
            kind="last"
            promptLabel="Prompt Immagine (Last)"
            prompt={clip.last_frame_prompt}
            onRegen={onRegen}
            regenDisabled={regenning || isPlanned || clip.status === 'generating'}
            regenning={regenning && clip.comfyuiKind === 'last'}
            regenHidden={isPlanned || !hasLast}
          />

          {/* Video player card */}
          <ClipAssetCard
            title="Clip Video Pronta"
            clip={clip}
            projectId={projectId}
            jobId={jobId}
            aspectRatio={aspectRatio}
            kind="video"
            promptLabel="Motion Prompt"
            prompt={clip.motion_prompt}
            onRegen={onRegen}
            regenDisabled={regenning || isPlanned || clip.status === 'generating'}
            regenning={regenning && clip.comfyuiKind === 'video'}
            regenHidden={isPlanned}
          />

        </div>

      </div>

      {promptModalOpen && (
        <ReelPromptEditorModal
          open={promptModalOpen}
          clipId={clip.clip_id}
          draft={draft}
          setDraft={setDraft}
          hasLastFrame={hasLast}
          saving={saving}
          saved={saved}
          isDirty={isDirty}
          onClose={() => setPromptModalOpen(false)}
          onSave={handleSave}
          projectContext={projectContext}
        />
      )}
    </div>
  )
}

export function ReelHorizontalClipList({
  clips, projectId, jobId, aspectRatio, dopPlans,
  onSave, onRegen, regenningId, projectContext = null,
}) {
  const [statusFilter, setStatusFilter] = useState('all')
  const sorted = [...clips].sort((a, b) => (a.clip_id || '').localeCompare(b.clip_id || ''))
  const enriched = sorted.map(c => attachDopToClip(c, dopPlans))
  const statusCounts = enriched.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc }, {})
  const filtered = statusFilter === 'all' ? enriched
    : statusFilter === 'waiting' ? enriched.filter(c => c.status === 'waiting' || c.status === 'planned')
    : enriched.filter(c => c.status === statusFilter)

  const filterOpts = [
    { key: 'all', label: 'Tutto (' + enriched.length + ')' },
    enriched.some(c => c.status === 'done') && { key: 'done', label: 'Completate (' + (statusCounts.done || 0) + ')' },
    enriched.some(c => c.status === 'generating') && { key: 'generating', label: 'Generando (' + (statusCounts.generating || 0) + ')' },
    enriched.some(c => ['waiting', 'planned'].includes(c.status)) && { key: 'waiting', label: 'In attesa (' + ((statusCounts.waiting || 0) + (statusCounts.planned || 0)) + ')' },
    enriched.some(c => c.status === 'storyboard') && { key: 'storyboard', label: 'Storyboard (' + (statusCounts.storyboard || 0) + ')' },
  ].filter(Boolean)

  if (enriched.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2 text-[#555568]">
        <Film size={24} />
        <p className="text-[10px] font-mono">Le clip appariranno man mano che la pipeline avanza</p>
      </div>
    )
  }

  return (
    <div className="w-full">
      {filterOpts.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          {filterOpts.map(opt => (
            <button key={opt.key} type="button" onClick={() => setStatusFilter(opt.key)}
              className={clsx(
                'px-2.5 py-1 rounded text-[9px] font-mono border transition-colors',
                statusFilter === opt.key
                  ? 'border-[#c9a84c]/50 bg-[#c9a84c]/12 text-[#c9a84c]'
                  : 'border-[#252533] text-[#555568] hover:text-[#9090a8] hover:border-[#32324a]',
              )}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-x-auto pb-4">
        <div className="space-y-3 min-w-[1100px] pr-2">
          {filtered.map(clip => (
            <ReelHorizontalClipRow
              key={clip.clip_id}
              clip={clip}
              projectId={projectId}
              jobId={jobId}
              aspectRatio={aspectRatio}
              onSave={onSave}
              onRegen={onRegen}
              regenning={regenningId === clip.clip_id}
              projectContext={projectContext}
              index={sorted.indexOf(clip)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
