import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Sparkles, Wand2, Upload, Music, Mic,
  FileAudio, X, ChevronDown, Info, Film, Image as ImageIcon,
  Check, Loader2, Zap, Users, Video, Layers, Cpu, Lock,
} from 'lucide-react'
import { useProjectStore } from '../stores'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

const API = API_BASE

// ── Constants ─────────────────────────────────────────────────────────────────

const GENRES = [
  'cinematic','music_video','short_film','documentary',
  'commercial','horror','sci-fi','action','romance','experimental',
]

const RATIOS = ['16:9','21:9','4:3','1:1','9:16','2.39:1']

const RESOLUTIONS = {
  '16:9': [
    { label: 'HD — 1280×720',       value: '1280x720' },
    { label: 'Full HD — 1920×1080', value: '1920x1080' },
    { label: '2K — 2560×1440',      value: '2560x1440' },
    { label: '4K UHD — 3840×2160',  value: '3840x2160' },
  ],
  '21:9': [
    { label: 'UW FHD — 2560×1080',  value: '2560x1080' },
    { label: 'UW 2K — 3440×1440',   value: '3440x1440' },
    { label: 'UW 4K — 5120×2160',   value: '5120x2160' },
  ],
  '4:3': [
    { label: 'XGA — 1024×768',      value: '1024x768' },
    { label: 'SXGA — 1280×960',     value: '1280x960' },
    { label: 'HD 4:3 — 1920×1440',  value: '1920x1440' },
    { label: 'QHD 4:3 — 2560×1920', value: '2560x1920' },
  ],
  '1:1': [
    { label: '1024×1024',           value: '1024x1024' },
    { label: '1280×1280',           value: '1280x1280' },
    { label: '2048×2048',           value: '2048x2048' },
    { label: '4K — 3840×3840',      value: '3840x3840' },
  ],
  '9:16': [
    { label: 'HD — 720×1280',        value: '720x1280' },
    { label: 'Full HD — 1080×1920',  value: '1080x1920' },
    { label: '2K — 1440×2560',       value: '1440x2560' },
    { label: '4K — 2160×3840',       value: '2160x3840' },
  ],
  '2.39:1': [
    { label: '2K DCI — 2048×858',   value: '2048x858' },
    { label: '3K — 3072×1285',      value: '3072x1285' },
    { label: '4K DCI — 4096×1716',  value: '4096x1716' },
  ],
}

const DEFAULT_RESOLUTION = {
  '16:9': '1920x1080', '21:9': '2560x1080', '4:3': '1280x960',
  '1:1': '1024x1024', '9:16': '1080x1920', '2.39:1': '2048x858',
}

const FRAME_MULTS = [
  { label: '2× — Standard (bilanciato)', value: 2 },
  { label: '3× — Alta qualità',          value: 3 },
  { label: '4× — Massima qualità',       value: 4 },
]

// ── Workflow Categories (static config, options loaded dynamically) ────────────

const WORKFLOW_CATEGORIES = [
  {
    key:      'txt2img',
    type:     'txt2img',
    label:    'Text → Image',
    subtitle: 'Genera i frame di riferimento da prompt testuale',
    Icon:     ImageIcon,
  },
  {
    key:      'img2img',
    type:     'img2img',
    label:    'Image → Image',
    subtitle: 'Refinement / variazione frame (opzionale)',
    Icon:     Layers,
    optional: true,
  },
  {
    key:      'img2video',
    type:     'img2video',
    label:    'Image First → Video',
    subtitle: 'Anima il primo frame in clip video',
    Icon:     Film,
  },
  {
    key:      'img2video_lastframe',
    type:     'img2video_lastframe',
    label:    'Image First + Last → Video',
    subtitle: 'Interpolazione guidata tra primo e ultimo frame',
    Icon:     Video,
  },
  {
    key:      'img_audio2video',
    type:     'img_audio2video',
    label:    'Image + Audio → Video',
    subtitle: 'Video sincronizzato con audio (richiede audio abilitato)',
    Icon:     Music,
    audioOnly: true,
  },
]

// ── Utilities ─────────────────────────────────────────────────────────────────

