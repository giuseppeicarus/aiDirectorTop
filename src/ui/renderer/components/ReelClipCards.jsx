/**
 * Card clip reel + pannello attività agenti (CreateReel).
 */
import { useState, useEffect } from 'react'
import {
  Loader2, Image as ImageIcon, Film, Camera, Clock, Maximize2,
  Sparkles, Check, Edit3, Save, RotateCcw, X, Wand2,
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

function ReelThumb({ clip, projectId, jobId, aspectRatio, kind = 'preview', localPath }) {
  const [src, setSrc] = useState(null)
  const isPortrait = aspectRatio === '9:16'

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (clip?.clip_url && kind === 'video') {
        const v = clip.clip_url.startsWith('http') ? clip.clip_url : `${BACKEND_ORIGIN}${clip.clip_url}`
        if (!cancelled) setSrc(v)
        return
      }
      const path = localPath || (kind === 'first' ? clip?.first_frame_path : kind === 'last' ? clip?.last_frame_path : null)
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
        const hdLast = clip?.last_frame_path
          ? resolveBackendUrl(null, clip.last_frame_path)
          : null
        if (hdLast) urls.push(hdLast)
        const hd = clipReelFramePreviewUrl(clip, projectId)
        if (hd && clip?.hd_frame_ready) urls.push(hd)
      }
      for (const httpUrl of urls) {
        if (window.studio?.reel?.fetchImageUrl) {
          const r = await window.studio.reel.fetchImageUrl(httpUrl)
          if (!cancelled && r?.ok && r.dataUrl) {
            setSrc(r.dataUrl)
            return
          }
        }
      }
      if (!cancelled) setSrc(null)
    }
    load()
    return () => { cancelled = true }
  }, [clip, projectId, jobId, kind, localPath])

  const box = (
    <div
      className="relative rounded border border-[#252533] bg-[#0f0f18] overflow-hidden"
      style={{ aspectRatio: isPortrait ? '9/16' : '16/9' }}
    >
      {kind === 'video' && src ? (
        <video src={src} className="w-full h-full object-cover" muted playsInline preload="metadata" />
      ) : src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 text-[#555568]">
          {clip?.status === 'generating' ? <Loader2 size={12} className="animate-spin text-[#c9a84c]" /> : <ImageIcon size={12} />}
          <span className="text-[6px] font-mono uppercase">{kind}</span>
        </div>
      )}
      {clip?.comfyuiPct > 0 && kind === 'preview' && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1e1e2a]/80">
          <div className="h-full bg-[#c9a84c]" style={{ width: `${clip.comfyuiPct}%` }} />
        </div>
      )}
    </div>
  )
  return box
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

  return (
    <div className={clsx(
      'rounded-xl border bg-[#16161f] flex flex-col overflow-hidden',
      clip.status === 'done' ? 'border-[#22c55e]/40'
        : clip.status === 'generating' ? 'border-[#c9a84c]/50'
          : isPlanned ? 'border-[#32324a] border-dashed'
            : 'border-[#252533]',
    )}>
      <div className="px-3 py-2 border-b border-[#252533] flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-mono text-[#c9a84c] truncate">{clip.clip_id}</p>
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
          {hasLast || clip.last_frame_path ? (
            <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="last" />
          ) : (
            <div
              className="rounded border border-dashed border-[#32324a] bg-[#0f0f18] flex items-center justify-center text-[7px] font-mono text-[#555568]"
              style={{ aspectRatio: aspectRatio === '9:16' ? '9/16' : '16/9' }}
            >
              —
            </div>
          )}
        </div>
      </div>

      <div className="px-2 pb-2">
        <p className="text-[6px] font-mono text-[#555568] uppercase mb-0.5">Clip video</p>
        <div className="rounded border border-[#252533] overflow-hidden" style={{ aspectRatio: aspectRatio === '9:16' ? '9/16' : '16/9', maxHeight: 72 }}>
          {clip.status === 'done' && clip.clip_url ? (
            <ReelThumb clip={clip} projectId={projectId} jobId={jobId} aspectRatio={aspectRatio} kind="video" />
          ) : (
            <div className="w-full h-full min-h-[48px] flex items-center justify-center gap-1 bg-[#0f0f18] text-[#555568]">
              <Film size={12} />
              <span className="text-[7px] font-mono text-center px-1">
                {clip.comfyuiMsg
                  || (clip.clip_phase === 'video_gen' ? 'Video…'
                    : clip.clip_phase === 'frame_gen' ? 'Frame HD…'
                      : 'In attesa')}
              </span>
            </div>
          )}
        </div>
      </div>

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

      {onRegen && !isPlanned && (
        <div className="px-3 py-2 border-t border-[#252533]">
          <button
            type="button"
            onClick={() => onRegen(clip.clip_id)}
            disabled={regenning}
            className="w-full flex items-center justify-center gap-1 py-1.5 rounded text-[9px] font-mono border border-[#32324a] text-[#9090a8] hover:border-[#c9a84c]/40"
          >
            {regenning ? <Loader2 size={9} className="animate-spin" /> : <RotateCcw size={9} />}
            Rigenera storyboard
          </button>
        </div>
      )}

      <ReelPromptEditorModal
        open={promptModalOpen && !!onSave}
        clipId={clip.clip_id}
        draft={draft}
        setDraft={setDraft}
        hasLastFrame={hasLast}
        saving={saving}
        saved={saved}
        isDirty={isDirty}
        onClose={() => setPromptModalOpen(false)}
        onSave={handleSave}
        projectContext={{
          ...projectContext,
          clip_id: clip.clip_id,
          slot_id: clip.slot_id,
          shot_type: clip.shot_type,
          camera_movement: clip.camera_movement,
          lens_mm: clip.lens_mm,
          lighting: clip.lighting,
          emotion: clip.emotion,
          scene_description: clip.scene_description,
        }}
      />
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
      title={`Piano clip stimato (~${rows.length} clip)`}
      emptyHint=""
    />
  )
}

