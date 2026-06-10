/**
 * CreateReel — reel da descrizione + immagini di riferimento (LLM vision).
 * Storyboard bassa risoluzione → approvazione → HD + clip video.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { useJobQueryDeepLink } from '../hooks/useJobQueryDeepLink'
import {
  ImagePlus, Loader2, Sparkles, Check, RefreshCw, X, Film,
  LayoutGrid, AlertCircle, Image as ImageIcon, Trash2, Clapperboard,
  ChevronRight, Instagram, Library, Search, ChevronDown, Settings2, Cpu, Square,
  Save, RotateCcw, Edit3, ChevronUp, Wand2, UserRound, Music2, Maximize2, List,
} from 'lucide-react'
import clsx from 'clsx'
import ProjectDirBanner from '../components/ProjectDirBanner'
import GenQueueBadge from '../components/GenQueueBadge'
import { ComfyUIQueueInline } from '../components/ComfyUIQueuePanel'
import {
  ReelClipPlanGrid,
  ReelEstimatedClipStrip,
  ReelSystemActivityPanel,
  PromptPreviewRow,
  ReelPromptEditorModal,
  ReelHorizontalClipList,
} from '../components/ReelClipCards'
import ReelAudioSection from '../components/ReelAudioSection'
import ImageLightbox from '../components/ImageLightbox'
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
import { clipNeedsMediaRecovery, mergeClipRecoveryEvent } from '../utils/clipMediaRecovery'
import { useMediaReconcile } from '../hooks/useMediaReconcile'
import { resolveImagePaths } from '../utils/electronFilePaths'
import { buildReelEnhanceContext } from '../utils/obsidianEnhanceContext'

const MAX_REFS = 12

const CHARACTER_MODES = [
  { key: 'none', label: 'Nessun personaggio' },
  { key: 'reference', label: 'Solo reference' },
  { key: 'character', label: 'Personaggio creato' },
  { key: 'character_reference', label: 'Personaggio + reference' },
]

const REEL_AGENT_LABELS = {
  vision_analyst: 'Analista Vision',
  story_analyst: 'Analisi Audio',
  narrative_director: 'Regista Narrativo',
  cinematographer: 'Direttore della Fotografia',
  prompt_engineer: 'Prompt Engineer',
  comfyui: 'ComfyUI / Produzione',
}

function reelAgentDone(prev, role) {
  return {
    ...prev,
    [role]: {
      status: 'done',
      label: REEL_AGENT_LABELS[role] || role,
      model: prev[role]?.model,
    },
  }
}

function reelAdvanceAgents(prev, activeRole, patch) {
  let next = { ...prev, [activeRole]: patch }
  if (activeRole === 'cinematographer' || activeRole === 'prompt_engineer' || activeRole === 'comfyui') {
    next = reelAgentDone(next, 'narrative_director')
  }
  if (activeRole === 'prompt_engineer' || activeRole === 'comfyui') {
    next = reelAgentDone(next, 'cinematographer')
  }
  if (activeRole === 'comfyui') {
    next = reelAgentDone(next, 'prompt_engineer')
  }
  return next
}

function reelClipOrdinal(clipId, clips) {
  if (!clipId) return { label: '', n: null, total: clips?.length || 0 }
  const idx = clips.findIndex(c => c.clip_id === clipId)
  let n = idx >= 0 ? idx + 1 : null
  if (n == null) {
    const m = String(clipId).match(/clip_(\d+)/i)
    if (m) n = parseInt(m[1], 10) + 1
  }
  const total = clips?.length || 0
  const label = n != null && total > 0
    ? `clip ${n}/${total}`
    : (n != null ? `clip ${n}` : clipId)
  return { n, total, label }
}

function liveProductionMsg(data, clips) {
  const { label } = reelClipOrdinal(data.clip_id, clips)
  if (data.msg) return data.msg
  if (data.event === 'clip_comfyui_progress') {
    if (data.kind === 'video') return `Generazione clip video — ${label}`
    if (data.kind === 'frame') {
      const role = /last/i.test(String(data.label || '')) ? 'last frame' : 'first frame'
      return `Generazione immagine ${role} — ${label}`
    }
    return label ? `ComfyUI — ${label}` : 'ComfyUI in esecuzione…'
  }
  if (data.clip_phase === 'video_gen') return `Generazione clip video — ${label}`
  if (data.clip_phase === 'frame_gen') return `Generazione immagine HD — ${label}`
  return label ? `Produzione — ${label}` : 'Produzione HD + video in corso…'
}

function mergeReelClipFromSse(existing, data) {
  if (!data) return existing
  return {
    ...existing,
    ...data,
    clip_id: data.clip_id || existing?.clip_id,
    slot_id: data.slot_id ?? data.slot ?? existing?.slot_id,
    scene_prompt: data.scene_prompt ?? existing?.scene_prompt,
    first_frame_prompt: data.first_frame_prompt ?? existing?.first_frame_prompt,
    last_frame_prompt: data.last_frame_prompt ?? existing?.last_frame_prompt,
    motion_prompt: data.motion_prompt ?? existing?.motion_prompt,
    ltx_video_prompt: data.ltx_video_prompt ?? existing?.ltx_video_prompt,
    negative_prompt: data.negative_prompt ?? existing?.negative_prompt,
    duration_sec: data.duration_sec ?? existing?.duration_sec,
    start_sec: data.start_sec ?? existing?.start_sec,
    end_sec: data.end_sec ?? existing?.end_sec,
    width: data.width ?? existing?.width,
    height: data.height ?? existing?.height,
    hd_width: data.hd_width ?? existing?.hd_width,
    hd_height: data.hd_height ?? existing?.hd_height,
    storyboard_width: data.storyboard_width ?? existing?.storyboard_width,
    storyboard_height: data.storyboard_height ?? existing?.storyboard_height,
    fps: data.fps ?? existing?.fps,
    aspect_ratio: data.aspect_ratio ?? existing?.aspect_ratio,
    shot_type: data.shot_type ?? existing?.shot_type,
    lens_mm: data.lens_mm ?? existing?.lens_mm,
    camera_movement: data.camera_movement ?? existing?.camera_movement,
    depth_of_field: data.depth_of_field ?? existing?.depth_of_field,
    lighting: data.lighting ?? existing?.lighting,
    emotion: data.emotion ?? existing?.emotion,
  }
}

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

function jobHasFinalVideo(job) {
  const r = job.result
  return Boolean(r?.filename || r?.video_path || r?.video_url)
}

function jobHasStoryboard(job) {
  return (job.result?.storyboard?.length ?? 0) > 0
    || (job.result?.clips?.length ?? 0) > 0
    || Boolean(job.has_checkpoint)
}

/** Schermata corretta aprendo un job dalla lista (Dettagli / card). */
function resolveReelResumePhase(job) {
  if (job.storyboard_approved || job.pipeline_ui_phase === 'production') return 'production'
  const cp = job.checkpoint_phase ?? 0
  if (cp >= 55) return 'storyboard'
  return 'full'
}

function jobCanResumePipeline(job) {
  return Boolean(
    job.can_continue
    || job.can_resume
    || job.has_checkpoint
    || (job.checkpoint_phase ?? 0) > 0
    || jobHasStoryboard(job),
  )
}

function resolveReelJobView(job) {
  const hasMedia = jobHasStoryboard(job)
  if (job.status === 'awaiting_storyboard') return 'storyboard'
  if (job.status === 'done' || jobHasFinalVideo(job)) return 'done'
  if (job.status === 'running') {
    if (job.pipeline_ui_phase === 'production' || job.storyboard_approved) return 'generating'
    if ((job.checkpoint_phase ?? 0) >= 55 && !job.storyboard_approved) return 'storyboard'
    return 'generating'
  }
  if (job.status === 'interrupted') {
    if (jobCanResumePipeline(job)) return 'generating'
    if (hasMedia) return jobHasFinalVideo(job) ? 'done' : 'storyboard'
    return 'detail'
  }
  if (job.status === 'failed' && jobCanResumePipeline(job)) return 'generating'
  if (job.status === 'failed') {
    if (hasMedia) return jobHasFinalVideo(job) ? 'done' : 'storyboard'
    return 'detail'
  }
  if (hasMedia) return jobHasFinalVideo(job) ? 'done' : 'storyboard'
  return 'detail'
}

function reelSessionStorageKey(catalogProjectId) {
  return `reel_active_session_${catalogProjectId}`
}

/** Normalizza clip da API/checkpoint per anteprime e stato UI. */
function normalizeHydratedClips(clips, mediaProjectId, defaultStatus = 'waiting') {
  if (!clips?.length) return []
  return clips.map(c => {
    const sbUrl = c.storyboard_clip_url
      ? resolveBackendUrl(c.storyboard_clip_url)
      : clipReelStoryboardPreviewUrl(c, mediaProjectId)
    const frameUrl = resolveBackendUrl(c.frame_url)
      || (c.hd_frame_ready ? reelFrameClipUrl(mediaProjectId, c.clip_id) : null)
      || (c.status === 'storyboard' || c.storyboard_ok ? sbUrl : null)
    return {
      ...c,
      status: c.status || defaultStatus,
      frame_url: frameUrl,
      preview_url: c.preview_url || sbUrl,
      storyboard_url: c.storyboard_url || sbUrl,
      clip_url: c.clip_url ? resolveBackendUrl(c.clip_url) : c.clip_url,
    }
  })
}

function mapStoryboardFramesToClips(frames, mediaProjectId, clipStatus = 'storyboard') {
  return frames.map(f => ({
    ...f,
    clip_id: f.clip_id,
    slot_id: f.slot_id,
    status: f.storyboard_ok === false ? 'storyboard_failed' : clipStatus,
    storyboard_ok: f.storyboard_ok !== false,
    storyboard_placeholder: f.storyboard_placeholder === true,
    storyboard_path: f.path,
    storyboard_filename: f.storyboard_filename || `${f.clip_id}_sb.png`,
    storyboard_url: f.url,
    preview_url: f.preview_url || f.url,
    storyboard_clip_url: f.storyboard_clip_url,
    scene_prompt: f.scene_prompt,
    duration_sec: f.duration_sec,
  }))
}

function buildDirectorDataFromJob(job) {
  const dn = job.result?.director_narrative
  const sb = job.result?.storyboard ?? []
  if (!dn && !sb.length) return null
  return {
    logline: dn?.logline,
    mood: dn?.mood,
    visual_theme: dn?.visual_theme,
    slots: sb.length || dn?.visual_motifs?.length || 0,
    slot_details: sb.map(f => ({
      slot_id: f.slot_id || f.clip_id,
      emotion: f.emotion || '',
      visual_hint: f.scene_prompt || f.visual_hint || '',
      duration_sec: f.duration_sec,
      energy: f.energy || 'medium',
    })),
  }
}

function hasDirectorNarrative(dn) {
  if (!dn || typeof dn !== 'object') return false
  return Boolean(
    dn.logline || dn.mood || dn.narrative_arc || (dn.visual_motifs?.length > 0),
  )
}

function buildPhaseStatusFromJob(job) {
  const ps = {}
  const cp = job.checkpoint_phase ?? 0
  if (job.result?.vision || cp >= 1) ps.vision_analysis = 'done'
  if (hasDirectorNarrative(job.result?.director_narrative) || cp >= 3) ps.reel_director = 'done'
  if (job.result?.storyboard?.length || job.result?.clips?.length || cp >= 5) {
    ps.storyboard = 'done'
    ps.prompt_generator = 'done'
  }
  if (job.status === 'running' && job.pipeline_ui_phase === 'production') {
    ps.production = 'active'
  }
  if (jobHasFinalVideo(job)) {
    ps.prompt_generator = 'done'
    ps.production = 'done'
  }
  const stale = job.stale_running || (job.status === 'running' && job.task_running === false)
  if (stale) {
    if (cp >= 1 && cp < 3 && !ps.reel_director) ps.reel_director = 'active'
    else if (cp < 1) ps.vision_analysis = 'active'
    else if (cp >= 3 && cp < 5) ps.prompt_generator = 'active'
  } else if (job.status === 'running' && !Object.values(ps).includes('active')) {
    if (cp >= 1 && cp < 3) ps.reel_director = 'active'
    else if (cp < 1) ps.vision_analysis = 'active'
  }
  if (job.paused) {
    Object.keys(ps).forEach(k => { if (ps[k] === 'active') ps[k] = 'paused' })
  }
  return ps
}

const REEL_ASPECT_RATIO_OPTIONS = ['9:16', '16:9', '1:1', '4:3', '21:9']

/** Risoluzioni video (dal più basso al 4K) per formato; frame HD = 2× automatico. */
const REEL_VIDEO_RESOLUTIONS = {
  '9:16': [
    { tier: '360p', label: '360×640', w: 360, h: 640 },
    { tier: '540p', label: '540×960', w: 540, h: 960 },
    { tier: '720p', label: '720×1280', w: 720, h: 1280 },
    { tier: '1080p', label: '1080×1920', w: 1080, h: 1920 },
    { tier: '1440p', label: '1440×2560', w: 1440, h: 2560 },
    { tier: '4K', label: '2160×3840', w: 2160, h: 3840 },
  ],
  '16:9': [
    { tier: '360p', label: '640×360', w: 640, h: 360 },
    { tier: '540p', label: '960×540', w: 960, h: 540 },
    { tier: '720p', label: '1280×720', w: 1280, h: 720 },
    { tier: '1080p', label: '1920×1080', w: 1920, h: 1080 },
    { tier: '1440p', label: '2560×1440', w: 2560, h: 1440 },
    { tier: '4K', label: '3840×2160', w: 3840, h: 2160 },
  ],
  '1:1': [
    { tier: '480p', label: '480×480', w: 480, h: 480 },
    { tier: '720p', label: '720×720', w: 720, h: 720 },
    { tier: '1080p', label: '1080×1080', w: 1080, h: 1080 },
    { tier: '1440p', label: '1440×1440', w: 1440, h: 1440 },
    { tier: '2K', label: '2048×2048', w: 2048, h: 2048 },
    { tier: '4K', label: '3840×3840', w: 3840, h: 3840 },
  ],
  '4:3': [
    { tier: '480p', label: '640×480', w: 640, h: 480 },
    { tier: '600p', label: '800×600', w: 800, h: 600 },
    { tier: '768p', label: '1024×768', w: 1024, h: 768 },
    { tier: '960p', label: '1280×960', w: 1280, h: 960 },
    { tier: '1200p', label: '1600×1200', w: 1600, h: 1200 },
    { tier: '4K', label: '3840×2880', w: 3840, h: 2880 },
  ],
  '21:9': [
    { tier: '360p', label: '840×360', w: 840, h: 360 },
    { tier: '540p', label: '1280×548', w: 1280, h: 548 },
    { tier: '720p', label: '1680×720', w: 1680, h: 720 },
    { tier: '1080p', label: '2560×1080', w: 2560, h: 1080 },
    { tier: '1440p', label: '3440×1440', w: 3440, h: 1440 },
    { tier: '4K', label: '3840×1646', w: 3840, h: 1646 },
  ],
}

function reelVideoResolutions(aspectRatio) {
  return REEL_VIDEO_RESOLUTIONS[aspectRatio] ?? REEL_VIDEO_RESOLUTIONS['9:16']
}

function reelHdDimensions(videoW, videoH) {
  return { w: videoW * 2, h: videoH * 2 }
}

function reelDefaultVideoResolution(aspectRatio) {
  const list = reelVideoResolutions(aspectRatio)
  return list.find(r => r.tier === '1080p') ?? list[Math.floor(list.length / 2)] ?? list[0]
}

const REEL_FPS_OPTIONS = [24, 25, 30, 60]