function parseRes(str) {
  const [w, h] = (str || '1920x1080').split('x').map(Number)
  return { w, h }
}

function calcFrameRes(videoRes, mult) {
  const { w, h } = parseRes(videoRes)
  return `${w * mult}×${h * mult}`
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}

// ── Sub-components ────────────────────────────────────────────────────────────

const inp = "w-full bg-[#0d0d16] border border-[#2a2a38] rounded-lg px-3 py-2.5 text-[#f0ede8] text-sm placeholder-[#9090a0]/50 focus:outline-none focus:border-[#c9a84c]/60 transition-colors"
const sel = "w-full bg-[#0d0d16] border border-[#2a2a38] rounded-lg px-3 py-2.5 text-[#f0ede8] text-sm focus:outline-none focus:border-[#c9a84c]/60 transition-colors appearance-none"
const label = "block text-[11px] text-[#9090a0] uppercase tracking-wider mb-1.5 font-medium"

function SectionHeader({ title, subtitle }) {
  return (
    <div className="flex items-baseline gap-3 mb-4 pb-2 border-b border-[#2a2a38]">
      <h2 className="text-sm font-semibold text-[#c9a84c] uppercase tracking-wider">{title}</h2>
      {subtitle && <span className="text-[11px] text-[#9090a0]">{subtitle}</span>}
    </div>
  )
}

// ── Style AI Improver ─────────────────────────────────────────────────────────

function StyleImprover({ title, description, genre, onApply }) {
  const [loading,    setLoading]    = useState(false)
  const [suggestion, setSuggestion] = useState(null)
  const [error,      setError]      = useState(null)

  async function improve() {
    if (!title && !description) return
    setLoading(true)
    setError(null)
    setSuggestion(null)
    try {
      const res = await fetch(`${API}/llm/improve-style`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, genre }),
      }).then(r => r.json())
      if (res.ok && res.style) setSuggestion(res)
      else setError(res.error || 'Nessun suggerimento ricevuto')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={improve}
        disabled={loading || (!title && !description)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/10 disabled:opacity-40 transition-colors"
      >
        {loading
          ? <Loader2 size={12} className="animate-spin" />
          : <Wand2 size={12} />
        }
        {loading ? 'AI elabora...' : 'Migliora con AI'}
      </button>

      {error && (
        <p className="text-xs text-[#ef4444]">{error}</p>
      )}

      {suggestion && (
        <div className="rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5 p-3">
          <p className="text-[10px] text-[#9090a0] uppercase tracking-wider mb-1.5">Proposta stile AI</p>
          <p className="text-xs text-[#f0ede8] leading-relaxed mb-1">{suggestion.style}</p>
          {suggestion.rationale && (
            <p className="text-[11px] text-[#9090a0] italic">{suggestion.rationale}</p>
          )}
          <button
            type="button"
            onClick={() => { onApply(suggestion.style); setSuggestion(null) }}
            className="mt-2 flex items-center gap-1.5 px-3 py-1 text-[11px] rounded bg-[#c9a84c]/20 hover:bg-[#c9a84c]/30 text-[#c9a84c] transition-colors"
          >
            <Check size={10} /> Applica
          </button>
        </div>
      )}
    </div>
  )
}

// ── Audio Drop Zone ───────────────────────────────────────────────────────────

function AudioDropZone({ audioFile, onFile, onRemove }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('audio/')) onFile(file)
  }, [onFile])

  const handleDragOver = useCallback((e) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => setDragging(false), [])

  const handleInput = (e) => {
    const file = e.target.files?.[0]
    if (file) onFile(file)
  }

  if (audioFile) {
    return (
      <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5">
        <FileAudio size={20} className="text-[#c9a84c] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[#f0ede8] truncate">{audioFile.name}</p>
          <p className="text-[11px] text-[#9090a0]">{fmtBytes(audioFile.size)}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="p-1 rounded text-[#9090a0] hover:text-[#ef4444] transition-colors shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => inputRef.current?.click()}
      className={clsx(
        'flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-lg border-2 border-dashed cursor-pointer transition-colors',
        dragging
          ? 'border-[#c9a84c] bg-[#c9a84c]/10'
          : 'border-[#2a2a38] hover:border-[#c9a84c]/40 hover:bg-[#c9a84c]/5'
      )}
    >
      <Upload size={22} className="text-[#9090a0]" />
      <p className="text-sm text-[#9090a0]">Trascina qui il file audio</p>
      <p className="text-[11px] text-[#555568]">MP3 · WAV · M4A · FLAC · AAC · OGG</p>
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleInput}
      />
    </div>
  )
}