export function ReelSystemActivityPanel({ activity, agentsStatus, phaseStatus }) {
  const agents = REEL_PIPELINE_AGENTS

  return (
    <div className="rounded-xl border border-[#32324a] bg-[#0f0f18] p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-[#c9a84c]" />
        <p className="text-[11px] font-mono text-[#e8e4dd] uppercase tracking-wider">Attività sistema</p>
      </div>

      {activity?.msg && (
        <div className={clsx(
          'mb-3 px-3 py-2 rounded-lg border',
          activity?.status === 'done'
            ? 'border-[#22c55e]/30 bg-[#22c55e]/8'
            : 'border-[#c9a84c]/30 bg-[#c9a84c]/8',
        )}>
          <p className={clsx(
            'text-[10px] font-mono flex items-center gap-2',
            activity?.status === 'done' ? 'text-[#22c55e]' : 'text-[#c9a84c]',
          )}>
            {activity?.status !== 'done' && (
              <Loader2 size={12} className="animate-spin shrink-0" />
            )}
            {activity?.status === 'done' && <Check size={12} className="shrink-0" />}
            <span>
              {activity.agent_label && (
                <span className="text-[#e6c46a]">[{activity.agent_label}] </span>
              )}
              {activity.msg}
              {activity.clip_index != null && activity.clip_total != null && (
                <span className="text-[#9090a8]">
                  {' '}· clip {activity.clip_index}/{activity.clip_total}
                </span>
              )}
            </span>
          </p>
          {activity.model && (
            <p className="text-[8px] font-mono text-[#555568] mt-1 ml-5">{activity.model}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {agents.map(a => {
          const st = agentsStatus[a.role]
          const phaseDone = phaseStatus[a.phase] === 'done'
          const working = st?.status === 'working' && !phaseDone
          const done = st?.status === 'done' || phaseDone
          return (
            <div
              key={a.role}
              className={clsx(
                'flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-mono',
                working && 'border-[#c9a84c]/50 bg-[#c9a84c]/12 text-[#c9a84c]',
                done && !working && 'border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]',
                !working && !done && 'border-[#252533] text-[#555568]',
              )}
            >
              {done && !working ? <Check size={10} /> : working ? <Loader2 size={10} className="animate-spin" /> : null}
              <span>{a.label}</span>
              {st?.model && <span className="text-[#555568] truncate max-w-[100px]">· {st.model}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