const REEL_STORYBOARD_SIZE_OPTS = [
  { maxSide: 256, label: '256px', hint: 'Veloce' },
  { maxSide: 320, label: '320px', hint: 'Default' },
  { maxSide: 384, label: '384px', hint: 'Medio' },
  { maxSide: 512, label: '512px', hint: 'Dettaglio' },
  { maxSide: 640, label: '640px', hint: 'Alta anteprima' },
]

const REEL_STORYBOARD_STEPS_OPTS = [
  { steps: 6, label: 'Bassa', hint: '6 step — rapido' },
  { steps: 10, label: 'Media', hint: '10 step — bilanciato' },
  { steps: 15, label: 'Alta', hint: '15 step — qualità' },
  { steps: 20, label: 'Ultra', hint: '20 step — massima' },
]

const REEL_HD_FRAME_STEPS_OPTS = [
  { steps: 15, label: '15', hint: 'Veloce' },
  { steps: 20, label: '20', hint: 'Bilanciato' },
  { steps: 25, label: '25', hint: 'Default HD' },
  { steps: 30, label: '30', hint: 'Alta qualità' },
  { steps: 40, label: '40', hint: 'Massima' },
]

const REEL_MAX_CLIP_OPTS = [3, 4, 5, 6, 8, 10]

function reelStoryboardPixelSize(config) {
  const maxSide = config.storyboard_max_side ?? 320
  const w = config.width ?? 1080
  const h = config.height ?? 1920
  const scale = maxSide / Math.max(w, h, 1)
  return {
    w: Math.max(96, Math.round(w * scale)),
    h: Math.max(96, Math.round(h * scale)),
  }
}

const DEFAULT_CONFIG = {
  duration_sec: 30,
  aspect_ratio: '9:16',
  width: 1080,
  height: 1920,
  fps: 30,
  style: 'cinematic, photorealistic, dramatic lighting',
  storyboard_max_side: 320,
  storyboard_steps: 10,
  hd_frame_steps: 25,
  max_clip_sec: 5,
  concurrent_jobs: 1,
  clip_backend: 'auto',
  allow_ffmpeg_fallback: false,
  txt2img_workflow: 'z_image_turbo_txt2img',
  img2video_workflow: 'ltx_img2video',
  img_audio2video_workflow: 'ltx_img_audio2video',
}