// ── Workflow Category Selector ────────────────────────────────────────────────

function WorkflowCategory({ catKey, cat, options, selected, onChange, disabled, loading }) {
  const { label, subtitle, Icon, optional } = cat
  const isEmpty = !loading && options.length === 0

  return (
    <div className={clsx('rounded-xl border transition-colors', disabled ? 'border-[#2a2a38] opacity-50' : 'border-[#2a2a38]')}>
      {/* Category header */}
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2.5 border-b border-[#2a2a38]">
        <Icon size={14} className="text-[#c9a84c] shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-xs font-semibold text-[#f0ede8] tracking-wide">{label}</span>
          <span className="text-[10px] text-[#555568] ml-2">{subtitle}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {optional && <span className="text-[9px] text-[#555568] border border-[#2a2a38] rounded px-1.5 py-0.5">opzionale</span>}
          {disabled && (
            <div className="flex items-center gap-1 text-[10px] text-[#555568]">
              <Lock size={10} /> richiede audio
            </div>
          )}
        </div>
      </div>

      {/* Options */}
      <div className="p-3 space-y-2">
        {loading && (
          <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-[#555568]">
            <Loader2 size={12} className="animate-spin" /> Caricamento workflow…
          </div>
        )}

        {isEmpty && (
          <div className="px-3 py-3 text-[11px] text-[#555568] italic">
            Nessun workflow di questo tipo configurato nel sistema
          </div>
        )}

        {options.map(wf => {
          const active = selected === wf.id
          return (
            <button
              key={wf.id}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onChange(catKey, wf.id)}
              className={clsx(
                'w-full text-left rounded-lg px-3.5 py-3 border-2 transition-all',
                active
                  ? 'border-[#c9a84c] bg-[#c9a84c]/8'
                  : 'border-[#252533] hover:border-[#c9a84c]/30 hover:bg-[#c9a84c]/4',
                disabled && 'cursor-not-allowed',
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                {/* Radio dot */}
                <span className={clsx(
                  'w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                  active ? 'border-[#c9a84c] bg-[#c9a84c]' : 'border-[#555568]',
                )}>
                  {active && <span className="w-1.5 h-1.5 rounded-full bg-[#0a0a0f]" />}
                </span>

                <span className={clsx('text-xs font-medium truncate flex-1', active ? 'text-[#f0ede8]' : 'text-[#9090a0]')}>
                  {wf.name}
                </span>

                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#555568] font-mono shrink-0">
                  {wf.id}
                </span>
              </div>

              {wf.description && (
                <p className="text-[11px] text-[#555568] leading-relaxed pl-5.5 line-clamp-2">
                  {wf.description}
                </p>
              )}

              {wf.models?.length > 0 && (
                <p className="text-[9px] text-[#3a3a50] font-mono pl-5.5 mt-1 truncate">
                  {wf.models[0]}{wf.models.length > 1 ? ` +${wf.models.length - 1}` : ''}
                </p>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ProjectCreatorScreen() {
  const navigate = useNavigate()
  const { createProject, loading } = useProjectStore()

  const [form, setForm] = useState({
    mode:                 'full_auto',
    title:                '',
    user_prompt:          '',
    genre:                'cinematic',
    style:                'photorealistic, dramatic lighting, film grain',
    aspect_ratio:         '16:9',
    duration_sec:         60,
    max_clip_sec:         8,
    video_resolution:     '1920x1080',
    frame_resolution_mult: 2,
    lyrics:               '',
    audio_start_sec:      0,
  })

  // workflow selection: { txt2img: id, img2img: id, img2video: id, img2video_lastframe: id, img_audio2video: id }
  const [workflows,         setWorkflows]         = useState({})
  // grouped by type from backend manifest
  const [wfByType,          setWfByType]          = useState({})
  const [wfLoading,         setWfLoading]         = useState(true)

  const [audioEnabled, setAudioEnabled] = useState(false)
  const [audioFile,    setAudioFile]    = useState(null)
  const [submitting,   setSubmitting]   = useState(false)
  const [submitError,  setSubmitError]  = useState(null)

  // ── Load workflows from backend and auto-select first per category ─────────
  useEffect(() => {
    window.studio?.workflow?.list?.()
      .then(m => {
        const grouped = {}
        for (const wf of (m.workflows || [])) {
          if (!grouped[wf.type]) grouped[wf.type] = []
          grouped[wf.type].push(wf)
        }
        setWfByType(grouped)
        // Auto-select first available workflow per category
        setWorkflows(prev => {
          const next = { ...prev }
          for (const cat of WORKFLOW_CATEGORIES) {
            if (!next[cat.key] && grouped[cat.type]?.length > 0) {
              next[cat.key] = grouped[cat.type][0].id
            }
          }
          return next
        })
      })
      .catch(() => {})
      .finally(() => setWfLoading(false))
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // When aspect ratio changes, reset resolution to default for that ratio
  function handleRatioChange(ratio) {
    set('aspect_ratio', ratio)
    set('video_resolution', DEFAULT_RESOLUTION[ratio] || '1920x1080')
  }

  function handleWorkflowChange(catKey, optionId) {
    setWorkflows(w => ({ ...w, [catKey]: optionId }))
  }

  const frameRes = calcFrameRes(form.video_resolution, form.frame_resolution_mult)
  const resOptions = RESOLUTIONS[form.aspect_ratio] || RESOLUTIONS['16:9']

  async function handleSubmit() {
    if (!form.title || !form.user_prompt) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payload = {
        ...form,
        duration_sec:          Number(form.duration_sec),
        max_clip_sec:          Number(form.max_clip_sec),
        frame_resolution_mult: Number(form.frame_resolution_mult),
        audio_start_sec:       Number(form.audio_start_sec) || 0,
        lyrics: audioEnabled ? form.lyrics || null : null,
        workflows_json: JSON.stringify(workflows),
      }
      const project = await createProject(payload)

      // Upload audio if present
      if (audioEnabled && audioFile) {
        const fd = new FormData()
        fd.append('file', audioFile)
        await fetch(`${API}/projects/${project.id}/audio`, { method: 'POST', body: fd })
      }

      navigate(`/projects/${project.id}`)
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const isDisabled = submitting || loading || !form.title || !form.user_prompt

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-3xl mx-auto">
        <button
          onClick={() => navigate('/projects')}
          className="flex items-center gap-2 text-[#9090a0] hover:text-[#f0ede8] text-sm mb-6 transition-colors"
        >
          <ArrowLeft size={15} /> Indietro
        </button>

        <h1 className="font-['Playfair_Display'] text-2xl text-[#f0ede8] mb-1">Nuovo Progetto</h1>
        <p className="text-sm text-[#9090a0] mb-8">Configura il progetto cinematografico</p>

        <div className="space-y-8">

          {/* ── 0. Modalità di produzione ── */}
          <section>
            <SectionHeader title="Modalità" subtitle="come vuoi produrre il video" />
            <div className="grid grid-cols-2 gap-4">
              {[
                {
                  id: 'full_auto',
                  Icon: Zap,
                  title: 'FullAutoVideo',
                  desc: 'Approva lo storyboard una volta, poi il sistema genera frame, clip e master finale in autonomia.',
                },
                {
                  id: 'copilot',
                  Icon: Users,
                  title: 'CopilotVideo',
                  desc: 'Controllo shot per shot: approvi prima immagine e clip di ogni inquadratura prima di proseguire.',
                },
              ].map(({ id, Icon, title, desc }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => set('mode', id)}
                  className={clsx(
                    'p-4 rounded-xl border-2 text-left transition-all',
                    form.mode === id
                      ? 'border-[#c9a84c] bg-[#c9a84c]/10'
                      : 'border-[#2a2a38] hover:border-[#c9a84c]/40 hover:bg-[#c9a84c]/5'
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={16} className={form.mode === id ? 'text-[#c9a84c]' : 'text-[#9090a0]'} />
                    <span className={clsx('text-sm font-semibold', form.mode === id ? 'text-[#f0ede8]' : 'text-[#9090a0]')}>
                      {title}
                    </span>
                    {form.mode === id && <Check size={13} className="text-[#c9a84c] ml-auto" />}
                  </div>
                  <p className="text-[11px] text-[#555568] leading-relaxed">{desc}</p>
                </button>
              ))}
            </div>
          </section>

          {/* ── 1. Informazioni base ── */}
          <section>
            <SectionHeader title="Informazioni" subtitle="titolo, descrizione e genere" />
            <div className="space-y-4">
              <div>
                <label className={label}>Titolo *</label>
                <input
                  value={form.title}
                  onChange={e => set('title', e.target.value)}
                  placeholder="Es. Detective in Venice"
                  className={inp}
                />
              </div>

              <div>
                <label className={label}>Descrizione del video *</label>
                <textarea
                  value={form.user_prompt}
                  onChange={e => set('user_prompt', e.target.value)}
                  placeholder="Racconta la storia visiva che vuoi creare — personaggi, ambienti, atmosfera, sequenza narrativa..."
                  rows={4}
                  className={inp + ' resize-none'}
                />
              </div>

              <div>
                <label className={label}>Genere</label>
                <div className="relative">
                  <select
                    value={form.genre}
                    onChange={e => set('genre', e.target.value)}
                    className={sel}
                  >
                    {GENRES.map(g => (
                      <option key={g} value={g}>{g.replace('_', ' ')}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="absolute right-3 top-3.5 text-[#9090a0] pointer-events-none" />
                </div>
              </div>
            </div>
          </section>

          {/* ── 2. Stile visivo ── */}
          <section>
            <SectionHeader title="Stile visivo" subtitle="look cinematografico" />
            <div className="space-y-3">
              <div>
                <label className={label}>Descrizione stile</label>
                <input
                  value={form.style}
                  onChange={e => set('style', e.target.value)}
                  placeholder="anamorphic, film grain, teal & orange, dramatic chiaroscuro..."
                  className={inp}
                />
              </div>
              <StyleImprover
                title={form.title}
                description={form.user_prompt}
                genre={form.genre}
                onApply={s => set('style', s)}
              />
            </div>
          </section>

          {/* ── 3. Impostazioni video ── */}
          <section>
            <SectionHeader title="Impostazioni video" subtitle="risoluzione, formato, durata" />
            <div className="space-y-4">
              {/* Aspect ratio + Resolution */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={label}>Aspect ratio</label>
                  <div className="relative">
                    <select
                      value={form.aspect_ratio}
                      onChange={e => handleRatioChange(e.target.value)}
                      className={sel}
                    >
                      {RATIOS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                    <ChevronDown size={13} className="absolute right-3 top-3.5 text-[#9090a0] pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className={label}>Risoluzione video</label>
                  <div className="relative">
                    <select
                      value={form.video_resolution}
                      onChange={e => set('video_resolution', e.target.value)}
                      className={sel}
                    >
                      {resOptions.map(r => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={13} className="absolute right-3 top-3.5 text-[#9090a0] pointer-events-none" />
                  </div>
                </div>
              </div>

              {/* Frame resolution multiplier */}
              <div>
                <label className={label}>
                  Risoluzione frame AI
                  <span className="text-[#555568] normal-case tracking-normal ml-2 font-normal">
                    — immagini usate per la generazione video
                  </span>
                </label>
                <div className="relative">
                  <select
                    value={form.frame_resolution_mult}
                    onChange={e => set('frame_resolution_mult', Number(e.target.value))}
                    className={sel}
                  >
                    {FRAME_MULTS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <ChevronDown size={13} className="absolute right-3 top-3.5 text-[#9090a0] pointer-events-none" />
                </div>
                <div className="flex items-center gap-2 mt-1.5 px-2">
                  <ImageIcon size={11} className="text-[#9090a0]" />
                  <span className="text-[11px] text-[#9090a0]">
                    Frame AI: <span className="text-[#c9a84c] font-mono">{frameRes}</span>
                    {' '}· Video output: <span className="text-[#f0ede8] font-mono">{form.video_resolution.replace('x', '×')}</span>
                  </span>
                </div>
              </div>

              {/* Durata totale */}
              <div>
                <label className={label}>
                  Durata totale: <span className="text-[#c9a84c] font-mono">{form.duration_sec}s</span>
                  <span className="text-[#555568] ml-2 normal-case tracking-normal font-normal">
                    ({Math.floor(form.duration_sec / 60)}m {form.duration_sec % 60}s)
                  </span>
                </label>
                <input
                  type="range" min={10} max={600} step={5}
                  value={form.duration_sec}
                  onChange={e => set('duration_sec', Number(e.target.value))}
                  className="w-full accent-[#c9a84c]"
                />
                <div className="flex justify-between text-[10px] text-[#555568] mt-0.5">
                  <span>10s</span><span>2min</span><span>5min</span><span>10min</span>
                </div>
              </div>

              {/* Durata massima clip */}
              <div>
                <label className={label}>
                  Durata massima clip: <span className="text-[#c9a84c] font-mono">{form.max_clip_sec}s</span>
                  <span className="text-[#555568] ml-2 normal-case tracking-normal font-normal">
                    — il direttore AI può ridurla (minimo 4s)
                  </span>
                </label>
                <input
                  type="range" min={4} max={30} step={1}
                  value={form.max_clip_sec}
                  onChange={e => set('max_clip_sec', Number(e.target.value))}
                  className="w-full accent-[#c9a84c]"
                />
                <div className="flex justify-between text-[10px] text-[#555568] mt-0.5">
                  <span>4s min</span>
                  <span className="text-center">
                    ~{Math.ceil(form.duration_sec / form.max_clip_sec)} clip stimate
                  </span>
                  <span>30s max</span>
                </div>
              </div>
            </div>
          </section>

          {/* ── 4. Audio ── */}
          <section>
            <SectionHeader title="Audio" subtitle="opzionale — per music video e sync timing" />

            {/* Toggle */}
            <div className="flex items-center gap-3 mb-4">
              <button
                type="button"
                onClick={() => { setAudioEnabled(v => !v); if (audioEnabled) setAudioFile(null) }}
                className={clsx(
                  'relative w-10 h-5 rounded-full transition-colors shrink-0',
                  audioEnabled ? 'bg-[#c9a84c]' : 'bg-[#2a2a38]'
                )}
              >
                <span className={clsx(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                  audioEnabled ? 'translate-x-5' : 'translate-x-0.5'
                )} />
              </button>
              <span className="text-sm text-[#9090a0]">
                {audioEnabled ? 'Audio abilitato' : 'Abilita audio'}
              </span>
              {audioEnabled && (
                <span className="text-[11px] text-[#555568]">
                  — il file verrà analizzato per BPM, ritmo e timing liriche
                </span>
              )}
            </div>

            {audioEnabled && (
              <div className="space-y-4 pl-0">
                {/* Drop zone */}
                <div>
                  <label className={label}>File audio</label>
                  <AudioDropZone
                    audioFile={audioFile}
                    onFile={setAudioFile}
                    onRemove={() => setAudioFile(null)}
                  />
                </div>

                {/* Audio start offset */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className={label + ' mb-0'}>Inizio audio (secondi)</label>
                    <span className="text-[10px] text-[#555568]">
                      Da quale secondo dell'audio inizia la generazione
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={form.audio_start_sec}
                      onChange={e => set('audio_start_sec', Math.max(0, Number(e.target.value)))}
                      className={inp + ' w-32 text-center'}
                    />
                    <span className="text-xs text-[#555568]">
                      {form.audio_start_sec > 0
                        ? `Prima clip da ${form.audio_start_sec}s, seconda da ${(Number(form.audio_start_sec) + Number(form.max_clip_sec)).toFixed(1)}s, ecc.`
                        : 'Default: parte dall\'inizio del file audio'}
                    </span>
                  </div>
                </div>

                {/* Lyrics */}
                <div>
                  <div className="flex items-start justify-between mb-1.5">
                    <label className={label + ' mb-0'}>Liriche / testo</label>
                    <div className="flex items-center gap-1.5 text-[10px] text-[#555568]">
                      <Mic size={10} />
                      Se lasci vuoto, verranno estratte automaticamente dall'audio
                    </div>
                  </div>
                  <textarea
                    value={form.lyrics}
                    onChange={e => set('lyrics', e.target.value)}
                    placeholder={"Incolla il testo della canzone qui...\n\nSe lasci vuoto, il sistema trascriverà automaticamente l'audio."}
                    rows={6}
                    className={inp + ' resize-none font-mono text-xs leading-relaxed'}
                  />
                </div>

                {/* Info box */}
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-[#2a2a38] bg-[#0d0d16]">
                  <Info size={13} className="text-[#9090a0] shrink-0 mt-0.5" />
                  <div className="text-[11px] text-[#9090a0] leading-relaxed">
                    <p className="font-medium text-[#f0ede8] mb-0.5">Cosa viene analizzato:</p>
                    <ul className="space-y-0.5 text-[#555568]">
                      <li>· BPM e struttura ritmica per il timing dei tagli</li>
                      <li>· Sezioni energetiche (intro, strofe, ritornello, bridge)</li>
                      <li>· Emozione dominante per ogni sezione</li>
                      <li>· Trascrizione automatica se le liriche sono vuote</li>
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── 5. Workflow AI ── */}
          <section>
            <SectionHeader
              title="Workflow AI"
              subtitle="seleziona i workflow ComfyUI per ogni fase di generazione"
            />

            <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-[#2a2a38] bg-[#0d0d16] mb-4">
              <Cpu size={13} className="text-[#9090a0] shrink-0 mt-0.5" />
              <div className="text-[11px] text-[#9090a0] leading-relaxed">
                <p className="font-medium text-[#f0ede8] mb-0.5">Pipeline di generazione</p>
                <p className="text-[#555568]">
                  I workflow vengono caricati dai tuoi ComfyUI configurati nel sistema.
                  Puoi aggiungerne di nuovi dalla sezione{' '}
                  <span className="text-[#c9a84c]">Workflow</span>.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {WORKFLOW_CATEGORIES.map(cat => (
                <WorkflowCategory
                  key={cat.key}
                  catKey={cat.key}
                  cat={cat}
                  options={wfByType[cat.type] || []}
                  selected={workflows[cat.key]}
                  onChange={handleWorkflowChange}
                  disabled={cat.audioOnly && !audioEnabled}
                  loading={wfLoading}
                />
              ))}
            </div>
          </section>

          {/* ── Error ── */}
          {submitError && (
            <div className="px-4 py-3 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/10 text-sm text-[#ef4444]">
              {submitError}
            </div>
          )}

          {/* ── Submit ── */}
          <button
            onClick={handleSubmit}
            disabled={isDisabled}
            className="w-full flex items-center justify-center gap-2 py-3.5 bg-[#c9a84c] hover:bg-[#d4b55e] disabled:opacity-40 disabled:cursor-not-allowed text-[#0a0a0f] font-semibold rounded-lg transition-colors text-sm"
          >
            {submitting
              ? <><Loader2 size={16} className="animate-spin" /> Creazione in corso...</>
              : <><Sparkles size={16} /> Crea Progetto</>
            }
          </button>

          {/* Hint */}
          <p className="text-center text-[11px] text-[#555568] -mt-4">
            {form.mode === 'copilot'
              ? 'In modalità Copilot approverai ogni shot prima che il sistema proceda'
              : 'In modalità FullAuto il sistema lavora in autonomia dopo l\'approvazione dello storyboard'
            }
          </p>

        </div>
      </div>
    </div>
  )
}