function ReelDescriptionGenerator({ title, lyrics, style, audioAnalysis, refsCount, onApply }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const canRun = Boolean(lyrics?.trim() || title?.trim() || style?.trim() || audioAnalysis || refsCount > 0)

  async function generate() {
    if (!canRun) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/llm/generate-reel-description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title?.trim() || '',
          lyrics: lyrics?.trim() || '',
          style: style?.trim() || '',
          audio_analysis: audioAnalysis || null,
          refs_count: refsCount || 0,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.ok && data.description) {
        onApply(data.description.trim())
      } else {
        setError(data.error || (res.ok ? 'Nessuna descrizione ricevuta' : `Errore server (${res.status})`))
      }
    } catch (e) {
      setError(e.message || 'Errore di rete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <button
        type="button"
        onClick={generate}
        disabled={loading || !canRun}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-mono border border-[#c9a84c]/40 bg-[#c9a84c]/8 text-[#c9a84c] hover:bg-[#c9a84c]/15 disabled:opacity-40 transition-colors"
      >
        {loading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
        {loading ? 'Generazione in corso…' : 'Genera con AI'}
      </button>
      {!canRun && (
        <p className="text-[9px] font-mono text-[#555568]">
          Inserisci titolo, lirica o stile per abilitare la generazione AI.
        </p>
      )}
      {error && <p className="text-[9px] font-mono text-[#ef4444]">{error}</p>}
    </div>
  )
}

function ReelStyleImprover({ title, description, currentStyle, onApply }) {
  const [loading, setLoading] = useState(false)
  const [suggestion, setSuggestion] = useState(null)
  const [error, setError] = useState(null)

  const canRun = Boolean(description?.trim() || currentStyle?.trim())

  async function improve() {
    if (!canRun) return
    setLoading(true)
    setError(null)
    setSuggestion(null)
    try {
      const httpRes = await fetch(`${BACKEND_ORIGIN}/api/llm/improve-style`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title?.trim() || 'CreateReel',
          description: description?.trim() || '',
          current_style: currentStyle?.trim() || '',
          genre: 'reel',
        }),
      })
      const data = await httpRes.json().catch(() => ({}))
      const styleStr = typeof data.style === 'string'
        ? data.style.trim()
        : (data.style && typeof data.style === 'object'
          ? String(data.style.text || data.style.prompt || data.style.description || '').trim()
          : '')
      if (data.ok && styleStr) {
        setSuggestion({
          style: styleStr,
          rationale: typeof data.rationale === 'string' ? data.rationale : '',
        })
      } else {
        setError(data.error || (httpRes.ok ? 'Nessun suggerimento ricevuto' : `Errore server (${httpRes.status})`))
      }
    } catch (e) {
      setError(e.message || 'Errore di rete')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <GhostBtn onClick={improve} disabled={loading || !canRun}>
        {loading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
        {loading ? 'Analisi in corso…' : 'Analizza e migliora'}
      </GhostBtn>
      {!canRun && (
        <p className="text-[9px] font-mono text-[#555568]">
          Inserisci la descrizione del reel (e opzionalmente uno stile) per abilitare l&apos;analisi.
        </p>
      )}
      {error && <p className="text-[10px] font-mono text-[#ef4444]">{error}</p>}
      {suggestion && (
        <div className="rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5 p-3">
          <p className="text-[9px] font-mono text-[#9090a8] uppercase tracking-wider mb-1.5">
            Stile adattato alla descrizione
          </p>
          <p className="text-xs text-[#e8e4dd] leading-relaxed mb-1">{suggestion.style}</p>
          {suggestion.rationale && (
            <p className="text-[10px] font-mono text-[#9090a8] italic">{suggestion.rationale}</p>
          )}
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={() => { onApply(suggestion.style); setSuggestion(null) }}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono rounded bg-[#c9a84c]/20 hover:bg-[#c9a84c]/30 text-[#c9a84c]"
            >
              <Check size={10} /> Applica
            </button>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="text-[10px] font-mono text-[#555568] hover:text-[#9090a8]"
            >
              Ignora
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReelSettingsSection({ title, hint, children }) {
  return (
    <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
      <p className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider mb-1">{title}</p>
      {hint && (
        <p className="text-[9px] font-mono text-[#555568] mb-3 leading-relaxed">{hint}</p>
      )}
      {children}
    </div>
  )
}

function ReelProjectSettings({ config, setConfig }) {
  const sbSize = reelStoryboardPixelSize(config)
  const estClips = Math.max(1, Math.ceil((config.duration_sec || 30) / (config.max_clip_sec || 5)))
  const videoResList = reelVideoResolutions(config.aspect_ratio)
  const hdDims = reelHdDimensions(config.width, config.height)
  const selectedVideoKey = `${config.width}x${config.height}`

  function setAspectRatio(ar) {
    const def = reelDefaultVideoResolution(ar)
    setConfig(c => ({ ...c, aspect_ratio: ar, width: def.w, height: def.h }))
  }

  function setVideoResolution(w, h) {
    setConfig(c => ({ ...c, width: w, height: h }))
  }

  return (
    <div className="space-y-4 mb-6">
      <ReelSettingsSection
        title="Anteprima storyboard"
        hint="Risoluzione e step ComfyUI per le immagini di preview prima dell'approvazione."
      >
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-mono text-[#9090a8]">Risoluzione anteprima</label>
            <span className="text-[10px] font-mono text-[#c9a84c]">{sbSize.w}×{sbSize.h}px</span>
          </div>
          <div className="grid grid-cols-5 gap-1">
            {REEL_STORYBOARD_SIZE_OPTS.map(opt => (
              <button
                key={opt.maxSide}
                type="button"
                title={opt.hint}
                onClick={() => setConfig(c => ({ ...c, storyboard_max_side: opt.maxSide }))}
                className={clsx(
                  'py-1.5 rounded text-[9px] font-mono border transition-colors',
                  (config.storyboard_max_side ?? 320) === opt.maxSide
                    ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                    : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[9px] font-mono text-[#555568] mt-1">
            Lato lungo max · proporzioni {config.aspect_ratio}
          </p>
        </div>
        <div>
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Step anteprima</label>
          <div className="grid grid-cols-4 gap-1">
            {REEL_STORYBOARD_STEPS_OPTS.map(opt => (
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
        </div>
      </ReelSettingsSection>

      <ReelSettingsSection
        title="Video finale"
        hint="Formato e risoluzione di uscita (da SD a 4K). I frame HD saranno sempre al doppio."
      >
        <div className="mb-4">
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Formato video</label>
          <div className="grid grid-cols-5 gap-1">
            {REEL_ASPECT_RATIO_OPTIONS.map(ar => (
              <button
                key={ar}
                type="button"
                onClick={() => setAspectRatio(ar)}
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
        <div className="mb-4">
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">
            Risoluzione video
          </label>
          <div className="flex flex-col gap-1">
            {videoResList.map(r => {
              const hd = reelHdDimensions(r.w, r.h)
              const key = `${r.w}x${r.h}`
              const active = selectedVideoKey === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setVideoResolution(r.w, r.h)}
                  className={clsx(
                    'flex items-center justify-between gap-2 px-3 py-2 rounded border text-left transition-colors',
                    active
                      ? 'bg-[#c9a84c]/12 border-[#c9a84c]/50'
                      : 'border-[#252533] hover:border-[#32324a]',
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={clsx(
                      'text-[8px] font-mono uppercase px-1 py-0.5 rounded shrink-0',
                      active ? 'bg-[#c9a84c]/25 text-[#e6c46a]' : 'bg-[#1e1e2a] text-[#555568]',
                    )}>
                      {r.tier}
                    </span>
                    <span className={clsx('text-[11px] font-mono truncate', active ? 'text-[#e8e4dd]' : 'text-[#9090a8]')}>
                      {r.label}
                    </span>
                  </span>
                  <span className="text-[9px] font-mono text-[#555568] shrink-0">
                    HD {hd.w}×{hd.h}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        <p className="text-[9px] font-mono text-[#9090a8] mb-3">
          Uscita {config.width}×{config.height}px · {config.fps} fps
        </p>
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] font-mono text-[#9090a8]">Durata reel</label>
            <span className="text-[10px] font-mono text-[#c9a84c]">{config.duration_sec}s</span>
          </div>
          <input
            type="range"
            min={8}
            max={180}
            step={1}
            value={config.duration_sec}
            onChange={e => setConfig(c => ({ ...c, duration_sec: Number(e.target.value) }))}
            className="w-full accent-[#c9a84c]"
          />
          <div className="flex justify-between text-[9px] font-mono text-[#555568] mt-0.5">
            <span>8s</span><span>180s</span>
          </div>
        </div>
        <div className="mb-4">
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">FPS video</label>
          <div className="grid grid-cols-4 gap-1">
            {REEL_FPS_OPTIONS.map(fps => (
              <button
                key={fps}
                type="button"
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
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[10px] font-mono text-[#9090a8]">Durata massima clip</label>
            <span className="text-[10px] font-mono text-[#c9a84c]">{config.max_clip_sec}s</span>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {REEL_MAX_CLIP_OPTS.map(sec => (
              <button
                key={sec}
                type="button"
                onClick={() => setConfig(c => ({ ...c, max_clip_sec: sec }))}
                className={clsx(
                  'py-1.5 rounded text-[9px] font-mono border transition-colors',
                  config.max_clip_sec === sec
                    ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                    : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                )}
              >
                {sec}s
              </button>
            ))}
          </div>
          <p className="text-[9px] font-mono text-[#555568] mt-1">
            ~{estClips} clip stimate per reel da {config.duration_sec}s
          </p>
        </div>
        <div className="mt-4">
          <ReelEstimatedClipStrip config={config} sbSize={sbSize} hdSize={hdDims} />
        </div>
      </ReelSettingsSection>

      <ReelSettingsSection
        title="Frame HD (first / last)"
        hint="Risoluzione frame sempre 2× rispetto al video scelto sopra (generata automaticamente)."
      >
        <div className="mb-4 rounded-lg border border-[#32324a] bg-[#0f0f18] px-3 py-2.5">
          <p className="text-[10px] font-mono text-[#9090a8] mb-1">Risoluzione frame HD (2× video)</p>
          <p className="text-sm font-mono text-[#e6c46a]">
            {hdDims.w}×{hdDims.h}px
          </p>
          <p className="text-[9px] font-mono text-[#555568] mt-1">
            Video {config.width}×{config.height} → frame {hdDims.w}×{hdDims.h} · formato {config.aspect_ratio}
          </p>
        </div>
        <div>
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1.5">Step frame HD</label>
          <div className="grid grid-cols-5 gap-1">
            {REEL_HD_FRAME_STEPS_OPTS.map(opt => (
              <button
                key={opt.steps}
                type="button"
                title={opt.hint}
                onClick={() => setConfig(c => ({ ...c, hd_frame_steps: opt.steps }))}
                className={clsx(
                  'py-1.5 rounded text-[9px] font-mono border transition-colors',
                  (config.hd_frame_steps ?? 25) === opt.steps
                    ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]'
                    : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]',
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </ReelSettingsSection>
    </div>
  )
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

function WorkflowSelector({ config, setConfig, hasAudio }) {
  const [workflows, setWorkflows] = useState(null)

  useEffect(() => {
    fetch(`${BACKEND_ORIGIN}/api/reel/workflows`)
      .then(r => r.json())
      .then(setWorkflows)
      .catch(() => {})
  }, [])

  if (!workflows) return null

  const selectClass = 'w-full bg-[#0f0f18] border border-[#252533] rounded px-2 py-1.5 text-[11px] font-mono text-[#e8e4dd] focus:outline-none focus:border-[#c9a84c]/50'

  return (
    <ReelSettingsSection
      title="Workflow ComfyUI"
      hint="Scegli quale workflow usare per ogni fase di generazione."
    >
      <div className="space-y-3">
        <div>
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1">Immagine (txt2img)</label>
          <select
            value={config.txt2img_workflow}
            onChange={e => setConfig(c => ({ ...c, txt2img_workflow: e.target.value }))}
            className={selectClass}
          >
            {workflows.txt2img.map(wf => (
              <option key={wf.id} value={wf.id}>{wf.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-mono text-[#9090a8] block mb-1">Video (img2video)</label>
          <select
            value={config.img2video_workflow}
            onChange={e => setConfig(c => ({ ...c, img2video_workflow: e.target.value }))}
            className={selectClass}
          >
            {workflows.img2video.map(wf => (
              <option key={wf.id} value={wf.id}>{wf.name}</option>
            ))}
          </select>
        </div>
        {hasAudio && (
          <div>
            <label className="text-[10px] font-mono text-[#9090a8] block mb-1">
              Video + Audio (img+audio→video)
            </label>
            <select
              value={config.img_audio2video_workflow}
              onChange={e => setConfig(c => ({ ...c, img_audio2video_workflow: e.target.value }))}
              className={selectClass}
            >
              {workflows.img_audio2video.map(wf => (
                <option key={wf.id} value={wf.id}>{wf.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </ReelSettingsSection>
  )
}

function ClipPreviewCell({ clip, projectId, jobId, aspectRatio = '9:16' }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)
  const isPlaceholder = clip?.storyboard_placeholder || clip?.storyboard_ok === false
  const preferHd = clip?.hd_frame_ready || clip?.clip_phase === 'frame_gen' || clip?.clip_phase === 'video_gen' || clip?.status === 'done'
  const awaitingAsset = clip?.status === 'waiting'
    || (clip?.status === 'generating' && clip?.clip_phase === 'storyboard')
    || (clip?.status === 'generating' && !preferHd && !clip?.storyboard_path)

  useEffect(() => {
    let cancelled = false
    setFailed(false)

    async function load() {
      const localPath = clip?.first_frame_path || clip?.storyboard_path
      if (localPath && window.studio?.reel?.readImageLocal) {
        const r = await window.studio.reel.readImageLocal(localPath)
        if (!cancelled && r?.ok && r.dataUrl) {
          setFailed(false)
          setSrc(r.dataUrl)
          return
        }
      }

      if (awaitingAsset && !localPath) {
        if (!cancelled) {
          setFailed(false)
          setSrc(null)
        }
        return
      }

      const mediaIds = [projectId, jobId && `reel_${jobId}`, 'reel_standalone'].filter(Boolean)
      const seen = new Set()
      const urls = []
      for (const pid of mediaIds) {
        if (seen.has(pid)) continue
        seen.add(pid)
        const sb = clipReelStoryboardPreviewUrl(clip, pid)
        if (sb) urls.push(sb)
        if (preferHd) {
          const hd = clipReelFramePreviewUrl(clip, pid)
          if (hd) urls.unshift(hd)
        }
      }
      if (clip?.frame_url) {
        const resolved = resolveBackendUrl(clip.frame_url) || clip.frame_url
        if (resolved && !urls.includes(resolved)) urls.unshift(resolved)
      }
      if (clip?.preview_url) {
        const resolved = resolveBackendUrl(clip.preview_url)
        if (resolved && !urls.includes(resolved)) urls.unshift(resolved)
      }

      if (!urls.length) {
        if (!cancelled) {
          setFailed(false)
          setSrc(null)
        }
        return
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
        if (!cancelled && clip?.status === 'storyboard_failed') {
          setFailed(true)
        }
      } else {
        // Fallback per caricamento diretto in browser
        const httpUrl = urls[0]
        if (!cancelled && httpUrl) {
          const sep = httpUrl.includes('?') ? '&' : '?'
          setFailed(false)
          setSrc(`${httpUrl}${sep}v=${retry}`)
          return
        }
      }
      if (!cancelled) setSrc(null)
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
    awaitingAsset,
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
    awaitingAsset
    || clip?.status === 'storyboard'
    || (clip?.status === 'generating' && !preferHd)
  )

  if (loading) {
    const phaseLabel = clip?.clip_phase === 'video_gen' ? 'Generando video…'
      : clip?.clip_phase === 'frame_gen' ? 'Generando frame…'
      : null
    const isActive = clip?.status === 'generating' && clip?.comfyuiPct > 0
    return (
      <div className={clsx(
        'w-full h-full flex flex-col items-center justify-center gap-1 bg-[#0f0f18] relative',
        isActive && 'ring-1 ring-[#c9a84c]/60',
      )}>
        <Loader2 size={14} className="text-[#c9a84c] animate-spin" />
        {phaseLabel && (
          <span className="text-[7px] font-mono text-[#9090a8] px-1 text-center leading-tight">{phaseLabel}</span>
        )}
        {clip?.comfyuiPct > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1e1e2a]">
            <div className="h-full bg-[var(--gold)] transition-all" style={{ width: `${clip.comfyuiPct || 0}%` }} />
          </div>
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
    <>
      <div
        className="w-full h-full cursor-zoom-in relative group"
        onClick={() => setModalOpen(true)}
      >
        <img
          src={src}
          alt={clip?.clip_id}
          className="w-full h-full object-cover"
          onError={() => {
            if (retry < 4) setRetry(r => r + 1)
            else { setSrc(null); setFailed(true) }
          }}
        />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white/90 backdrop-blur-[1px]">
          <Maximize2 size={14} className="scale-75 group-hover:scale-100 transition-transform duration-200" />
        </div>
      </div>

      {modalOpen && (
        <ImageLightbox
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          items={[{ src, alt: `Inquadratura ${clip?.slot_id || clip?.clip_id || ''} - Anteprima Storyboard` }]}
        />
      )}
    </>
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
      <p className="text-[9px] font-mono text-[#9090a8]">Anteprime {withImage}/{clips.length}</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
        {sorted.map(clip => (
          <div key={clip.clip_id} className={clsx(
            'rounded-lg overflow-hidden border bg-[#16161f]',
            (clip.status === 'done' || clip.status === 'frame_ready' || clip.hd_frame_ready) && 'border-[#22c55e]/50',
            clip.status === 'storyboard' && 'border-[#3b82f6]/40',
            clip.status === 'storyboard_failed' && 'border-[#f59e0b]/50',
            clip.status === 'generating' && 'border-[#c9a84c]/50',
            clip.status === 'waiting' && 'border-[#252533]',
          )}>
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

function ClipDetailCard({ clip, projectId, jobId, aspectRatio, onSave, onRegen, regenning = false }) {
  const isPortrait = aspectRatio === '9:16'
  const [framePrompt, setFramePrompt]   = useState(clip.first_frame_prompt || '')
  const [motionPrompt, setMotionPrompt] = useState(clip.motion_prompt || '')
  const [saving, setSaving]             = useState(false)
  const [saved, setSaved]               = useState(false)
  const [expanded, setExpanded]         = useState(false)

  // Sync when clip updates externally (prompt changes from pipeline)
  useEffect(() => { setFramePrompt(clip.first_frame_prompt || '') }, [clip.first_frame_prompt])
  useEffect(() => { setMotionPrompt(clip.motion_prompt || '')     }, [clip.motion_prompt])

  const isDirty = framePrompt !== (clip.first_frame_prompt || '') ||
                  motionPrompt !== (clip.motion_prompt || '')

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(clip.clip_id, { first_frame_prompt: framePrompt, motion_prompt: motionPrompt })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const statusColor = {
    done: 'border-[#22c55e]/60',
    storyboard: 'border-[#3b82f6]/40',
    storyboard_failed: 'border-[#f59e0b]/50',
    generating: 'border-[#c9a84c]/60',
    waiting: 'border-[#252533]',
  }[clip.status] || 'border-[#252533]'

  return (
    <div className={clsx('rounded-xl border bg-[#16161f] flex flex-col overflow-hidden transition-colors', statusColor)}>
      {/* Image preview */}
      <div className="relative shrink-0" style={{ aspectRatio: isPortrait ? '9/16' : '16/9', maxHeight: isPortrait ? 220 : 140 }}>
        <ClipPreviewCell clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} />
        {/* Status overlay badge */}
        <div className="absolute top-1.5 left-1.5">
          {clip.status === 'done'       && <span className="text-[7px] font-mono px-1.5 py-0.5 rounded bg-[#22c55e]/80 text-black">Completato</span>}
          {clip.status === 'generating' && <span className="text-[7px] font-mono px-1.5 py-0.5 rounded bg-[#c9a84c]/80 text-black flex items-center gap-1"><Loader2 size={7} className="animate-spin" />Gen…</span>}
          {clip.status === 'storyboard' && <span className="text-[7px] font-mono px-1.5 py-0.5 rounded bg-[#3b82f6]/80 text-white">Storyboard</span>}
        </div>
        {/* ComfyUI progress bar */}
        {clip.comfyuiPct > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#0f0f18]/60">
            <div className="h-full bg-[#c9a84c] transition-all" style={{ width: `${clip.comfyuiPct}%` }} />
          </div>
        )}
      </div>

      {/* Clip name + shot info */}
      <div className="px-3 py-2 border-b border-[#252533]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-mono text-[#c9a84c] truncate">{clip.clip_id}</p>
            {clip.slot_id && clip.slot_id !== clip.clip_id && (
              <p className="text-[8px] font-mono text-[#555568] truncate">{clip.slot_id}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="shrink-0 p-0.5 rounded text-[#555568] hover:text-[#9090a8]"
            title={expanded ? 'Comprimi' : 'Espandi prompt'}
          >
            {expanded ? <ChevronUp size={11} /> : <Edit3 size={11} />}
          </button>
        </div>
        {clip.scene_prompt && (
          <p className="mt-1 text-[9px] text-[#9090a8] leading-relaxed line-clamp-2">{clip.scene_prompt}</p>
        )}
      </div>

      {/* Prompt editors — collapsible */}
      {expanded && (
        <div className="px-3 py-2 space-y-2 border-b border-[#252533] bg-[#0f0f18]">
          <div>
            <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Frame prompt (txt2img)</p>
            <textarea
              value={framePrompt}
              onChange={e => setFramePrompt(e.target.value)}
              rows={4}
              className="w-full text-[10px] bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-[#e8e4dd] resize-y font-mono leading-relaxed focus:border-[#c9a84c]/50 outline-none"
              placeholder="Prompt immagine…"
            />
          </div>
          <div>
            <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Motion prompt (img2video)</p>
            <textarea
              value={motionPrompt}
              onChange={e => setMotionPrompt(e.target.value)}
              rows={3}
              className="w-full text-[10px] bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-[#e8e4dd] resize-y font-mono leading-relaxed focus:border-[#c9a84c]/50 outline-none"
              placeholder="Motion prompt…"
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-3 py-2 flex gap-1.5 mt-auto">
        {expanded && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className={clsx(
              'flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-[9px] font-mono border transition-colors',
              saved
                ? 'border-[#22c55e]/50 text-[#22c55e] bg-[#22c55e]/10'
                : isDirty
                  ? 'border-[#c9a84c]/50 text-[#c9a84c] hover:bg-[#c9a84c]/10'
                  : 'border-[#252533] text-[#555568]',
            )}
          >
            {saving ? <Loader2 size={9} className="animate-spin" /> : <Save size={9} />}
            {saved ? 'Salvato' : 'Salva'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onRegen(clip.clip_id)}
          disabled={regenning}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-[9px] font-mono border border-[#32324a] text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#c9a84c]/40 disabled:opacity-40 transition-colors"
        >
          {regenning
            ? <Loader2 size={9} className="animate-spin text-[#c9a84c]" />
            : <RotateCcw size={9} />}
          Rigenera
        </button>
      </div>
    </div>
  )
}

function JobsListView({ projectId, refreshKey, onNew, onViewDetail, onResumeJob }) {
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
      if (res.ok || res.status === 404) {
        setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
      } else {
        const data = await res.json().catch(() => ({}))
        alert(`Errore eliminazione: ${data.detail || res.statusText}`)
      }
    } catch (err) {
      alert(`Errore eliminazione: ${err.message}`)
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
              const showResume = ['interrupted', 'failed'].includes(job.status) && jobCanResumePipeline(job)
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
                    {showResume && onResumeJob && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onResumeJob(job) }}
                        className="flex-1 py-1.5 rounded text-[9px] font-mono border border-[#c9a84c]/40 bg-[#c9a84c]/10 text-[#c9a84c] hover:bg-[#c9a84c]/20"
                      >
                        <RotateCcw size={9} className="inline mr-0.5" />
                        Riprendi
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onViewDetail(job) }}
                      className={clsx(
                        'py-1.5 rounded text-[9px] font-mono border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd]',
                        showResume ? 'px-2' : 'flex-1',
                      )}
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

function JobDetailView({ job, projectId, onBack, onOpenReview, onResumePipeline, onRestartFromScratch, onDelete }) {
  const [deleting, setDeleting] = useState(false)
  const [fullJob, setFullJob] = useState(job)
  const [loadingJob, setLoadingJob] = useState(false)
  const videoSrc = reelVideoUrl(fullJob)
  const storageId = fullJob.storage_project_id || fullJob.project_id
  const canReview = jobHasStoryboard(fullJob) || fullJob.status === 'awaiting_storyboard' || jobHasFinalVideo(fullJob)
  const isLive = fullJob.status === 'running' || fullJob.status === 'awaiting_storyboard'
  const canResume = ['interrupted', 'failed'].includes(fullJob.status) && jobCanResumePipeline(fullJob)

  useEffect(() => {
    let cancelled = false
    setLoadingJob(true)
    ;(async () => {
      try {
        const res = await fetch(
          `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${encodeURIComponent(job.job_id)}`,
        )
        if (res.ok && !cancelled) setFullJob(await res.json())
      } catch { /* keep list snapshot */ }
      finally {
        if (!cancelled) setLoadingJob(false)
      }
    })()
    return () => { cancelled = true }
  }, [projectId, job.job_id])
  const reviewLabel = fullJob.status === 'awaiting_storyboard'
    ? 'Revisione storyboard'
    : isLive
      ? 'Riprendi monitoraggio pipeline'
      : jobHasFinalVideo(fullJob)
        ? 'Anteprime e reel'
        : 'Anteprime e vision'

  async function handleDelete() {
    setDeleting(true)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=true`,
        { method: 'DELETE' },
      )
      if (res.ok || res.status === 404) {
        onDelete()
      } else {
        const data = await res.json().catch(() => ({}))
        alert(`Errore eliminazione: ${data.detail || res.statusText}`)
      }
    } catch (err) {
      alert(`Errore eliminazione: ${err.message}`)
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
          {canResume && onResumePipeline && (
            <GoldBtn onClick={() => onResumePipeline(fullJob)} disabled={loadingJob}>
              <RotateCcw size={13} />
              Riprendi pipeline
            </GoldBtn>
          )}
          {canReview && (
            <GoldBtn onClick={() => onOpenReview(fullJob)} disabled={loadingJob}>
              <LayoutGrid size={13} />
              {reviewLabel}
            </GoldBtn>
          )}
          {isLive && (
            <GhostBtn onClick={() => onOpenReview(fullJob)}>
              <Loader2 size={12} className={loadingJob ? 'animate-spin' : ''} />
              Stato live
            </GhostBtn>
          )}
          <GhostBtn onClick={() => onRestartFromScratch(job)}>
            <RefreshCw size={12} />
            Rigenera da zero
          </GhostBtn>
          <GhostBtn onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
            Elimina
          </GhostBtn>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-2xl">
        <div className="flex items-center gap-2">
          <StatusBadge status={fullJob.status} />
          <code className="text-[10px] text-[#c9a84c]">{fullJob.job_id}</code>
          {fullJob.progress_pct != null && (
            <span className="text-[10px] font-mono text-[#c9a84c]">{Math.round(fullJob.progress_pct)}%</span>
          )}
        </div>
        <p className="text-sm text-[#e8e4dd]">{fullJob.description || '—'}</p>
        <p className="text-[10px] font-mono text-[#555568]">Cartella: {storageId}</p>
        {videoSrc && (
          <video src={videoSrc} controls className="w-full max-w-sm rounded-lg border border-[#252533]" />
        )}
        {(fullJob.result?.clips?.length || fullJob.result?.storyboard?.length) > 0 && (
          <p className="text-[10px] font-mono text-[#9090a8]">
            {fullJob.result?.clips?.length
              ? `${fullJob.result.clips.length} clip in checkpoint`
              : `${fullJob.result.storyboard.length} frame storyboard`}
          </p>
        )}
        {fullJob.error && (
          <p className="text-xs text-[#ef4444] font-mono">{fullJob.error}</p>
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

function CharacterReelSelector({ mode, setMode, selectedId, setSelectedId }) {
  const [characters, setCharacters] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${BACKEND_ORIGIN}/api/characters/?ready_only=true`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) setCharacters(Array.isArray(data) ? data : [])
      })
      .catch(() => { if (!cancelled) setCharacters([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const needsCharacter = mode === 'character' || mode === 'character_reference'

  return (
    <div className="mb-6 rounded-lg border border-[#252533] bg-[#16161f] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <UserRound size={14} className="text-[#c9a84c]" />
          <span className="text-[10px] font-mono text-[#9090a8] uppercase tracking-wider">
            Personaggio CreateReel
          </span>
        </div>
        {loading && <Loader2 size={12} className="animate-spin text-[#9090a8]" />}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 mb-3">
        {CHARACTER_MODES.map(opt => (
          <button
            key={opt.key}
            type="button"
            onClick={() => setMode(opt.key)}
            className={clsx(
              'px-2 py-1.5 rounded border text-[11px]',
              mode === opt.key
                ? 'border-[#c9a84c] bg-[#c9a84c]/10 text-[#c9a84c]'
                : 'border-[#252533] text-[#9090a8] hover:text-[#e8e4dd]',
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {needsCharacter && (
        <select
          value={selectedId || ''}
          onChange={e => setSelectedId(e.target.value)}
          className="w-full bg-[#0f0f18] border border-[#252533] rounded px-2.5 py-2 text-xs text-[#e8e4dd]"
        >
          <option value="">Seleziona personaggio completato</option>
          {characters.map(c => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.profile} · {c.valid_image_count} foto
            </option>
          ))}
        </select>
      )}
      <p className="mt-2 text-[9px] font-mono text-[#555568]">
        La modalita personaggio creato inietta reference, caption e regole di continuita nei prompt e nei workflow video.
      </p>
    </div>
  )
}


const BACKEND_ORIGIN_REEL = BACKEND_ORIGIN
const LS_REEL_OVERRIDES_KEY = (wfId) => `cinematic_model_overrides_${wfId}`

function loadWorkflowOverrides(wfId) {
  if (!wfId) return null
  try { return JSON.parse(localStorage.getItem(LS_REEL_OVERRIDES_KEY(wfId)) || 'null') }
  catch { return null }
}

function ModelOverridesSection({ config, onChange }) {
  const [open, setOpen] = useState(false)
  const [nodeModels, setNodeModels] = useState(null)
  const [wfModelNodes, setWfModelNodes] = useState({})
  const [loadingModels, setLoadingModels] = useState(false)

  // Per-reel overrides state: {txt2img: {...}, video: {...}}
  const [overrides, setOverrides] = useState(() => {
    const t2i = loadWorkflowOverrides(config.txt2img_workflow) || {}
    const vid = loadWorkflowOverrides(config.img2video_workflow) || {}
    return { txt2img: t2i, video: vid }
  })

  // Reset when workflow IDs change
  useEffect(() => {
    setOverrides({
      txt2img: loadWorkflowOverrides(config.txt2img_workflow) || {},
      video:   loadWorkflowOverrides(config.img2video_workflow) || {},
    })
  }, [config.txt2img_workflow, config.img2video_workflow])

  // Bubble up to parent
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
      const res = await fetch(`${BACKEND_ORIGIN_REEL}/api/comfyui/nodes/0/models`)
      const data = await res.json()
      setNodeModels(data)
      // Also fetch model nodes for both workflow IDs
      const wfIds = [config.txt2img_workflow, config.img2video_workflow].filter(Boolean)
      const results = {}
      await Promise.all(wfIds.map(async (id) => {
        try {
          const r = await fetch(`${BACKEND_ORIGIN_REEL}/api/comfyui/workflow/${id}/model-nodes`)
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

  const checkpoints  = nodeModels?.checkpoints  || []
  const videoModels  = nodeModels?.video_models || []
  const loras        = nodeModels?.loras        || []

  const t2iNodes  = wfModelNodes[config.txt2img_workflow]
  const vidNodes  = wfModelNodes[config.img2video_workflow]
  const cpNodes   = t2iNodes?.checkpoint_nodes  || []
  const vmNodes   = vidNodes?.video_model_nodes || []
  const loraNodes = vidNodes?.lora_nodes        || []

  const hasOverrides = !!(overrides.txt2img?.checkpoint || overrides.video?.video_model ||
    (overrides.video?.loras || []).some(l => l?.lora_name))

  return (
    <div className="mb-6 rounded-lg border border-[#252533] overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-4 py-3 bg-[#16161f] hover:bg-[#1e1e2a] transition-colors"
      >
        <Settings2 size={13} className="text-[#9090a8] shrink-0" />
        <span className="text-[11px] font-mono text-[#9090a8] flex-1 text-left">
          Modelli & LoRA (override opzionale)
        </span>
        {hasOverrides && (
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#c9a84c]/10 border border-[#c9a84c]/30 text-[#c9a84c]">
            override attivo
          </span>
        )}
        <ChevronDown size={13} className={"text-[#555568] transition-transform " + (open ? "rotate-180" : "")} />
      </button>

      {open && (
        <div className="border-t border-[#252533] bg-[#0f0f18] p-4 space-y-4">
          {loadingModels && (
            <div className="flex items-center gap-2 text-[#555568]">
              <Loader2 size={13} className="animate-spin" />
              <span className="text-[10px] font-mono">Caricamento modelli dal nodo...</span>
            </div>
          )}

          {!loadingModels && nodeModels && (
            <>
              {/* Checkpoint (txt2img) */}
              {(cpNodes.length > 0 || checkpoints.length > 0) && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#3b82f6] shrink-0" />
                    <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-wider">Checkpoint (txt2img)</span>
                    {cpNodes[0]?.current_value && (
                      <span className="ml-auto text-[8px] font-mono text-[#555568] truncate max-w-[160px]">{cpNodes[0].current_value}</span>
                    )}
                  </div>
                  <select
                    value={overrides.txt2img?.checkpoint || ''}
                    onChange={e => setOverrides(o => ({ ...o, txt2img: { ...o.txt2img, checkpoint: e.target.value || undefined } }))}
                    className="w-full text-[11px] bg-[#16161f] text-[#e8e4dd] rounded px-2.5 py-2 border border-[#252533] font-mono"
                  >
                    <option value="">(dal workflow JSON)</option>
                    {checkpoints.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}

              {/* Video Model (img2video) */}
              {(vmNodes.length > 0 || videoModels.length > 0) && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#a78bfa] shrink-0" />
                    <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-wider">Video Model (img2video)</span>
                    {vmNodes[0]?.current_value && (
                      <span className="ml-auto text-[8px] font-mono text-[#555568] truncate max-w-[160px]">{vmNodes[0].current_value}</span>
                    )}
                  </div>
                  <select
                    value={overrides.video?.video_model || ''}
                    onChange={e => setOverrides(o => ({ ...o, video: { ...o.video, video_model: e.target.value || undefined } }))}
                    className="w-full text-[11px] bg-[#16161f] text-[#e8e4dd] rounded px-2.5 py-2 border border-[#252533] font-mono"
                  >
                    <option value="">(dal workflow JSON)</option>
                    {videoModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              )}

              {/* LoRAs */}
              {loraNodes.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] shrink-0" />
                    <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-wider">
                      LoRA ({loraNodes.length} slot nel workflow)
                    </span>
                  </div>
                  <div className="space-y-3">
                    {loraNodes.map((loraNode, idx) => {
                      const ov = (overrides.video?.loras || [])[idx] || {}
                      const smVal = ov.strength_model ?? loraNode.strength_model ?? 1.0
                      const scVal = ov.strength_clip  ?? loraNode.strength_clip  ?? 1.0
                      return (
                        <div key={loraNode.node_id} className="rounded border border-[#252533] bg-[#16161f] p-3 space-y-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">Slot {idx + 1}</span>
                            {loraNode.current_value && <span className="text-[8px] font-mono text-[#555568] truncate">{loraNode.current_value}</span>}
                          </div>
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
                            className="w-full text-[11px] bg-[#0f0f18] text-[#e8e4dd] rounded px-2 py-1.5 border border-[#252533] font-mono"
                          >
                            <option value="">(dal workflow JSON)</option>
                            {loras.map(l => <option key={l} value={l}>{l}</option>)}
                          </select>
                          <div className="grid grid-cols-2 gap-3">
                            {[['strength_model', smVal], ['strength_clip', scVal]].map(([field, val]) => (
                              <div key={field}>
                                <div className="flex justify-between mb-1">
                                  <span className="text-[8px] font-mono text-[#555568]">{field}</span>
                                  <span className="text-[8px] font-mono text-[#c9a84c]">{parseFloat(val).toFixed(2)}</span>
                                </div>
                                <input
                                  type="range" min={0} max={1.5} step={0.05}
                                  value={parseFloat(val)}
                                  onChange={e => {
                                    setOverrides(o => {
                                      const ls = [...(o.video?.loras || [])]
                                      if (!ls[idx]) ls[idx] = { lora_name: '', strength_model: 1.0, strength_clip: 1.0 }
                                      ls[idx] = { ...ls[idx], [field]: parseFloat(e.target.value) }
                                      return { ...o, video: { ...o.video, loras: ls } }
                                    })
                                  }}
                                  className="w-full h-1.5 accent-[#c9a84c] cursor-pointer"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {cpNodes.length === 0 && vmNodes.length === 0 && loraNodes.length === 0 && checkpoints.length === 0 && videoModels.length === 0 && (
                <p className="text-[10px] font-mono text-[#555568] italic text-center py-2">
                  Nessun modello trovato. Assicurati che un nodo ComfyUI sia online.
                </p>
              )}
            </>
          )}
        </div>
      )}
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

function ClipPromptCard({ clip, index, onSave }) {
  const [modalOpen, setModalOpen] = useState(false)
  const [draft, setDraft] = useState({
    scene_prompt: clip.scene_prompt || '',
    first_frame_prompt: clip.first_frame_prompt || '',
    last_frame_prompt: clip.last_frame_prompt || '',
    motion_prompt: clip.motion_prompt || '',
    ltx_video_prompt: clip.ltx_video_prompt || '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const rows = [
    clip.first_frame_prompt && { label: 'First', value: clip.first_frame_prompt },
    clip.motion_prompt && { label: 'Motion', value: clip.motion_prompt, accent: true },
    clip.scene_prompt && { label: 'Scena', value: clip.scene_prompt },
  ].filter(Boolean)

  const isDirty = Object.keys(draft).some(k => (draft[k] || '') !== (clip[k] || ''))

  async function handleSave() {
    if (!onSave) return
    setSaving(true)
    try {
      const payload = {}
      Object.keys(draft).forEach(k => {
        if ((draft[k] || '') !== (clip[k] || '')) payload[k] = draft[k] || ''
      })
      await onSave(clip.clip_id, payload)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      setModalOpen(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded bg-[#0f0f18] border border-[#252533] px-2 py-1.5">
      <div className="flex items-center gap-2 min-w-0 mb-1">
        <span className="text-[9px] font-mono text-[#c9a84c] shrink-0">#{String(index + 1).padStart(2, '0')}</span>
        <span className="text-[9px] font-mono text-[#555568] truncate">{clip.clip_id}</span>
      </div>
      <div className="space-y-1 mb-1.5">
        {rows.map(r => (
          <PromptPreviewRow key={r.label} label={r.label} value={r.value} accent={r.accent} />
        ))}
      </div>
      {onSave && (
        <button
          type="button"
          onClick={() => { setDraft({
            scene_prompt: clip.scene_prompt || '',
            first_frame_prompt: clip.first_frame_prompt || '',
            last_frame_prompt: clip.last_frame_prompt || '',
            motion_prompt: clip.motion_prompt || '',
            ltx_video_prompt: clip.ltx_video_prompt || '',
          }); setModalOpen(true) }}
          className="w-full text-[8px] font-mono text-[#9090a8] hover:text-[#c9a84c] py-0.5"
        >
          Apri prompt…
        </button>
      )}
      <ReelPromptEditorModal
        open={modalOpen}
        clipId={clip.clip_id}
        draft={draft}
        setDraft={setDraft}
        hasLastFrame={Boolean((clip.last_frame_prompt || '').trim())}
        saving={saving}
        saved={saved}
        isDirty={isDirty}
        onClose={() => setModalOpen(false)}
        onSave={handleSave}
      />
    </div>
  )
}

// ── Generating/Done view (full-body layout) ──────────────────────────────────

function InfoPanel({ visionData, directorData, directorNarrative, dopPlans, logs, infoTab, setInfoTab }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="shrink-0 border-b border-[#252533] bg-[#0f0f18]">
      {/* Tab bar + collapse toggle */}
      <div className="flex items-center border-b border-[#252533]">
        {[
          { id: 'vision',   label: 'Vision',  dot: !!visionData },
          { id: 'director', label: 'Regia',   dot: !!directorData },
          { id: 'log',      label: 'Log',     dot: false },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => { setInfoTab(tab.id); setOpen(true) }}
            className={clsx(
              'px-4 py-2 text-[9px] font-mono uppercase tracking-wide transition-colors relative',
              infoTab === tab.id && open
                ? 'text-[#c9a84c] border-b-2 border-[#c9a84c]'
                : 'text-[#555568] hover:text-[#9090a8]',
            )}
          >
            {tab.label}
            {tab.dot && !(infoTab === tab.id && open) && (
              <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[#c9a84c]" />
            )}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="ml-auto px-3 py-2 text-[#555568] hover:text-[#9090a8]"
          title={open ? 'Comprimi pannello' : 'Espandi pannello'}
        >
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>

      {open && (
        <div className="max-h-56 overflow-y-auto p-4">
          {/* Vision */}
          {infoTab === 'vision' && (
            visionData ? (
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
                <div>
                  <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Stile visivo</p>
                  <p className="text-[10px] text-[#e8e4dd] leading-relaxed">{visionData.combined_style || '—'}</p>
                </div>
                {visionData.palette_hex?.length > 0 && (
                  <div>
                    <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Palette</p>
                    <div className="flex flex-wrap gap-1.5">
                      {visionData.palette_hex.map((hex, i) => (
                        <div key={i} className="flex items-center gap-1">
                          <div className="w-4 h-4 rounded border border-[#252533]" style={{ background: hex }} />
                          <span className="text-[8px] font-mono text-[#9090a8]">{hex}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {visionData.character_anchors?.length > 0 && (
                  <div>
                    <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Personaggi</p>
                    {visionData.character_anchors.map((a, i) => (
                      <p key={i} className="text-[9px] text-[#9090a8]">• {typeof a === 'string' ? a : JSON.stringify(a)}</p>
                    ))}
                  </div>
                )}
                {visionData.continuity_rules?.length > 0 && (
                  <div>
                    <p className="text-[8px] font-mono text-[#555568] uppercase mb-1">Continuità</p>
                    {visionData.continuity_rules.slice(0,4).map((r, i) => (
                      <p key={i} className="text-[9px] text-[#9090a8]">• {typeof r === 'string' ? r : JSON.stringify(r)}</p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-[#555568] italic">In attesa dell'analisi vision…</p>
            )
          )}

          {/* Regia */}
          {infoTab === 'director' && (
            directorData ? (
              <div className="space-y-3">
                <DirectorNarrativeCard narrative={directorNarrative} />
                {directorData.slot_details?.length > 0 && (
                  <div>
                    <p className="text-[8px] font-mono text-[#555568] uppercase mb-2">Slot ({directorData.slot_details.length})</p>
                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
                      {directorData.slot_details.map((s, i) => (
                        <div key={i} className="rounded bg-[#16161f] border border-[#252533] p-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[9px] font-mono text-[#c9a84c]">{s.slot_id}</span>
                            <div className="flex items-center gap-1.5">
                              <EnergyDot energy={s.energy} />
                              <span className="text-[8px] font-mono text-[#555568]">{s.duration_sec}s</span>
                            </div>
                          </div>
                          <p className="text-[9px] font-mono text-[#555568] mb-0.5">{s.emotion}</p>
                          <p className="text-[9px] text-[#9090a8] leading-relaxed line-clamp-2">{s.visual_hint}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-[#555568] italic">In attesa della regia…</p>
            )
          )}

          {/* Log */}
          {infoTab === 'log' && (
            <div className="font-mono text-[10px] text-[#9090a8] space-y-0.5">
              {logs.length === 0
                ? <p className="italic text-[#555568]">Nessun log ancora.</p>
                : [...logs].reverse().map((l, i) => <div key={i}>{l.msg}</div>)
              }
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GeneratingView({
  view, clips, setClips, globalPct, error, logs,
  phaseStatus, directorNarrative, visionData, directorData, dopPlans,
  infoTab, setInfoTab, result, storageProjectId, projectDir,
  activeJobId, mediaProjectId, config, onStop, onPause, onResumePause, onContinue,
  jobPaused, staleRunning, canContinue, pipelineInterrupted, onGoList, onNew,
  catalogProjectId, systemActivity, agentsStatus, reelEnhanceContext,
  layoutMode, setLayoutMode, onSave, onRegen, regenningId,
}) {
  const isPortrait = config.aspect_ratio === '9:16'
  const sbSize = reelStoryboardPixelSize(config)
  const hdSize = reelHdDimensions(config.width, config.height)

  const withImage = clips.filter(c => c.storyboard_ok !== false && !c.storyboard_placeholder && (c.frame_url || c.storyboard_path)).length

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Production Console Header ── */}
      <div className="border-b border-[#252533] bg-[#07070d] shrink-0">

        {/* Top bar: REC indicator + title + clip fraction + progress */}
        <div className="flex items-center gap-3 px-6 py-3">
          {view === 'generating' && !pipelineInterrupted ? (
            <span className="flex items-center gap-1.5 shrink-0">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ef4444] opacity-60" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#ef4444]" />
              </span>
              <span className="text-[9px] font-mono text-[#ef4444] tracking-widest uppercase">REC</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 shrink-0">
              <Clapperboard size={15} className={view === 'done' ? 'text-[#22c55e]' : 'text-[#f59e0b]'} />
            </span>
          )}

          <h1 className="font-['Playfair_Display'] text-base text-[#e8e4dd] leading-tight">
            {view === 'done'
              ? 'Reel completato'
              : pipelineInterrupted
                ? 'Pipeline interrotta'
                : 'Produzione in corso'}
          </h1>

          {/* Clip fraction badge */}
          {view === 'generating' && clips.length > 0 && (
            <span className="ml-1 text-[10px] font-mono px-2 py-0.5 rounded bg-[#1e1e2a] border border-[#32324a] text-[#9090a8]">
              {clips.filter(c => c.status === 'done').length}/{clips.length} clip
            </span>
          )}

          <div className="ml-auto flex items-center gap-3">
            {/* Segmented Layout Selector */}
            <div className="flex items-center gap-1 bg-[#16161f] p-0.5 rounded-lg border border-[#252533] shrink-0">
              <button
                type="button"
                onClick={() => setLayoutMode('horizontal')}
                className={clsx(
                  "p-1 px-2 rounded transition-all flex items-center gap-1 text-[8.5px] font-mono font-semibold",
                  layoutMode === 'horizontal'
                    ? "bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20"
                    : "text-[#555568] hover:text-[#9090a8] border border-transparent"
                )}
                title="Vista Orizzontale"
              >
                <List size={11} />
                Orizzontale
              </button>
              <button
                type="button"
                onClick={() => setLayoutMode('grid')}
                className={clsx(
                  "p-1 px-2 rounded transition-all flex items-center gap-1 text-[8.5px] font-mono font-semibold",
                  layoutMode === 'grid'
                    ? "bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20"
                    : "text-[#555568] hover:text-[#9090a8] border border-transparent"
                )}
                title="Vista Griglia"
              >
                <LayoutGrid size={11} />
                Griglia
              </button>
            </div>

            <span className="text-sm font-mono font-semibold text-[#c9a84c]">{globalPct}%</span>

            {view === 'generating' && (
              <div className="flex items-center gap-2">
                {canContinue && onContinue && (
                  <GoldBtn onClick={onContinue}>
                    <RotateCcw size={12} /> Riprendi pipeline
                  </GoldBtn>
                )}
                {!staleRunning && jobPaused && onResumePause && (
                  <GhostBtn onClick={onResumePause} className="border-[#c9a84c]/40 text-[#c9a84c]">
                    Riprendi
                  </GhostBtn>
                )}
                {!staleRunning && !jobPaused && onPause && (
                  <GhostBtn onClick={onPause} className="border-[#3b82f6]/40 text-[#3b82f6]">
                    Pausa
                  </GhostBtn>
                )}
                <GhostBtn onClick={onStop} className="border-red-500/40 text-red-400 hover:text-red-300">
                  <Square size={12} /> Ferma
                </GhostBtn>
              </div>
            )}
            {view === 'done' && (
              <>
                <GhostBtn onClick={onGoList}>Torna alla lista</GhostBtn>
                <GoldBtn onClick={onNew}><Sparkles size={13} />Nuovo reel</GoldBtn>
              </>
            )}
          </div>
        </div>

        {/* Progress bar — taller, gold */}
        <div className="mx-6 mb-3">
          <div className="h-1.5 bg-[#16161f] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#c9a84c] rounded-full transition-all duration-500"
              style={{ width: `${globalPct}%` }}
            />
          </div>
        </div>

        {/* Phase chips — bigger + clearer */}
        <div className="flex flex-wrap gap-2 px-6 mb-3">
          {PHASES.map(p => {
            const isDone   = phaseStatus[p.id] === 'done'
            const isActive = phaseStatus[p.id] === 'active'
            return (
              <span key={p.id} className={clsx(
                'flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-md border transition-colors',
                isDone   ? 'bg-[#22c55e]/12 border-[#22c55e]/30 text-[#22c55e]'
                : isActive ? 'bg-[#c9a84c]/12 border-[#c9a84c]/40 text-[#c9a84c]'
                : 'bg-[#16161f] border-[#252533] text-[#555568]',
              )}>
                {isDone && <Check size={9} />}
                {isActive && <Loader2 size={9} className="animate-spin" />}
                {p.label}
              </span>
            )
          })}
        </div>

        {/* Agent activity line */}
        {systemActivity?.msg && view === 'generating' && (
          <div className="flex items-center gap-2 mx-6 mb-3 px-3 py-2 rounded-lg bg-[#16161f] border border-[#252533]">
            <Cpu size={11} className="text-[#9090a8] shrink-0" />
            <span className="text-[10px] font-mono text-[#9090a8] truncate">
              <span className="text-[#c9a84c]">{systemActivity.agent_label || 'Agente'}</span>
              {' — '}
              {systemActivity.msg}
              {systemActivity.clip_index != null && systemActivity.clip_total != null && (
                <span className="ml-1 text-[#555568]">· clip {systemActivity.clip_index}/{systemActivity.clip_total}</span>
              )}
            </span>
          </div>
        )}

        {(storageProjectId || projectDir) && (
          <div className="px-6 pb-3">
            <ProjectDirBanner storageProjectId={storageProjectId} jobId={activeJobId} projectDir={projectDir} storageApi="reel" />
          </div>
        )}
      </div>

      {error && (
        <div className="mx-6 mt-3 p-3 rounded border border-[#ef4444]/40 text-[#ef4444] text-xs font-mono shrink-0">
          {error}
        </div>
      )}

      {pipelineInterrupted && canContinue && !error && (
        <div className="mx-6 mt-3 p-3 rounded border border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b] text-xs font-mono shrink-0">
          Pipeline interrotta — checkpoint salvato. Usa «Riprendi pipeline» per continuare (produzione o fasi LLM già completate).
        </div>
      )}

      {/* ── Video result (done) ── */}
      {view === 'done' && (result?.filename || result?.video_path) && (
        <div className="px-6 py-4 border-b border-[#252533] shrink-0">
          <video
            src={
              result.video_url?.replace('/api/trailer/', '/api/reel/')
              || `${BACKEND_ORIGIN}/api/reel/output/${encodeURIComponent(mediaProjectId)}/${encodeURIComponent(result.filename || String(result.video_path).split(/[/\\]/).pop())}`
            }
            controls
            className="max-h-64 rounded border border-[#252533]"
          />
        </div>
      )}

      {/* ── Info panel (full width, collapsible) ── */}
      <InfoPanel
        visionData={visionData}
        directorData={directorData}
        directorNarrative={directorNarrative}
        dopPlans={dopPlans}
        logs={logs}
        infoTab={infoTab}
        setInfoTab={setInfoTab}
      />

      {/* ── Clip cards grid ── */}
      <div className="flex-1 overflow-y-auto p-4">
        {view === 'generating' && (
          <ReelSystemActivityPanel
            activity={systemActivity}
            agentsStatus={agentsStatus}
            phaseStatus={phaseStatus}
          />
        )}
        {(view === 'generating' || view === 'storyboard') && (
          <div className="mb-3">
            <ComfyUIQueueInline projectId={storageProjectId} />
          </div>
        )}
        {layoutMode === 'horizontal' ? (
          <ReelHorizontalClipList
            clips={clips}
            projectId={mediaProjectId}
            jobId={activeJobId}
            aspectRatio={config.aspect_ratio}
            dopPlans={dopPlans}
            onSave={view !== 'done' ? onSave : undefined}
            onRegen={view !== 'done' ? onRegen : undefined}
            regenningId={regenningId}
            projectContext={reelEnhanceContext}
          />
        ) : (
          <ReelClipPlanGrid
            clips={clips}
            projectId={mediaProjectId}
            jobId={activeJobId}
            aspectRatio={config.aspect_ratio}
            config={config}
            sbSize={sbSize}
            hdSize={hdSize}
            dopPlans={dopPlans}
            onSave={view !== 'done' ? onSave : undefined}
            onRegen={view !== 'done' ? onRegen : undefined}
            regenningId={regenningId}
            projectContext={reelEnhanceContext}
            title={clips.length > 0
              ? `${withImage}/${clips.length} clip con anteprima · prompt e parametri di regia`
              : undefined}
            emptyHint="Le clip appariranno qui man mano che gli agenti completano l'analisi e i prompt"
          />
        )}
      </div>
    </div>
  )
}

export default function CreateReelScreen() {
  const { id: routeProjectId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const catalogProjectId = routeProjectId ?? 'reel_standalone'

  const [view, setView] = useState('list')
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const [selectedJob, setSelectedJob] = useState(null)
  const [description, setDescription] = useState('')
  const [title, setTitle] = useState('')
  const [refs, setRefs] = useState([])
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [audioFile, setAudioFile] = useState(null)
  const [audioStartSec, setAudioStartSec] = useState(0)
  const [lyrics, setLyrics] = useState('')
  const [audioAnalysis, setAudioAnalysis] = useState(null)
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
  const [jobControl, setJobControl] = useState({
    staleRunning: false,
    paused: false,
    canContinue: false,
    taskRunning: false,
  })
  const [resumePhase, setResumePhase] = useState('full')
  const [pipelineInterrupted, setPipelineInterrupted] = useState(false)
  const [layoutMode, setLayoutMode] = useState('horizontal')
  const [regenningId, setRegenningId] = useState(null)
  const [projectDir, setProjectDir] = useState(null)
  const [refUploadError, setRefUploadError] = useState(null)
  const [showMediaPicker, setShowMediaPicker] = useState(false)
  const [modelOverrides, setModelOverrides] = useState(null)
  const [systemActivity, setSystemActivity] = useState(null)
  const [agentsStatus, setAgentsStatus] = useState({})
  const [characterMode, setCharacterMode] = useState('none')
  const [selectedCharacterId, setSelectedCharacterId] = useState('')
  const cancelRef = useRef(false)
  const pendingClipsRef = useRef([])
  const clipsRef = useRef([])
  useEffect(() => { clipsRef.current = clips }, [clips])

  const mediaProjectId = resolveReelMediaProjectId(storageProjectId, activeJobId, catalogProjectId)

  const addLog = useCallback((msg) => {
    setLogs(prev => [...prev.slice(-80), { t: Date.now(), msg }])
  }, [])

  const stuckClipsKey = clips
    .filter(clipNeedsMediaRecovery)
    .map(c => c.clip_id)
    .sort()
    .join(',')

  const reconcileAutoContinueRef = useRef(null)
  const runPipelineRef = useRef(null)
  const resumePhaseRef = useRef(resumePhase)
  const pipelineInterruptedRef = useRef(pipelineInterrupted)
  const jobControlRef = useRef(jobControl)
  useEffect(() => { resumePhaseRef.current = resumePhase }, [resumePhase])
  useEffect(() => { pipelineInterruptedRef.current = pipelineInterrupted }, [pipelineInterrupted])
  useEffect(() => { jobControlRef.current = jobControl }, [jobControl])

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
    audio_path: audioFile?.path || null,
    audio_name: audioFile?.name || '',
    audio_start_sec: audioStartSec,
    lyrics: lyrics.trim() || null,
    duration_sec: config.duration_sec,
    style: config.style,
    aspect_ratio: config.aspect_ratio,
    width: config.width,
    height: config.height,
    fps: config.fps,
    storyboard_max_side: config.storyboard_max_side,
    storyboard_steps: config.storyboard_steps,
    hd_frame_steps: config.hd_frame_steps,
    max_clip_sec: config.max_clip_sec,
    concurrent_jobs: 1,
    clip_backend: config.clip_backend,
    allow_ffmpeg_fallback: config.allow_ffmpeg_fallback,
    txt2img_workflow: config.txt2img_workflow,
    img2video_workflow: config.img2video_workflow,
    img_audio2video_workflow: config.img_audio2video_workflow,
    phase,
    resume_job_id: resumeJobId,
    model_overrides: modelOverrides || undefined,
    character_mode: characterMode,
    character_id: selectedCharacterId || null,
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

    if (data.event === 'agent_progress') {
      const isDone = data.agent_status === 'done'
      setSystemActivity({
        msg: data.msg,
        status: isDone ? 'done' : 'working',
        agent_role: data.agent_role,
        agent_label: data.agent_label,
        model: data.model,
        clip_id: data.clip_id,
        clip_index: data.clip_index,
        clip_total: data.clip_total,
      })
      setAgentsStatus(prev => reelAdvanceAgents(prev, data.agent_role, {
        status: data.agent_status,
        model: data.model,
        label: data.agent_label,
      }))
      if (data.agent_status === 'working') {
        if (data.agent_role === 'vision_analyst') {
          setPhaseStatus(s => (
            s.vision_analysis === 'done' ? s : { ...s, vision_analysis: 'active' }
          ))
        } else if (data.agent_role === 'story_analyst') {
          setPhaseStatus(s => ({ ...s, vision_analysis: 'done', reel_director: 'active' }))
        } else if (data.agent_role === 'narrative_director') {
          setPhaseStatus(s => ({ ...s, reel_director: 'active' }))
        } else if (data.agent_role === 'cinematographer' || data.agent_role === 'prompt_engineer') {
          setPhaseStatus(s => ({ ...s, reel_director: 'done', prompt_generator: 'active' }))
        } else if (data.agent_role === 'comfyui') {
          setPhaseStatus(s => ({
            ...s,
            reel_director: 'done',
            prompt_generator: 'done',
            storyboard: 'active',
          }))
        }
      }
      if (data.agent_status === 'done') {
        if (data.agent_role === 'vision_analyst') {
          setPhaseStatus(s => ({ ...s, vision_analysis: 'done' }))
        } else if (data.agent_role === 'story_analyst') {
          setPhaseStatus(s => ({ ...s, vision_analysis: 'done', reel_director: 'active' }))
        } else if (data.agent_role === 'narrative_director') {
          setPhaseStatus(s => ({ ...s, reel_director: 'done' }))
        } else if (data.agent_role === 'cinematographer') {
          setPhaseStatus(s => ({ ...s, reel_director: 'done', prompt_generator: 'active' }))
        } else if (data.agent_role === 'prompt_engineer') {
          setPhaseStatus(s => ({ ...s, reel_director: 'done', prompt_generator: 'done' }))
        } else if (data.agent_role === 'comfyui') {
          setPhaseStatus(s => ({
            ...s,
            reel_director: 'done',
            prompt_generator: 'done',
            storyboard: 'done',
          }))
        }
      }
      if (data.msg) addLog(`[${data.agent_label || data.agent_role}] ${data.msg}`)
    }

    if (data.event === 'phase' && data.phase === 'audio_analysis') {
      setPhaseStatus(s => ({ ...s, vision_analysis: 'done', reel_director: 'active' }))
    }
    if (data.event === 'audio_analysis_done') {
      setPhaseStatus(s => ({ ...s, vision_analysis: 'done', reel_director: 'active' }))
    }
    if (data.event === 'paused') {
      setJobControl(s => ({ ...s, paused: true }))
      addLog(data.msg || 'In pausa')
    }
    if (data.event === 'resumed') {
      setJobControl(s => ({ ...s, paused: false }))
      addLog(data.msg || 'Ripresa')
    }
    if (data.cancelled) {
      setJobControl({ staleRunning: false, paused: false, canContinue: true, taskRunning: false })
      addLog('Pipeline annullata')
    }
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
      if (data.slot_details?.length) {
        setClips(data.slot_details.map((s, i) => ({
          clip_id: s.slot_id || `slot_${String(i + 1).padStart(3, '0')}`,
          slot_id: s.slot_id,
          duration_sec: s.duration_sec,
          status: 'planned',
          emotion: s.emotion,
          scene_prompt: s.visual_hint || '',
          narrative_role: s.narrative_role,
          energy: s.energy,
        })))
      }
      setPhaseStatus(s => ({ ...s, reel_director: 'done' }))
      setAgentsStatus(prev => reelAgentDone(prev, 'narrative_director'))
      setInfoTab('director')
      addLog(`Regia: ${data.slots} slot — ${data.logline || ''}`)
    }
    if (data.event === 'dop_plan_ready') {
      setDopPlans(data.plans || [])
      setAgentsStatus(prev => reelAgentDone(prev, 'cinematographer'))
      setPhaseStatus(s => ({ ...s, reel_director: 'done', prompt_generator: 'active' }))
    }
    if (data.event === 'clip_prompt_ready' || data.event === 'clip_queued') {
      const promptEntry = mergeReelClipFromSse({ clip_id: data.clip_id, status: 'waiting' }, data)
      if (data.event === 'clip_prompt_ready') pendingClipsRef.current.push(promptEntry)
      setClips(prev => {
        const exists = prev.some(c => c.clip_id === data.clip_id)
        const entry = { ...promptEntry, status: 'waiting', frame_url: null }
        if (exists) {
          return prev.map(c => c.clip_id === data.clip_id ? { ...c, ...entry } : c)
        }
        return [...prev, entry]
      })
    }

    if (data.event === 'prompts_ready') {
      setPhaseStatus(s => ({ ...s, reel_director: 'done', prompt_generator: 'done' }))
      setAgentsStatus(prev => {
        let next = reelAgentDone(prev, 'narrative_director')
        next = reelAgentDone(next, 'cinematographer')
        return reelAgentDone(next, 'prompt_engineer')
      })
      setInfoTab('prompts')
      addLog(`Prompt pronti: ${data.clip_count ?? 0} clip`)
      const payloads = Array.isArray(data.clips) ? data.clips : pendingClipsRef.current
      setClips(prev => {
        const byId = new Map(prev.map(c => [c.clip_id, c]))
        for (const p of payloads) {
          if (!p?.clip_id) continue
          const existing = byId.get(p.clip_id) ?? { clip_id: p.clip_id, status: 'waiting' }
          byId.set(p.clip_id, mergeReelClipFromSse(existing, p))
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
        preview_url: data.preview_url || data.url,
        storyboard_clip_url: data.storyboard_clip_url,
      } : {}
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
        }
        const exists = prev.some(c => c.clip_id === data.clip_id)
        return exists
          ? prev.map(c => c.clip_id === data.clip_id ? { ...c, ...entry } : c)
          : [...prev, entry]
      })
      if (sbOk) addLog(`Storyboard ${data.clip_id}`)
    }

    if (data.event === 'storyboard_ready' || (data.event === 'phase_done' && data.phase === 'storyboard')) {
      if (data.pct != null) setGlobalPct(Math.round(data.pct * 100))
      setPhaseStatus(s => ({
        ...s,
        reel_director: 'done',
        prompt_generator: 'done',
        storyboard: 'done',
      }))
      setAgentsStatus(prev => {
        let next = reelAgentDone(prev, 'vision_analyst')
        next = reelAgentDone(next, 'narrative_director')
        next = reelAgentDone(next, 'cinematographer')
        next = reelAgentDone(next, 'prompt_engineer')
        return reelAgentDone(next, 'comfyui')
      })
      const frames = data.frames || data.storyboard
      if (frames?.length) {
        setClips(mapStoryboardFramesToClips(frames, mediaProjectId))
      }
      setSystemActivity({
        status: 'done',
        msg: 'Storyboard LD completato — in attesa di approvazione',
        agent_label: 'ComfyUI',
      })
    }

    if (data.event === 'frame_done' || data.event === 'frames_ready') {
      const frameUrl = resolveBackendUrl(data.frame_url)
        || reelFrameClipUrl(mediaProjectId, data.clip_id)
        || resolveBackendUrl(data.url)
      if (frameUrl) {
        const isHd = Boolean(data.hd_frame_ready)
          || (!data.placeholder && !data.from_storyboard && data.cached !== true)
        const sep = frameUrl.includes('?') ? '&' : '?'
        const cachedUrl = isHd ? `${frameUrl}${sep}v=${Date.now()}` : frameUrl
        setClips(prev => prev.map(c =>
          c.clip_id === data.clip_id
            ? {
                ...c,
                frame_url: cachedUrl,
                first_frame_path: data.path || data.first_path || c.first_frame_path,
                hd_frame_ready: isHd,
                clip_phase: isHd ? 'frame_gen' : c.clip_phase,
                status: data.placeholder ? c.status : (isHd ? 'frame_ready' : 'generating'),
              }
            : c,
        ))
      }
    }

    if (data.event === 'frame_skip') {
      const frameUrl = resolveBackendUrl(data.frame_url)
        || reelFrameClipUrl(mediaProjectId, data.clip_id)
      if (data.clip_id) {
        const sep = frameUrl ? (frameUrl.includes('?') ? '&' : '?') : '?'
        const cachedUrl = frameUrl ? `${frameUrl}${sep}v=${Date.now()}` : null
        setClips(prev => prev.map(c =>
          c.clip_id === data.clip_id
            ? { ...c, hd_frame_ready: true, status: 'frame_ready', ...(cachedUrl ? { frame_url: cachedUrl } : {}) }
            : c,
        ))
      }
    }

    if (data.event === 'clip_comfyui_progress' && data.clip_id) {
      const clipPct = data.comfyui_max > 1
        ? Math.round((data.comfyui_value / data.comfyui_max) * 100)
        : 0
      const phase = data.kind === 'storyboard' ? 'storyboard'
        : data.kind === 'frame' ? 'frame_gen'
        : data.kind === 'video' ? 'video_gen'
        : undefined
      const liveMsg = liveProductionMsg({ ...data, event: 'clip_comfyui_progress' }, clipsRef.current)
      const ord = reelClipOrdinal(data.clip_id, clipsRef.current)
      setSystemActivity({
        status: 'working',
        msg: liveMsg,
        agent_label: 'ComfyUI / Produzione',
        agent_role: 'comfyui',
        clip_id: data.clip_id,
        clip_index: ord.n,
        clip_total: ord.total || data.clip_total,
      })
      setAgentsStatus(prev => reelAdvanceAgents(prev, 'comfyui', {
        status: 'working',
        label: REEL_AGENT_LABELS.comfyui,
      }))
      setPhaseStatus(s => ({ ...s, production: 'active' }))
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id
          ? {
              ...c,
              comfyuiPct: clipPct,
              comfyuiMsg: data.msg || liveMsg,
              comfyuiStep: data.comfyui_value ?? c.comfyuiStep,
              comfyuiStepMax: data.comfyui_max ?? c.comfyuiStepMax,
              comfyuiKind: data.kind ?? c.comfyuiKind,
              status: 'generating',
              ...(phase ? { clip_phase: phase } : {}),
            }
          : c,
      ))
    }

    if (data.event === 'generation_progress') {
      if (data.pct != null) setGlobalPct(Math.round(data.pct * 100))
      const ord = reelClipOrdinal(data.clip_id, clipsRef.current)
      setSystemActivity({
        status: 'working',
        msg: `Clip completate ${data.completed ?? 0}/${data.total ?? clipsRef.current.length}`,
        agent_label: 'ComfyUI / Produzione',
        clip_index: data.completed,
        clip_total: data.total,
      })
    }

    if (data.event === 'progress' && data.msg) {
      const liveMsg = liveProductionMsg(data, clipsRef.current)
      const ord = reelClipOrdinal(data.clip_id, clipsRef.current)
      setSystemActivity({
        status: 'working',
        msg: liveMsg,
        agent_label: 'ComfyUI / Produzione',
        agent_role: 'comfyui',
        clip_id: data.clip_id,
        clip_index: data.clip_index ?? ord.n,
        clip_total: data.clip_total ?? ord.total,
      })
      if (data.clip_id && data.clip_phase) {
        setClips(prev => prev.map(c =>
          c.clip_id === data.clip_id
            ? { ...c, status: 'generating', clip_phase: data.clip_phase, comfyuiMsg: liveMsg }
            : c,
        ))
      }
    }

    if (data.event === 'resume' && data.phase === 'production') {
      setPhaseStatus(s => ({ ...s, production: 'active', storyboard: 'done' }))
      setSystemActivity({
        status: 'working',
        msg: 'Ripresa produzione HD + video…',
        agent_label: 'ComfyUI / Produzione',
      })
      setAgentsStatus(prev => reelAdvanceAgents(prev, 'comfyui', {
        status: 'working',
        label: REEL_AGENT_LABELS.comfyui,
      }))
    }
    if (data.event === 'phase' && data.clip_id) {
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id ? { ...c, clip_phase: data.phase } : c,
      ))
    }
    if (data.event === 'awaiting_storyboard_approval') {
      if (data.director_narrative) setDirectorNarrative(data.director_narrative)
      setPhaseStatus(s => ({
        ...s,
        vision_analysis: 'done',
        reel_director: 'done',
        prompt_generator: 'done',
        storyboard: 'done',
      }))
      setAgentsStatus(prev => {
        let next = reelAgentDone(prev, 'vision_analyst')
        next = reelAgentDone(next, 'narrative_director')
        next = reelAgentDone(next, 'cinematographer')
        next = reelAgentDone(next, 'prompt_engineer')
        return reelAgentDone(next, 'comfyui')
      })
      if (data.storyboard?.length) {
        setClips(mapStoryboardFramesToClips(data.storyboard, mediaProjectId))
      }
      if (data.vision_summary) setVisionSummary(data.vision_summary)
      if (data.pct != null) setGlobalPct(Math.round(data.pct * 100))
      setSystemActivity({
        status: 'done',
        msg: 'Storyboard pronto — revisione e approvazione',
        agent_label: 'ComfyUI',
      })
      setView('storyboard')
      setListRefreshKey(k => k + 1)
      addLog('Storyboard pronto — in attesa di approvazione')
    }
    if (data.event === 'last_frame_ready' && data.clip_id) {
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id
          ? { ...c, last_frame_path: data.last_frame_path || c.last_frame_path }
          : c,
      ))
    }
    if (data.event === 'clip_done') {
      const clipUrl = resolveBackendUrl(data.url) || data.url
      const ord = reelClipOrdinal(data.clip_id, clipsRef.current)
      setSystemActivity({
        status: 'working',
        msg: `Clip video completata — ${ord.label}`,
        agent_label: 'ComfyUI / Produzione',
        clip_id: data.clip_id,
        clip_index: ord.n,
        clip_total: ord.total,
      })
      setClips(prev => prev.map(c =>
        c.clip_id === data.clip_id
          ? { ...c, status: 'done', clip_url: clipUrl, clip_phase: 'video_gen', comfyuiPct: 100, comfyuiMsg: 'Completata' }
          : c,
      ))
    }
    if (data.event === 'assembly_done' || data.done || data.video_path) {
      setPhaseStatus(s => ({ ...s, production: 'done' }))
      setAgentsStatus(prev => reelAgentDone(prev, 'comfyui'))
      setSystemActivity({
        status: 'done',
        msg: 'Reel completato',
        agent_label: 'ComfyUI / Produzione',
      })
      setResult(data)
      setView('done')
      setListRefreshKey(k => k + 1)
      addLog('Reel completato')
    }
    if (data.event === 'phase' && data.phase) {
      const phaseMsgs = {
        comfyui: 'Verifica nodi ComfyUI e avvio produzione…',
        video_clips: data.msg || 'Generazione clip video dai frame HD…',
        assembly: 'Assemblaggio reel finale…',
        production: 'Produzione HD + video',
      }
      if (['comfyui', 'video_clips', 'assembly', 'production'].includes(data.phase)) {
        setPhaseStatus(s => ({ ...s, production: 'active' }))
        setSystemActivity({
          status: 'working',
          msg: phaseMsgs[data.phase] || data.msg || data.phase,
          agent_label: 'ComfyUI / Produzione',
        })
      } else {
        setPhaseStatus(s => ({ ...s, [data.phase]: 'active' }))
      }
    }

    if (data.event === 'generation_complete') {
      setSystemActivity({
        status: 'working',
        msg: 'Assemblaggio reel finale…',
        agent_label: 'ComfyUI / Produzione',
      })
    }

    if (data.msg && data.event !== 'agent_progress') addLog(data.msg)
  }, [addLog, mediaProjectId])

  const runPipeline = async (phase, resumeId = null) => {
    setError(null)
    cancelRef.current = false
    const isResume = Boolean(resumeId)
    if (phase === 'full' || phase === 'storyboard') {
      setView('generating')
      if (phase === 'full' && !isResume) {
        setClips([])
        pendingClipsRef.current = []
        setSystemActivity(null)
        setAgentsStatus({})
        setPhaseStatus({})
        setGlobalPct(0)
      } else if (phase === 'storyboard') {
        setPhaseStatus({})
      }
      if (phase === 'full' && isResume) {
        setJobControl(s => ({ ...s, staleRunning: false, taskRunning: true, canContinue: false }))
      }
    }
    if (phase === 'production') {
      setView('generating')
      setPhaseStatus(s => ({
        ...s,
        storyboard: 'done',
        production: 'active',
      }))
      setSystemActivity({
        status: 'working',
        msg: 'Avvio produzione HD + video…',
        agent_label: 'ComfyUI / Produzione',
      })
      setAgentsStatus(prev => reelAdvanceAgents(prev, 'comfyui', {
        status: 'working',
        label: REEL_AGENT_LABELS.comfyui,
      }))
      setClips(prev => prev.map(c => (
        c.status === 'storyboard' || c.storyboard_ok
          ? { ...c, status: 'generating', comfyuiPct: 0, comfyuiMsg: 'In coda…' }
          : c
      )))
    }
    await window.studio?.reel?.generate?.(buildParams(phase, resumeId || activeJobId), handleProgress)
  }

  useEffect(() => { runPipelineRef.current = runPipeline })

  useMediaReconcile({
    enabled: Boolean(activeJobId && catalogProjectId),
    kind: 'reel',
    catalogProjectId,
    jobId: activeJobId,
    stuckKey: stuckClipsKey,
    alwaysPoll: pipelineInterrupted || jobControl.canContinue,
    onResult: (data) => {
      if (data.recovered?.length) {
        setClips(prev => prev.map(c => {
          let next = c
          for (const ev of data.recovered) {
            if (ev.clip_id === c.clip_id) {
              next = mergeClipRecoveryEvent(next, ev, mediaProjectId, 'reel')
            }
          }
          return next
        }))
        const videoN = data.recovered.filter(e => e.event === 'clip_done').length
        const frameN = data.count - videoN
        if (videoN) addLog(`Recuperate ${videoN} clip video (ComfyUI/disco)`)
        if (frameN) addLog(`Recuperate ${frameN} anteprime/frame (ComfyUI/disco)`)
      }
      const prodReady = resumePhaseRef.current === 'production'
        || data.storyboard_approved
      const canAuto = prodReady
        && data.all_clips_ready
        && !jobControlRef.current.taskRunning
        && (pipelineInterruptedRef.current || jobControlRef.current.canContinue)
      if (canAuto && reconcileAutoContinueRef.current !== activeJobId) {
        reconcileAutoContinueRef.current = activeJobId
        setPipelineInterrupted(false)
        setJobControl(s => ({
          ...s,
          staleRunning: false,
          canContinue: false,
          taskRunning: true,
        }))
        addLog('Tutte le clip pronte — ripresa automatica verso assemblaggio')
        runPipelineRef.current?.('production', activeJobId)
      }
    },
  })

  const handleGenerate = () => {
    if (!description.trim() || description.length < 20) {
      setError('Inserisci una descrizione di almeno 20 caratteri')
      return
    }
    if ((characterMode === 'character' || characterMode === 'character_reference') && !selectedCharacterId) {
      setError('Seleziona un personaggio completato oppure usa la modalita senza personaggio.')
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

  const handleStopJob = async () => {
    if (!activeJobId || !confirm('Fermare la generazione in corso?')) return
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(activeJobId)}/stop`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.detail || err.error || `Stop fallito (${res.status})`)
        return
      }
      const data = await res.json()
      addLog(data.cancelled ? 'Pipeline fermata' : 'Job segnato come interrotto (nessun task attivo)')
      setJobControl({ staleRunning: false, paused: false, canContinue: true, taskRunning: false })
      setError(null)
    } catch (e) {
      setError(e.message || 'Errore stop pipeline')
    }
  }

  const handlePauseJob = async () => {
    if (!activeJobId) return
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(activeJobId)}/pause`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.detail || 'Impossibile mettere in pausa')
        return
      }
      setJobControl(s => ({ ...s, paused: true }))
      addLog('Pipeline in pausa')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleResumePauseJob = async () => {
    if (!activeJobId) return
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(activeJobId)}/resume-pause`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err.detail || 'Impossibile riprendere')
        return
      }
      setJobControl(s => ({ ...s, paused: false }))
      addLog('Pipeline ripresa')
    } catch (e) {
      setError(e.message)
    }
  }

  const handleContinuePipeline = () => {
    if (!activeJobId) return
    setError(null)
    setPipelineInterrupted(false)
    setJobControl(s => ({ ...s, staleRunning: false, canContinue: false, taskRunning: true }))
    runPipeline(resumePhase, activeJobId)
  }

  async function handleResumeJob(job) {
    await openJobReview(job, { autoContinue: true })
  }

  async function handleSavePrompt(clipId, prompts) {
    const res = await fetch(
      `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${activeJobId}/clips/${encodeURIComponent(clipId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prompts),
      },
    )
    if (!res.ok) throw new Error(await res.text())
    setClips(prev => prev.map(c => (c.clip_id === clipId ? { ...c, ...prompts } : c)))
  }

  async function handleRegen(clipId, kind = 'preview') {
    if (regenningId) return
    setRegenningId(clipId)

    if (kind === 'preview') {
      setClips(prev => prev.map(c => c.clip_id === clipId ? { ...c, status: 'generating', comfyuiPct: 0, comfyuiKind: 'preview' } : c))
      try {
        const url = `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${activeJobId}/clips/${encodeURIComponent(clipId)}/regen`
        const es = new EventSource(url)
        await new Promise((resolve, reject) => {
          es.onmessage = (e) => {
            try {
              const data = JSON.parse(e.data)
              if (data.done || data.error) {
                es.close()
                if (data.error) reject(new Error(data.error))
                else resolve()
                return
              }
              if (data.event === 'storyboard_frame') {
                const sbOk = data.storyboard_ok !== false
                setClips(prev => prev.map(c =>
                  c.clip_id === clipId ? {
                    ...c,
                    status: sbOk ? 'storyboard' : 'storyboard_failed',
                    storyboard_ok: sbOk,
                    storyboard_path: data.path || c.storyboard_path,
                    storyboard_filename: data.storyboard_filename || c.storyboard_filename,
                    preview_url: data.preview_url || data.url || c.preview_url,
                  } : c,
                ))
              }
              if (data.event === 'clip_comfyui_progress' && data.comfyui_max > 1) {
                const pct = Math.round((data.comfyui_value / data.comfyui_max) * 100)
                setClips(prev => prev.map(c => c.clip_id === clipId ? { ...c, comfyuiPct: pct } : c))
              }
            } catch {}
          }
          es.onerror = () => { es.close(); resolve() }
        })
      } catch {}
      setRegenningId(null)
      setClips(prev => prev.map(c => c.clip_id === clipId
        ? { ...c, comfyuiPct: 0, comfyuiKind: null, status: c.status === 'generating' ? 'storyboard' : c.status }
        : c,
      ))
    } else {
      setClips(prev => prev.map(c => c.clip_id === clipId ? { ...c, status: 'generating', comfyuiPct: 0, comfyuiKind: kind, comfyuiMsg: `Rigenero ${kind}...` } : c))
      try {
        const params = {
          ...buildParams('regen_clip', activeJobId),
          regen_clip_id: clipId,
          regen_asset: kind,
        }
        await window.studio?.reel?.generate?.(params, handleProgress)
      } catch (err) {
        console.error("Single asset regen failed:", err)
      } finally {
        setRegenningId(null)
        setClips(prev => prev.map(c => c.clip_id === clipId ? { ...c, comfyuiKind: null } : c))
      }
    }
  }

  function handleGoList() {
    if (activeJobId && ['generating', 'storyboard'].includes(view)) {
      try {
        sessionStorage.setItem(
          reelSessionStorageKey(catalogProjectId),
          JSON.stringify({ job_id: activeJobId, view }),
        )
      } catch { /* ignore */ }
    }
    setSelectedJob(null)
    setListRefreshKey(k => k + 1)
    setView('list')
  }

  function handleNew() {
    setDescription('')
    setTitle('')
    setRefs([])
    setAudioFile(null)
    setAudioStartSec(0)
    setLyrics('')
    setAudioAnalysis(null)
    setCharacterMode('none')
    setSelectedCharacterId('')
    setError(null)
    setActiveJobId(null)
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

  useEffect(() => {
    if (!location.state?.characterId) return
    handleNew()
    setCharacterMode(location.state.characterMode || 'character')
    setSelectedCharacterId(location.state.characterId)
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: {} },
    )
  }, [location.state?.characterId])

  async function openJobReview(job, { autoContinue = false } = {}) {
    let hydrated = job
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(job.job_id)}`,
      )
      if (res.ok) hydrated = await res.json()
    } catch {
      /* usa record lista */
    }

    const mediaPid = resolveReelMediaProjectId(
      hydrated.storage_project_id,
      hydrated.job_id,
      catalogProjectId,
    )
    let targetView = resolveReelJobView(hydrated)
    const clipStatus = targetView === 'generating' ? 'generating' : 'storyboard'

    setActiveJobId(hydrated.job_id)
    setStorageProjectId(hydrated.storage_project_id || null)
    setDescription(hydrated.description || '')
    setTitle(hydrated.title || '')
    const cfg = { ...DEFAULT_CONFIG, ...(hydrated.config || {}) }
    setConfig(cfg)
    setCharacterMode(cfg.character_mode || 'none')
    setSelectedCharacterId(cfg.character_id || '')
    if (cfg.audio_path) {
      setAudioFile({ path: cfg.audio_path, name: cfg.audio_name || 'audio' })
      setAudioStartSec(Number(cfg.audio_start_sec) || 0)
      setLyrics(cfg.lyrics || '')
    } else {
      setAudioFile(null)
      setAudioStartSec(0)
      setLyrics('')
    }
    setSelectedJob(null)
    setError(hydrated.error || null)
    setResult(hydrated.result || null)
    if (hydrated.project_dir) setProjectDir(hydrated.project_dir)

    const clipsApi = hydrated.result?.clips
    const frames = hydrated.result?.storyboard ?? []
    if (clipsApi?.length) {
      setClips(normalizeHydratedClips(clipsApi, mediaPid, clipStatus))
    } else if (frames.length) {
      setClips(mapStoryboardFramesToClips(frames, mediaPid, clipStatus))
    } else {
      setClips([])
    }

    const dop = hydrated.result?.visual_plans
    setDopPlans(Array.isArray(dop) ? dop : [])
    setGlobalPct(
      targetView === 'done' ? 100
        : targetView === 'storyboard' ? (hydrated.progress_pct ?? 45)
          : (hydrated.progress_pct ?? 0),
    )
    setPhaseStatus(buildPhaseStatusFromJob(hydrated))
    const phase = resolveReelResumePhase(hydrated)
    setResumePhase(phase)
    const interrupted = ['interrupted', 'failed'].includes(hydrated.status) && !hydrated.task_running
    const isStale = Boolean(hydrated.stale_running)
    setPipelineInterrupted(interrupted)
    setJobControl({
      staleRunning: isStale || interrupted,
      paused: Boolean(hydrated.paused),
      canContinue: (interrupted || isStale) && (Boolean(hydrated.can_continue) || jobCanResumePipeline(hydrated)),
      taskRunning: Boolean(hydrated.task_running),
    })
    if (hydrated.status === 'running' && hydrated.pipeline_ui_phase === 'production') {
      setPhaseStatus(s => ({
        ...s,
        vision_analysis: 'done',
        reel_director: 'done',
        prompt_generator: 'done',
        storyboard: 'done',
        production: 'active',
      }))
    }
    setDirectorData(buildDirectorDataFromJob(hydrated))

    const vision = hydrated.result?.vision
    if (vision) {
      setVisionData(vision)
      setVisionSummary(vision.combined_style || '')
    } else {
      setVisionData(null)
      setVisionSummary('')
    }

    const dn = hydrated.result?.director_narrative
    setDirectorNarrative(dn || null)

    if (targetView === 'detail') {
      targetView = jobHasFinalVideo(hydrated) ? 'done' : (clipsApi?.length || frames.length ? 'storyboard' : 'generating')
    }
    setView(targetView)

    try {
      sessionStorage.removeItem(reelSessionStorageKey(catalogProjectId))
    } catch { /* ignore */ }

    reconcileAutoContinueRef.current = null

    if (autoContinue && jobCanResumePipeline(hydrated)) {
      queueMicrotask(() => {
        setPipelineInterrupted(false)
        setJobControl(s => ({ ...s, staleRunning: false, canContinue: false, taskRunning: true }))
        runPipeline(phase, hydrated.job_id)
      })
    }
  }

  function handleViewDetail(job) {
    if (
      ['running', 'awaiting_storyboard'].includes(job.status)
      || job.has_checkpoint
      || (['interrupted', 'failed'].includes(job.status) && jobCanResumePipeline(job))
    ) {
      openJobReview(job)
      return
    }
    setSelectedJob(job)
    setView('detail')
  }

  const openJobFromQueryRef = useRef(openJobReview)
  openJobFromQueryRef.current = openJobReview
  useJobQueryDeepLink({
    catalogProjectId,
    apiPrefix: 'reel',
    onOpenJob: (job) => openJobFromQueryRef.current(job),
  })

  useEffect(() => {
    if (view !== 'list') return
    let raw
    try {
      raw = sessionStorage.getItem(reelSessionStorageKey(catalogProjectId))
    } catch {
      return
    }
    if (!raw) return
    try {
      const { job_id: jid } = JSON.parse(raw)
      if (!jid) return
      fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(jid)}`,
      )
        .then(r => (r.ok ? r.json() : null))
        .then(j => { if (j) openJobReview(j) })
        .catch(() => {})
    } catch { /* ignore */ }
  }, [catalogProjectId, view, listRefreshKey])

  useEffect(() => {
    if (!activeJobId || !['generating', 'storyboard'].includes(view)) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(
          `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(activeJobId)}`,
        )
        if (!res.ok || cancelled) return
        const hydrated = await res.json()
        if (!['running', 'awaiting_storyboard', 'interrupted'].includes(hydrated.status)) return
        const mediaPid = resolveReelMediaProjectId(
          hydrated.storage_project_id,
          hydrated.job_id,
          catalogProjectId,
        )
        const clipsApi = hydrated.result?.clips
        if (clipsApi?.length) {
          const clipStatus = view === 'generating' ? 'generating' : 'storyboard'
          setClips(normalizeHydratedClips(clipsApi, mediaPid, clipStatus))
        }
        if (hydrated.progress_pct != null) setGlobalPct(Math.round(hydrated.progress_pct))
        if (hydrated.result?.vision) {
          setVisionData(hydrated.result.vision)
          setVisionSummary(hydrated.result.vision.combined_style || '')
        }
        if (hydrated.result?.director_narrative) {
          setDirectorNarrative(hydrated.result.director_narrative)
        }
        setPhaseStatus(buildPhaseStatusFromJob(hydrated))
        setResumePhase(resolveReelResumePhase(hydrated))
        const pollInterrupted = ['interrupted', 'failed'].includes(hydrated.status) && !hydrated.task_running
        const pollStale = Boolean(hydrated.stale_running)
        setPipelineInterrupted(pollInterrupted)
        setJobControl({
          staleRunning: pollStale || pollInterrupted,
          paused: Boolean(hydrated.paused),
          canContinue: (pollInterrupted || pollStale) && (Boolean(hydrated.can_continue) || jobCanResumePipeline(hydrated)),
          taskRunning: Boolean(hydrated.task_running),
        })
        if (hydrated.pipeline_ui_phase === 'production') {
          setPhaseStatus(s => ({
            ...s,
            production: 'active',
            storyboard: 'done',
            prompt_generator: 'done',
            reel_director: 'done',
            vision_analysis: 'done',
          }))
        }
        if (
          hydrated.status === 'awaiting_storyboard'
          || (hydrated.pipeline_ui_phase === 'storyboard' && !hydrated.storyboard_approved)
        ) {
          setView('storyboard')
        }
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeJobId, view, catalogProjectId])

  function handleRestartFromScratch(job) {
    setDescription(job.description || '')
    setTitle(job.title || '')
    setConfig({ ...DEFAULT_CONFIG, ...job.config })
    setRefs([])
    setClips([])
    setResult(null)
    setVisionData(null)
    setVisionSummary('')
    setDirectorNarrative(null)
    setDirectorData(null)
    setPhaseStatus({})
    setError(null)
    if (['failed', 'interrupted'].includes(job.status)) {
      setActiveJobId(job.job_id)
      setStorageProjectId(job.storage_project_id || null)
    } else {
      setActiveJobId(null)
      setStorageProjectId(null)
    }
    setSelectedJob(null)
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
          onResumeJob={handleResumeJob}
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
          onOpenReview={openJobReview}
          onResumePipeline={handleResumeJob}
          onRestartFromScratch={handleRestartFromScratch}
          onDelete={handleGoList}
        />
      </div>
    )
  }

  if (view === 'storyboard') {
    const sbWithPreview = clips.filter(c => c.storyboard_ok !== false && !c.storyboard_placeholder && (c.frame_url || c.storyboard_path)).length
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-[#07070d]">

        {/* ── LIGHTBOARD header ── */}
        <header className="border-b border-[#252533] bg-[#0f0f18] shrink-0">

          {/* Top row: slate + title + clip count + approve */}
          <div className="flex items-center gap-3 px-6 py-3">
            <div className="flex items-center justify-center w-8 h-8 rounded bg-[#c9a84c]/10 border border-[#c9a84c]/30 shrink-0">
              <LayoutGrid size={15} className="text-[#c9a84c]" />
            </div>
            <div className="min-w-0">
              <h1 className="font-['Playfair_Display'] text-base text-[#e8e4dd] leading-tight">Revisione Storyboard</h1>
              <p className="text-[9px] font-mono text-[#555568]">
                {sbWithPreview} / {clips.length} anteprime pronte
              </p>
            </div>

            {/* Phase chips mini */}
            <div className="hidden md:flex items-center gap-1.5 ml-2">
              {[
                { id: 'vision_analysis', label: 'Vision' },
                { id: 'reel_director',   label: 'Regia' },
                { id: 'prompt_generator', label: 'Prompt' },
                { id: 'storyboard',      label: 'Storyboard' },
              ].map(p => (
                <span key={p.id} className="flex items-center gap-1 text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#22c55e]/10 border border-[#22c55e]/20 text-[#22c55e]">
                  <Check size={8} /> {p.label}
                </span>
              ))}
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#c9a84c]/10 border border-[#c9a84c]/30 text-[#c9a84c]">
                HD+Video —
              </span>
            </div>

            <div className="ml-auto flex items-center gap-2 shrink-0">
              {/* Segmented Layout Selector */}
              <div className="flex items-center gap-1 bg-[#16161f] p-0.5 rounded-lg border border-[#252533] mr-2">
                <button
                  type="button"
                  onClick={() => setLayoutMode('horizontal')}
                  className={clsx(
                    "p-1 px-2 rounded transition-all flex items-center gap-1 text-[8.5px] font-mono font-semibold",
                    layoutMode === 'horizontal'
                      ? "bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20"
                      : "text-[#555568] hover:text-[#9090a8] border border-transparent"
                  )}
                  title="Vista Orizzontale"
                >
                  <List size={11} />
                  Orizzontale
                </button>
                <button
                  type="button"
                  onClick={() => setLayoutMode('grid')}
                  className={clsx(
                    "p-1 px-2 rounded transition-all flex items-center gap-1 text-[8.5px] font-mono font-semibold",
                    layoutMode === 'grid'
                      ? "bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20"
                      : "text-[#555568] hover:text-[#9090a8] border border-transparent"
                  )}
                  title="Vista Griglia"
                >
                  <LayoutGrid size={11} />
                  Griglia
                </button>
              </div>

              <GhostBtn onClick={handleGoList}>
                <ChevronRight size={12} className="rotate-180" /> Lista
              </GhostBtn>
              <GhostBtn onClick={handleRegenerateStoryboard}>
                <RefreshCw size={12} /> Rigenera
              </GhostBtn>
              <GenQueueBadge kind="video" workflow={config.img2video_workflow || 'ltx_img2video'} />
              <button
                type="button"
                onClick={handleApprove}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#c9a84c] text-[#07070d] text-sm font-semibold hover:bg-[#e6c46a] transition-colors shadow-[0_0_16px_#c9a84c30]"
              >
                <Check size={14} />
                Approva e Produci HD+Video
              </button>
            </div>
          </div>
        </header>

        {/* Director narrative + project dir */}
        <div className="px-6 py-3 border-b border-[#252533]/50 shrink-0 space-y-2 bg-[#0a0a12]">
          <ProjectDirBanner
            storageProjectId={storageProjectId}
            jobId={activeJobId}
            projectDir={projectDir}
            storageApi="reel"
          />
          {visionSummary && (
            <p className="text-[9px] font-mono text-[#9090a8]">
              <span className="text-[#555568] uppercase tracking-wider">Vision </span>
              {visionSummary}
            </p>
          )}
          {directorNarrative && <DirectorNarrativeCard narrative={directorNarrative} />}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {layoutMode === 'horizontal' ? (
            <ReelHorizontalClipList
              clips={clips}
              projectId={mediaProjectId}
              jobId={activeJobId}
              aspectRatio={config.aspect_ratio}
              dopPlans={dopPlans}
              onSave={handleSavePrompt}
              onRegen={handleRegen}
              regenningId={regenningId}
              projectContext={buildReelEnhanceContext(description, config, directorNarrative, mediaProjectId)}
            />
          ) : (
            <ReelClipPlanGrid
              clips={clips}
              projectId={mediaProjectId}
              jobId={activeJobId}
              aspectRatio={config.aspect_ratio}
              config={config}
              sbSize={reelStoryboardPixelSize(config)}
              hdSize={reelHdDimensions(config.width, config.height)}
              dopPlans={dopPlans}
              onSave={handleSavePrompt}
              onRegen={handleRegen}
              regenningId={regenningId}
              projectContext={buildReelEnhanceContext(description, config, directorNarrative, mediaProjectId)}
              title="Revisione storyboard — anteprima, prompt e regia per ogni clip"
            />
          )}
        </div>
      </div>
    )
  }

  if (view === 'generating' || view === 'done') {
    return (
      <GeneratingView
        view={view}
        clips={clips}
        setClips={setClips}
        globalPct={globalPct}
        error={error}
        logs={logs}
        phaseStatus={phaseStatus}
        directorNarrative={directorNarrative}
        visionData={visionData}
        directorData={directorData}
        dopPlans={dopPlans}
        infoTab={infoTab}
        setInfoTab={setInfoTab}
        result={result}
        storageProjectId={storageProjectId}
        projectDir={projectDir}
        activeJobId={activeJobId}
        mediaProjectId={mediaProjectId}
        config={config}
        onStop={handleStopJob}
        onPause={jobControl.taskRunning && !jobControl.paused ? handlePauseJob : null}
        onResumePause={jobControl.taskRunning && jobControl.paused ? handleResumePauseJob : null}
        onContinue={jobControl.canContinue || jobControl.staleRunning ? handleContinuePipeline : null}
        jobPaused={jobControl.paused}
        staleRunning={jobControl.staleRunning}
        canContinue={jobControl.canContinue || jobControl.staleRunning}
        pipelineInterrupted={pipelineInterrupted}
        onGoList={handleGoList}
        onNew={handleNew}
        catalogProjectId={catalogProjectId}
        systemActivity={systemActivity}
        agentsStatus={agentsStatus}
        reelEnhanceContext={buildReelEnhanceContext(description, config, directorNarrative, mediaProjectId)}
        layoutMode={layoutMode}
        setLayoutMode={setLayoutMode}
        onSave={handleSavePrompt}
        onRegen={handleRegen}
        regenningId={regenningId}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#07070d]">

      {/* ── HEADER ── */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded bg-[#c9a84c]/10 border border-[#c9a84c]/30 shrink-0">
            <Clapperboard size={16} className="text-[#c9a84c]" />
          </div>
          <div>
            <h1 className="font-['Playfair_Display'] text-base text-[#e8e4dd] leading-tight">Director's Studio</h1>
            <p className="text-[9px] font-mono text-[#555568]">Nuovo reel cinematografico</p>
          </div>
          <div className="hidden lg:flex items-center gap-1 ml-4">
            {['Vision', 'Regia', 'Prompt', 'Storyboard', 'HD+Video'].map((step, i, arr) => (
              <span key={step} className="flex items-center gap-1">
                <span className="text-[9px] font-mono text-[#555568]">{step}</span>
                {i < arr.length - 1 && <ChevronRight size={10} className="text-[#32324a]" />}
              </span>
            ))}
          </div>
        </div>
        <GhostBtn onClick={handleGoList}>
          <ChevronRight size={12} className="rotate-180" />
          Lista
        </GhostBtn>
      </div>

      {/* ── ERROR BANNER ── */}
      {error && (
        <div className="flex items-start gap-2 px-6 py-2.5 bg-[#ef4444]/8 border-b border-[#ef4444]/25 shrink-0">
          <AlertCircle size={13} className="text-[#ef4444] mt-0.5 shrink-0" />
          <p className="text-xs font-mono text-[#ef4444]">{error}</p>
        </div>
      )}

      {/* ── TWO-COLUMN BODY ── */}
      <div className="flex-1 flex overflow-hidden min-h-0">

        {/* ── LEFT: Creative Panel ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5 min-w-0">

          {/* BRIEF DEL REGISTA */}
          <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[#252533] bg-[#0f0f18]">
              <div className="w-2 h-2 rounded-full bg-[#ef4444] shrink-0" />
              <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-widest">Brief del Regista</span>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-[10px] font-mono text-[#9090a8] uppercase tracking-wider mb-1.5">
                  Titolo (opzionale)
                </label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="w-full bg-[#0f0f18] border border-[#252533] rounded-lg px-3 py-2.5 text-sm text-[#e8e4dd] placeholder-[#3a3a50] focus:outline-none focus:border-[#c9a84c]/50 transition-colors"
                  placeholder="Titolo del reel"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-[#9090a8] uppercase tracking-wider mb-1.5">
                  Descrizione del video <span className="text-[#ef4444]">*</span>
                </label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={9}
                  className="w-full bg-[#0f0f18] border border-[#252533] rounded-lg px-3 py-2.5 text-sm text-[#e8e4dd] placeholder-[#3a3a50] resize-y focus:outline-none focus:border-[#c9a84c]/50 transition-colors leading-relaxed"
                  placeholder="Una donna cammina da sola nelle strade notturne di una metropoli. I neon colorati si riflettono sul marciapiede bagnato dalla pioggia. La camera segue i suoi movimenti con lenta eleganza cinematografica, stringendosi sul suo viso quando si ferma ad ascoltare la musica nel silenzio della notte…"
                />
                <p className="mt-1.5 text-[9px] font-mono text-[#555568]">
                  Descrivi storia, personaggi, atmosfera, ritmo e cosa accade in ogni momento. Min. 20 caratteri.
                </p>
                <ReelDescriptionGenerator
                  title={title}
                  lyrics={lyrics}
                  style={config.style}
                  audioAnalysis={audioAnalysis}
                  refsCount={refs.length}
                  onApply={setDescription}
                />
              </div>
            </div>
          </div>

          {/* STILE VISIVO */}
          <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[#252533] bg-[#0f0f18]">
              <div className="w-2 h-2 rounded-full bg-[#3b82f6] shrink-0" />
              <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-widest">Stile Visivo</span>
            </div>
            <div className="p-4">
              <textarea
                value={config.style}
                onChange={e => setConfig(c => ({ ...c, style: e.target.value }))}
                rows={3}
                placeholder="cinematic, photorealistic, teal-orange grade, soft rim light, 35mm grain…"
                className="w-full bg-[#0f0f18] border border-[#252533] rounded-lg px-3 py-2.5 text-sm text-[#e8e4dd] placeholder-[#3a3a50] resize-y focus:outline-none focus:border-[#c9a84c]/50 transition-colors"
              />
              <p className="mt-1.5 mb-3 text-[9px] font-mono text-[#555568]">
                Inviato alla pipeline insieme alla descrizione — usa l&apos;AI per allinearlo al brief.
              </p>
              <ReelStyleImprover
                title={title}
                description={description}
                currentStyle={config.style}
                onApply={style => setConfig(c => ({ ...c, style }))}
              />
            </div>
          </div>

          {/* REFERENCE IMAGES */}
          <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-[#252533] bg-[#0f0f18]">
              <div className="w-2 h-2 rounded-full bg-[#a78bfa] shrink-0" />
              <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-widest">Immagini di Riferimento</span>
              <span className="ml-auto text-[9px] font-mono text-[#555568]">{refs.length}/{MAX_REFS}</span>
            </div>
            <div className="p-4">
              <ReferenceDropZone
                refs={refs}
                onAddPaths={addRefsFromPaths}
                onRemove={(path) => setRefs(prev => prev.filter(x => x.path !== path))}
                onPick={handlePickImages}
                onPickFromLibrary={() => setShowMediaPicker(true)}
                uploadError={refUploadError}
              />
            </div>
          </div>

        </div>

        {/* ── RIGHT: Settings Sidebar ── */}
        <div className="w-[330px] shrink-0 border-l border-[#252533] overflow-y-auto bg-[#0a0a12]">
          <div className="p-4 space-y-4">

            {/* AUDIO */}
            <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#252533] bg-[#0f0f18]">
                <Music2 size={12} className="text-[#9090a8] shrink-0" />
                <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-widest">Audio & Musica</span>
                {audioFile && (
                  <span className="ml-auto text-[8px] font-mono px-1.5 py-0.5 rounded bg-[#22c55e]/15 text-[#22c55e] border border-[#22c55e]/25">caricato</span>
                )}
              </div>
              <div className="p-3">
                <ReelAudioSection
                  audioFile={audioFile}
                  setAudioFile={setAudioFile}
                  audioStartSec={audioStartSec}
                  setAudioStartSec={setAudioStartSec}
                  reelDurationSec={config.duration_sec}
                  lyrics={lyrics}
                  setLyrics={setLyrics}
                  onAnalysis={setAudioAnalysis}
                />
              </div>
            </div>

            {/* PERSONAGGIO */}
            <CharacterReelSelector
              mode={characterMode}
              setMode={setCharacterMode}
              selectedId={selectedCharacterId}
              setSelectedId={setSelectedCharacterId}
            />

            {/* IMPOSTAZIONI PROGETTO */}
            <ReelProjectSettings config={config} setConfig={setConfig} />

            {/* WORKFLOW */}
            <WorkflowSelector config={config} setConfig={setConfig} hasAudio={Boolean(audioFile)} />

            {/* MODELLI & LORA */}
            <ModelOverridesSection config={config} onChange={setModelOverrides} />

          </div>
        </div>

      </div>

      {/* ── STICKY BOTTOM ACTION BAR ── */}
      <div className="shrink-0 flex items-center gap-4 px-6 py-3 border-t border-[#c9a84c]/20 bg-[#0f0f18]">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={!description.trim()}
          className={clsx(
            'flex items-center gap-2.5 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all shrink-0',
            'bg-[#c9a84c] text-[#07070d] hover:bg-[#e6c46a] disabled:opacity-40 disabled:cursor-not-allowed',
            'shadow-[0_0_20px_#c9a84c28]',
          )}
        >
          <Sparkles size={15} />
          Genera Storyboard
        </button>
        <GenQueueBadge kind="image" workflow={config.txt2img_workflow || 'z_image_txt2img'} />
        <p className="text-[9px] font-mono text-[#555568] leading-relaxed hidden xl:block min-w-0 truncate">
          Vision → Regia narrativa → Prompt → Storyboard LD → approva → HD + clip video
        </p>
        <div className="ml-auto shrink-0 text-[9px] font-mono text-[#555568]">
          {config.aspect_ratio} · {config.width}×{config.height} · {config.duration_sec}s · {config.fps}fps
        </div>
      </div>

      {showMediaPicker && (
        <MediaLibraryPicker
          onConfirm={async (paths) => {
            setShowMediaPicker(false)
            if (paths.length) await addRefsFromPaths(paths)
          }}
          onClose={() => setShowMediaPicker(false)}
        />
      )}
    </div>
  )
}
