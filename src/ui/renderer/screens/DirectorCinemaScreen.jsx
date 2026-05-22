/**
 * DirectorCinemaScreen — Timeline-based AI video director tool.
 * Maps to LTX Director 2.3 ComfyUI workflow parameters.
 * Projects are persisted in localStorage('director-cinema-projects').
 */

import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, X, Trash2, Music, Image, Wand2, Play,
  Film, Loader2, CheckCircle, AlertCircle,
  Upload, Clock, Settings,
} from 'lucide-react'
import clsx from 'clsx'
import { normalizeUnifiedPrompt } from '../utils/promptEnhance'
import { API_BASE, BACKEND_ORIGIN } from '../utils/apiClient'
import {
  buildDirectorCinemaEnhanceContext,
  syncDirectorProjectToVault,
} from '../utils/obsidianEnhanceContext'
import { useDirectorMediaReconcile } from '../hooks/useMediaReconcile'

// ── Constants ──────────────────────────────────────────────────────────────────

const PX_PER_SEC = 60
const LS_KEY = 'director-cinema-projects'
const API = API_BASE

const ASPECT_RATIOS = {
  '16:9':  { label: '16:9',  resolutions: [
    { label: 'HD',  w: 1280, h: 720  },
    { label: 'FHD', w: 1920, h: 1080 },
    { label: '2K',  w: 2560, h: 1440 },
  ]},
  '9:16':  { label: '9:16',  resolutions: [
    { label: 'HD',  w: 720,  h: 1280 },
    { label: 'FHD', w: 1080, h: 1920 },
  ]},
  '1:1':   { label: '1:1',   resolutions: [
    { label: '1024', w: 1024, h: 1024 },
    { label: '1280', w: 1280, h: 1280 },
  ]},
  '4:3':   { label: '4:3',   resolutions: [
    { label: 'HD',  w: 1024, h: 768  },
    { label: 'FHD', w: 1280, h: 960  },
  ]},
  '21:9':  { label: '21:9',  resolutions: [
    { label: 'SD',  w: 1344, h: 576  },
    { label: 'UW',  w: 2560, h: 1080 },
  ]},
}

const FPS_OPTIONS = [24, 25, 30]

// ── Utilities ──────────────────────────────────────────────────────────────────

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveProjects(projects) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(projects))
  } catch {
    // storage full — silently ignore
  }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return iso
  }
}

/** Anteprima media via API backend (file:// non funziona con Vite/Electron). */
function mediaPreviewUrl(asset) {
  if (!asset?.mediaId) return ''
  if (asset.type === 'image' || !asset.type) return `${API}/media/thumb/${asset.mediaId}`
  return `${API}/media/file/${asset.mediaId}`
}

async function uploadToMediaLibrary(filePath, name, tags = 'director-cinema') {
  const upload = window.studio?.director?.uploadMedia
    ?? window.studio?.media?.upload
  if (!upload) throw new Error('Upload media non disponibile — riavvia l\'app')
  const result = await upload(filePath, {
    projectId: '__library__',
    tags,
    description: `Director Cinema — ${name || 'media'}`,
  })
  return {
    path: result.filepath,
    name: result.filename || name,
    mediaId: result.id,
    type: result.type,
  }
}

// Safe IPC wrapper — falls back gracefully when window.studio.director is not yet wired
const director = {
  pickImage:    () => window.studio?.director?.pickImage?.()    ?? window.studio?.tools?.pickImage?.()    ?? Promise.resolve(null),
  pickAudio:    () => window.studio?.director?.pickAudio?.()    ?? window.studio?.tools?.pickAudio?.()    ?? Promise.resolve(null),
  uploadMedia:  (path, opts) => window.studio?.director?.uploadMedia?.(path, opts)
    ?? window.studio?.media?.upload?.(path, opts),
  generate:     (params, cb) => window.studio?.director?.generate?.(params, cb) ?? Promise.resolve(null),
  enhance:      (req)        => window.studio?.director?.enhance?.(req)         ?? Promise.resolve({ enhanced: req.prompt }),
  getWorkflows: ()           => window.studio?.director?.getWorkflows?.()       ?? Promise.resolve([]),
}

// ── Small shared UI pieces ─────────────────────────────────────────────────────

function Badge({ children, color = 'gold', className = '' }) {
  const colors = {
    gold:   'bg-[#c9a84c]/15 text-[#c9a84c]   border-[#c9a84c]/30',
    amber:  'bg-amber-500/15  text-amber-400   border-amber-500/30',
    blue:   'bg-blue-500/15   text-blue-400    border-blue-500/30',
    green:  'bg-green-500/15  text-green-400   border-green-500/30',
    red:    'bg-red-500/15    text-red-400     border-red-500/30',
    dim:    'bg-[#252533]/60  text-[#9090a8]   border-[#252533]',
  }
  return (
    <span className={clsx(
      'inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-mono tracking-wide',
      colors[color] ?? colors.dim,
      className,
    )}>
      {children}
    </span>
  )
}

function GoldBtn({ children, onClick, disabled, small, className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-1.5 rounded font-mono transition-opacity disabled:opacity-40',
        small ? 'px-2.5 py-1 text-[10px]' : 'px-4 py-2 text-xs',
        className,
      )}
      style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
    >
      {children}
    </button>
  )
}

function GhostBtn({ children, onClick, disabled, small, className = '' }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-1.5 rounded border border-[#252533] text-[var(--text3)] hover:text-[var(--text2)] hover:border-[#32324a] transition-colors disabled:opacity-40',
        small ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-[11px]',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ── VIEW 1: Projects List ──────────────────────────────────────────────────────

function ProjectCard({ project, onOpen, onDelete }) {
  function handleDelete(e) {
    e.stopPropagation()
    if (window.confirm(`Eliminare il progetto "${project.name}"?`)) {
      onDelete(project.id)
    }
  }

  const totalClips = project.clips?.length ?? 0
  const totalSec   = (project.clips ?? []).reduce((s, c) => s + (c.duration ?? 4), 0)

  return (
    <div
      onClick={() => onOpen(project.id)}
      className="relative group rounded-xl border border-[#252533] bg-[#16161f] hover:border-[#c9a84c]/40 hover:bg-[#1a1a28] transition-all cursor-pointer overflow-hidden"
    >
      {/* Decorative gold top bar */}
      <div className="h-0.5 w-full" style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }} />

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <p className="font-semibold text-[var(--text)] text-sm leading-tight truncate flex-1">{project.name}</p>
          <button
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-[var(--text3)] hover:text-[var(--red)]"
          >
            <X size={13} />
          </button>
        </div>

        {/* Badges row */}
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Badge color={project.mode === 'img2video' ? 'amber' : 'blue'}>
            {project.mode === 'img2video' ? 'img2video' : 'txt2video'}
          </Badge>
          <Badge color="dim">{project.width}x{project.height}</Badge>
          <Badge color="dim">{project.fps ?? 24} fps</Badge>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 text-[10px] text-[var(--text3)] font-mono">
          <span className="flex items-center gap-1">
            <Film size={10} />
            {totalClips} clip{totalClips !== 1 ? 's' : ''}
          </span>
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {totalSec.toFixed(0)}s
          </span>
        </div>

        {/* Date */}
        <p className="text-[9px] text-[var(--text3)] font-mono mt-2">{formatDate(project.createdAt)}</p>
      </div>

      {/* Hover overlay cue */}
      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
           style={{ boxShadow: 'inset 0 0 0 1px rgba(201,168,76,0.25)' }} />
    </div>
  )
}

function ProjectsListView({ projects, onOpen, onDelete, onNew }) {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-6 pb-5 border-b border-[#252533] shrink-0">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Film size={18} className="text-[var(--gold)]" />
            <h1 className="font-['Playfair_Display'] text-lg font-semibold text-[var(--gold)]">
              Director Cinema
            </h1>
          </div>
          <p className="text-[11px] text-[var(--text3)] font-mono">Timeline cinematografica AI</p>
        </div>
        <GoldBtn onClick={onNew}>
          <Plus size={13} />
          Nuovo Progetto
        </GoldBtn>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-16 h-16 rounded-full bg-[#16161f] border border-[#252533] flex items-center justify-center">
              <Film size={28} className="text-[var(--text3)]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[var(--text2)] mb-1">Nessun progetto</p>
              <p className="text-[11px] text-[var(--text3)]">Crea il tuo primo progetto Director Cinema</p>
            </div>
            <GoldBtn onClick={onNew}>
              <Plus size={13} />
              Crea il tuo primo progetto
            </GoldBtn>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {projects.map(p => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── VIEW 2: New Project Modal ──────────────────────────────────────────────────

function NewProjectModal({ existingCount, onClose, onCreate }) {
  const [name, setName]         = useState(`Director #${existingCount + 1}`)
  const [mode, setMode]         = useState('img2video')
  const [ar, setAr]             = useState('16:9')
  const [resIdx, setResIdx]     = useState(0)
  const [fps, setFps]           = useState(24)
  const [workflowId, setWfId]   = useState('')
  const [workflows, setWfs]     = useState([])

  useEffect(() => {
    director.getWorkflows().then(wfs => {
      setWfs(wfs ?? [])
      if (wfs?.length > 0) setWfId(wfs[0].id)
      else setWfId('ltx_director_img2video')
    }).catch(() => {
      setWfId('ltx_director_img2video')
    })
  }, [])

  const arData   = ASPECT_RATIOS[ar]
  const resList  = arData.resolutions
  const safeIdx  = Math.min(resIdx, resList.length - 1)
  const res      = resList[safeIdx]

  function handleArChange(newAr) {
    setAr(newAr)
    setResIdx(0)
  }

  function handleCreate() {
    const project = {
      id:          genId(),
      name:        name.trim() || `Director #${existingCount + 1}`,
      mode,
      workflowId:  workflowId || 'ltx_director_img2video',
      aspectRatio: ar,
      width:       res.w,
      height:      res.h,
      fps,
      globalPrompt: '',
      clips:       [],
      audio:       null,
      createdAt:   new Date().toISOString(),
    }
    onCreate(project)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
      <div className="w-[520px] rounded-xl border border-[#252533] bg-[#12121a] overflow-hidden shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#252533]">
          <span className="font-semibold text-sm text-[var(--text)]">Nuovo progetto Director</span>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Nome progetto</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full text-sm bg-[#1e1e2a] text-[var(--text)] rounded-lg px-3 py-2.5 border border-[#252533] outline-none focus:border-[var(--gold)] transition-colors"
              autoFocus
            />
          </div>

          {/* Mode toggle */}
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Modalita</label>
            <div className="flex gap-2">
              <button
                onClick={() => setMode('img2video')}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-mono transition-all',
                  mode === 'img2video'
                    ? 'border-amber-500/60 bg-amber-500/10 text-amber-400'
                    : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
                )}
              >
                <Image size={14} /> img2video
              </button>
              <button
                onClick={() => setMode('txt2video')}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-mono transition-all',
                  mode === 'txt2video'
                    ? 'border-blue-500/60 bg-blue-500/10 text-blue-400'
                    : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
                )}
              >
                <Film size={14} /> txt2video
              </button>
            </div>
          </div>

          {/* Aspect ratio pills */}
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Aspect Ratio</label>
            <div className="flex gap-2 flex-wrap mb-3">
              {Object.keys(ASPECT_RATIOS).map(ratio => (
                <button
                  key={ratio}
                  onClick={() => handleArChange(ratio)}
                  className={clsx(
                    'px-3 py-1.5 rounded-lg border text-[11px] font-mono transition-all',
                    ar === ratio
                      ? 'border-[var(--gold)]/60 bg-[var(--gold)]/10 text-[var(--gold)]'
                      : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
                  )}
                >
                  {ratio}
                </button>
              ))}
            </div>

            {/* Resolution sub-pills */}
            <div className="flex gap-2 flex-wrap">
              {resList.map((r, i) => (
                <button
                  key={i}
                  onClick={() => setResIdx(i)}
                  className={clsx(
                    'px-2.5 py-1 rounded border text-[10px] font-mono transition-all',
                    safeIdx === i
                      ? 'border-[var(--gold)]/40 bg-[var(--gold)]/8 text-[var(--gold)]'
                      : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
                  )}
                >
                  {r.label} {r.w}x{r.h}
                </button>
              ))}
            </div>
          </div>

          {/* FPS + Workflow row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">FPS</label>
              <div className="flex gap-2">
                {FPS_OPTIONS.map(f => (
                  <button
                    key={f}
                    onClick={() => setFps(f)}
                    className={clsx(
                      'flex-1 py-2 rounded-lg border text-[11px] font-mono transition-all',
                      fps === f
                        ? 'border-[var(--gold)]/60 bg-[var(--gold)]/10 text-[var(--gold)]'
                        : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Workflow</label>
              {workflows.length > 0 ? (
                <select
                  value={workflowId}
                  onChange={e => setWfId(e.target.value)}
                  className="w-full text-[11px] bg-[#1e1e2a] text-[var(--text)] rounded-lg px-3 py-2.5 border border-[#252533] outline-none font-mono"
                >
                  {workflows.map(wf => (
                    <option key={wf.id} value={wf.id}>{wf.name}</option>
                  ))}
                </select>
              ) : (
                <div className="w-full text-[11px] bg-[#1e1e2a] text-[var(--text3)] rounded-lg px-3 py-2.5 border border-[#252533] font-mono">
                  ltx_director_img2video
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[#252533]">
          <GhostBtn onClick={onClose}>Annulla</GhostBtn>
          <GoldBtn onClick={handleCreate}>
            <Plus size={13} />
            Crea
          </GoldBtn>
        </div>
      </div>
    </div>
  )
}

// ── Clip Card (inside timeline) ────────────────────────────────────────────────

function ClipCard({ clip, index, mode, isSelected, onSelect, onDelete, onResize }) {
  const width = clip.duration * PX_PER_SEC

  function onResizeMouseDown(e) {
    e.preventDefault()
    e.stopPropagation()
    const startX        = e.clientX
    const startDuration = clip.duration

    function onMouseMove(me) {
      const deltaX  = me.clientX - startX
      const newDur  = Math.min(30, Math.max(1, startDuration + deltaX / PX_PER_SEC))
      // Round to nearest 0.5s for smooth UX
      const snapped = Math.round(newDur * 2) / 2
      onResize(clip.id, snapped)
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const hasImage = mode === 'img2video' && clip.image

  return (
    <div
      className={clsx(
        'relative flex-shrink-0 h-full rounded overflow-hidden border transition-all cursor-pointer group/clip',
        isSelected
          ? 'border-[var(--gold)] shadow-[0_0_0_1px_rgba(201,168,76,0.4)]'
          : 'border-[#252533] hover:border-[#32324a]'
      )}
      style={{
        width,
        background: '#16161f',
        borderLeft: '2px solid var(--gold)',
      }}
      onClick={() => onSelect(clip.id)}
    >
      {/* Thumbnail strip */}
      {hasImage ? (
        <div className="absolute left-0 top-0 bottom-0 w-14 overflow-hidden">
          <img
            src={mediaPreviewUrl(clip.image)}
            alt=""
            className="w-full h-full object-cover opacity-70"
            draggable={false}
          />
          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-[#16161f]" />
        </div>
      ) : null}

      {/* Content area */}
      <div className={clsx('absolute inset-0 flex flex-col justify-between p-1.5', hasImage && 'pl-16')}>
        {/* Clip number */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-[var(--gold)] opacity-60">#{index + 1}</span>
        </div>

        {/* Prompt preview */}
        <p className="text-[9px] text-[var(--text2)] leading-tight line-clamp-2 font-mono overflow-hidden flex-1 mt-1">
          {clip.prompt
            ? clip.prompt
            : <span className="text-[var(--text3)] italic">Prompt vuoto</span>}
        </p>

        {/* Bottom bar */}
        <div className="flex items-center justify-between mt-1">
          <span className="text-[8px] font-mono text-[var(--text3)]">{clip.duration.toFixed(1)}s</span>
          <button
            onClick={e => { e.stopPropagation(); onDelete(clip.id) }}
            className="opacity-0 group-hover/clip:opacity-100 transition-opacity text-[var(--text3)] hover:text-[var(--red)]"
          >
            <X size={10} />
          </button>
        </div>
      </div>

      {/* Resize handle */}
      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--gold)]/20 transition-colors"
        onMouseDown={onResizeMouseDown}
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

// ── Audio Track Bar ────────────────────────────────────────────────────────────

function AudioTrack({ audio, totalWidth, onAdd, onRemove }) {
  if (!audio) {
    return (
      <button
        onClick={onAdd}
        className="flex items-center gap-2 h-full border border-dashed border-[#252533] rounded px-4 text-[10px] text-[var(--text3)] hover:border-[#32324a] hover:text-[var(--text2)] transition-colors"
        style={{ minWidth: 160 }}
      >
        <Plus size={11} />
        Aggiungi audio
      </button>
    )
  }

  return (
    <div
      className="relative flex items-center gap-2 h-full rounded border border-amber-500/30 bg-amber-500/10 px-3 overflow-hidden group/audio"
      style={{ width: Math.max(totalWidth, 120) }}
    >
      <Music size={11} className="text-amber-400 shrink-0" />
      <span className="text-[9px] font-mono text-amber-300 truncate flex-1">{audio.name}</span>
      <button
        onClick={onRemove}
        className="opacity-0 group-hover/audio:opacity-100 transition-opacity text-amber-400 hover:text-[var(--red)] shrink-0"
      >
        <X size={11} />
      </button>
    </div>
  )
}

// ── Clip Editor Sidebar ────────────────────────────────────────────────────────

function ClipEditorSidebar({ clip, clipIndex, mode, project, onUpdate, onDelete, onClose }) {
  const [enhancing, setEnhancing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState(null)

  async function handleEnhance() {
    if (!clip.prompt.trim() || enhancing) return
    setEnhancing(true)
    try {
      await syncDirectorProjectToVault(project, BACKEND_ORIGIN)
      const res = await director.enhance({
        prompt: clip.prompt,
        context: 'director_clip',
        project_context: buildDirectorCinemaEnhanceContext(project, clip),
      })
      onUpdate({ prompt: normalizeUnifiedPrompt(res?.enhanced, clip.prompt, res?.negative_prompt) })
    } catch {
      // silent
    } finally {
      setEnhancing(false)
    }
  }

  async function handlePickImage() {
    const picked = await director.pickImage()
    if (!picked?.path) return
    setUploading(true)
    setUploadError(null)
    try {
      const image = await uploadToMediaLibrary(picked.path, picked.name, 'director-cinema,clip-image')
      onUpdate({ image })
    } catch (e) {
      setUploadError(e.message || 'Upload fallito')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="w-[280px] shrink-0 border-l border-[#252533] bg-[#0f0f18] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#252533] shrink-0">
        <span className="text-xs font-semibold text-[var(--text)]">Clip {clipIndex + 1}</span>
        <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]">
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Image picker (img2video only) */}
        {mode === 'img2video' && (
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">Immagine iniziale</label>
            <div
              onClick={uploading ? undefined : handlePickImage}
              className={clsx(
                'relative h-36 rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden transition-colors group/img',
                uploading ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:border-[var(--gold)]/40',
              )}
            >
              {uploading ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--gold)]">
                  <Loader2 size={22} className="animate-spin" />
                  <span className="text-[10px] font-mono">Upload in corso…</span>
                </div>
              ) : clip.image?.mediaId ? (
                <>
                  <img
                    src={mediaPreviewUrl(clip.image)}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                    <Upload size={18} className="text-white" />
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text3)]">
                  <Image size={24} />
                  <span className="text-[10px] font-mono text-center px-2">Clicca per aggiungere immagine</span>
                </div>
              )}
            </div>
            {uploadError && (
              <p className="mt-1 text-[10px] text-[var(--red)] font-mono">{uploadError}</p>
            )}
            {clip.image && (
              <button
                onClick={handlePickImage}
                className="mt-2 w-full text-[10px] font-mono text-[var(--text3)] hover:text-[var(--text2)] py-1 border border-[#252533] rounded transition-colors"
              >
                Cambia immagine
              </button>
            )}
          </div>
        )}

        {/* Prompt */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">Prompt motion</label>
          <div className={clsx(
            'rounded-lg border transition-all',
            enhancing
              ? 'border-[var(--gold)]/60 shadow-[0_0_0_1px_rgba(201,168,76,0.2)] animate-pulse'
              : 'border-[#252533] focus-within:border-[#32324a]'
          )}>
            <textarea
              value={clip.prompt}
              onChange={e => onUpdate({ prompt: e.target.value })}
              disabled={enhancing}
              rows={5}
              placeholder="Descrivi il movimento della camera e dell'azione..."
              className="w-full text-[11px] bg-transparent text-[var(--text)] px-3 py-2.5 font-mono resize-none outline-none rounded-lg placeholder-[var(--text3)] disabled:opacity-60"
            />
          </div>
          <button
            onClick={handleEnhance}
            disabled={enhancing || !clip.prompt.trim()}
            className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
          >
            {enhancing ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            {enhancing ? 'Miglioramento...' : 'Migliora'}
          </button>
        </div>

        {/* Duration */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">Durata</label>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="number"
              min={1}
              max={30}
              step={0.5}
              value={clip.duration}
              onChange={e => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v)) onUpdate({ duration: Math.min(30, Math.max(1, v)) })
              }}
              className="w-20 text-[11px] bg-[#1e1e2a] text-[var(--text)] rounded border border-[#252533] px-2 py-1.5 font-mono outline-none focus:border-[#32324a]"
            />
            <span className="text-[11px] text-[var(--text3)] font-mono">s</span>
          </div>
          <input
            type="range"
            min={1}
            max={30}
            step={0.5}
            value={clip.duration}
            onChange={e => onUpdate({ duration: parseFloat(e.target.value) })}
            className="w-full accent-[#c9a84c] h-1"
          />
          <div className="flex justify-between text-[9px] text-[var(--text3)] font-mono mt-1">
            <span>1s</span>
            <span>30s</span>
          </div>
        </div>
      </div>

      {/* Delete */}
      <div className="p-4 border-t border-[#252533] shrink-0">
        <button
          onClick={() => onDelete(clip.id)}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-[var(--red)]/30 text-[var(--red)] text-[11px] font-mono hover:bg-[var(--red)]/10 transition-colors"
        >
          <Trash2 size={13} />
          Elimina clip
        </button>
      </div>
    </div>
  )
}

// ── Generation Dock ────────────────────────────────────────────────────────────

function GenerationDock({
  project,
  workflows,
  generating,
  genProgress,
  genMsg,
  genResult,
  genError,
  onGenerate,
  onDismissError,
  onUpdateProject,
}) {
  const [enhancingGlobal, setEnhancingGlobal] = useState(false)

  async function handleEnhanceGlobal() {
    if (!project.globalPrompt.trim() || enhancingGlobal) return
    setEnhancingGlobal(true)
    try {
      await syncDirectorProjectToVault(project, BACKEND_ORIGIN)
      const res = await director.enhance({
        prompt: project.globalPrompt,
        context: 'director_global',
        project_context: buildDirectorCinemaEnhanceContext(project),
      })
      onUpdateProject({ globalPrompt: normalizeUnifiedPrompt(res?.enhanced, project.globalPrompt, res?.negative_prompt) })
    } catch {
      // silent
    } finally {
      setEnhancingGlobal(false)
    }
  }

  return (
    <div className="shrink-0" style={{ background: 'var(--bg1)', borderTop: '1px solid var(--border)' }}>
      {/* Progress bar */}
      {generating && (
        <div className="h-0.5 w-full bg-[#252533]">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${genProgress}%`, background: 'var(--gold)' }}
          />
        </div>
      )}

      {/* Result banner */}
      {genResult && !generating && (
        <div className="flex items-center gap-3 px-4 py-2 bg-green-900/20 border-b border-green-500/20">
          <CheckCircle size={14} className="text-green-400 shrink-0" />
          <span className="text-[11px] text-green-400 font-mono flex-1">Video pronto! {genResult.filename ?? ''}</span>
          {genResult.path && (
            <button
              onClick={() => window.studio?.shell?.openPath?.(genResult.path)}
              className="text-[10px] font-mono text-green-400 border border-green-500/30 px-2 py-0.5 rounded hover:bg-green-500/10 transition-colors"
            >
              Apri
            </button>
          )}
        </div>
      )}

      {/* Error banner */}
      {genError && !generating && (
        <div className="flex items-center gap-3 px-4 py-2 bg-red-900/20 border-b border-red-500/20">
          <AlertCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-[11px] text-red-400 font-mono flex-1 truncate">{genError}</span>
          <button onClick={onDismissError} className="text-[var(--text3)] hover:text-[var(--text)]">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Main dock row */}
      <div className="flex items-center gap-4 px-4" style={{ height: 56 }}>
        {/* Workflow selector */}
        <div className="flex items-center gap-2 shrink-0">
          <Settings size={12} className="text-[var(--text3)]" />
          <select
            value={project.workflowId}
            onChange={e => onUpdateProject({ workflowId: e.target.value })}
            className="text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono outline-none max-w-[180px]"
          >
            {workflows.length > 0 ? (
              workflows.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)
            ) : (
              <option value={project.workflowId}>{project.workflowId}</option>
            )}
          </select>
        </div>

        {/* Mode toggle (center) */}
        <div className="flex gap-1 flex-1 justify-center">
          <button
            onClick={() => onUpdateProject({ mode: 'txt2video' })}
            className={clsx(
              'px-3 py-1 rounded text-[10px] font-mono border transition-all',
              project.mode === 'txt2video'
                ? 'border-blue-500/60 bg-blue-500/10 text-blue-400'
                : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
            )}
          >
            txt2video
          </button>
          <button
            onClick={() => onUpdateProject({ mode: 'img2video' })}
            className={clsx(
              'px-3 py-1 rounded text-[10px] font-mono border transition-all',
              project.mode === 'img2video'
                ? 'border-amber-500/60 bg-amber-500/10 text-amber-400'
                : 'border-[#252533] text-[var(--text3)] hover:border-[#32324a]'
            )}
          >
            img2video
          </button>
        </div>

        {/* Right group */}
        <div className="flex items-center gap-3 shrink-0">
          {/* FPS */}
          <select
            value={project.fps}
            onChange={e => onUpdateProject({ fps: parseInt(e.target.value) })}
            className="text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-1.5 py-1.5 border border-[#252533] font-mono outline-none"
          >
            {FPS_OPTIONS.map(f => <option key={f} value={f}>{f}fps</option>)}
          </select>

          {/* Resolution display */}
          <span className="text-[10px] font-mono text-[var(--text3)]">{project.width}x{project.height}</span>

          {/* Enhance global */}
          <button
            onClick={handleEnhanceGlobal}
            disabled={enhancingGlobal || !project.globalPrompt.trim()}
            className="flex items-center gap-1 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
          >
            {enhancingGlobal ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            Migliora Globale
          </button>

          {/* Generate button */}
          <button
            onClick={onGenerate}
            disabled={generating || project.clips.length === 0}
            className="flex items-center gap-2 rounded-lg font-mono text-xs px-4 py-2 transition-all disabled:opacity-40"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            {generating
              ? <Loader2 size={13} className="animate-spin" />
              : <Play size={13} />
            }
            {generating ? `${genProgress}%` : 'Genera'}
          </button>
        </div>
      </div>

      {/* Progress message */}
      {generating && genMsg && (
        <div className="px-4 pb-2">
          <span className="text-[9px] font-mono text-[var(--text3)]">{genMsg}</span>
        </div>
      )}
    </div>
  )
}

// ── VIEW 3: Workspace ──────────────────────────────────────────────────────────

function WorkspaceView({ project, onBack, onUpdateProject }) {
  const [selectedClipId, setSelectedClipId] = useState(null)
  const [workflows, setWorkflows]           = useState([])
  const [generating, setGenerating]         = useState(false)
  const [directorJobId, setDirectorJobId]   = useState(null)
  const [genProgress, setGenProgress]       = useState(0)
  const [genMsg, setGenMsg]                 = useState('')
  const [genResult, setGenResult]           = useState(null)
  const [genError, setGenError]             = useState(null)
  const [editingName, setEditingName]       = useState(false)
  const nameRef = useRef(null)

  useEffect(() => {
    director.getWorkflows().then(wfs => setWorkflows(wfs ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (editingName) nameRef.current?.focus()
  }, [editingName])

  // Selected clip derived
  const selectedClip      = project.clips.find(c => c.id === selectedClipId) ?? null
  const selectedClipIndex = project.clips.findIndex(c => c.id === selectedClipId)

  // Total timeline width
  const totalClipsDuration = project.clips.reduce((s, c) => s + c.duration, 0)
  const timelineWidth      = Math.max(totalClipsDuration * PX_PER_SEC + 200, 600)

  // Clip CRUD helpers
  function addClip() {
    const clip = {
      id:       genId(),
      prompt:   '',
      duration: 4,
      image:    null,
    }
    onUpdateProject({ clips: [...project.clips, clip] })
    setSelectedClipId(clip.id)
  }

  function deleteClip(id) {
    if (selectedClipId === id) setSelectedClipId(null)
    onUpdateProject({ clips: project.clips.filter(c => c.id !== id) })
  }

  function resizeClip(id, duration) {
    onUpdateProject({ clips: project.clips.map(c => c.id === id ? { ...c, duration } : c) })
  }

  function updateClip(id, patch) {
    onUpdateProject({ clips: project.clips.map(c => c.id === id ? { ...c, ...patch } : c) })
  }

  // Audio
  async function handleAddAudio() {
    const picked = await director.pickAudio()
    if (!picked?.path) return
    try {
      const audio = await uploadToMediaLibrary(picked.path, picked.name, 'director-cinema,audio')
      onUpdateProject({ audio })
    } catch (e) {
      setGenError(e.message || 'Upload audio fallito')
    }
  }

  function handleRemoveAudio() {
    onUpdateProject({ audio: null })
  }

  useDirectorMediaReconcile({
    enabled: Boolean(directorJobId && (generating || genError)),
    jobId: directorJobId,
    onResult: (data) => {
      const hit = data.recovered?.find(e => e.event === 'director_done')
      if (hit) {
        setGenResult({
          done: true,
          job_id: hit.job_id,
          path: hit.path,
          filename: hit.path ? hit.path.split(/[/\\]/).pop() : undefined,
          url: hit.url,
        })
        setGenerating(false)
        setGenError(null)
        setGenMsg('Video recuperato da disco/ComfyUI')
      }
    },
  })

  // Generation
  async function handleGenerate() {
    setGenerating(true)
    setGenProgress(0)
    setGenMsg('')
    setGenResult(null)
    setGenError(null)
    setDirectorJobId(null)

    const params = {
      workflow_id:   project.workflowId,
      mode:          project.mode,
      global_prompt: project.globalPrompt,
      clips: project.clips.map(c => ({
        id:           c.id,
        prompt:       c.prompt,
        duration_sec: c.duration,
        image_path:   c.image?.path ?? null,
      })),
      audio_path:    project.audio?.path ?? null,
      fps:           project.fps,
      width:         project.width,
      height:        project.height,
      project_name:  project.name,
    }

    try {
      await director.generate(params, (data) => {
        if (data.job_id) setDirectorJobId(data.job_id)
        if (data.event === 'start' && data.job_id) setDirectorJobId(data.job_id)
        if (data.error) {
          setGenError(data.error)
          setGenerating(false)
          return
        }
        if (data.done) {
          setGenResult(data)
          setGenerating(false)
          return
        }
        if (data.comfyui_max > 1) {
          setGenProgress(Math.round((data.comfyui_value / data.comfyui_max) * 100))
        } else if (data.pct !== undefined) {
          setGenProgress(Math.round(data.pct * 100))
        }
        if (data.msg) setGenMsg(data.msg)
      })
    } catch (e) {
      setGenError(e.message ?? 'Errore generazione')
      setGenerating(false)
    }
  }

  // Global prompt enhance
  async function handleEnhanceGlobal() {
    if (!project.globalPrompt.trim()) return
    try {
      await syncDirectorProjectToVault(project, BACKEND_ORIGIN)
      const res = await director.enhance({
        prompt: project.globalPrompt,
        context: 'director_global',
        project_context: buildDirectorCinemaEnhanceContext(project),
      })
      onUpdateProject({ globalPrompt: normalizeUnifiedPrompt(res?.enhanced, project.globalPrompt, res?.negative_prompt) })
    } catch {
      // silent
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Workspace Header ── */}
      <div
        className="flex items-center gap-3 px-4 shrink-0 border-b border-[#252533]"
        style={{ height: 48, background: 'var(--bg1)' }}
      >
        {/* Back */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--text3)] hover:text-[var(--text)] transition-colors"
        >
          <ArrowLeft size={14} />
          Indietro
        </button>

        <div className="w-px h-5 bg-[#252533]" />

        {/* Project name (inline editable) */}
        {editingName ? (
          <input
            ref={nameRef}
            value={project.name}
            onChange={e => onUpdateProject({ name: e.target.value })}
            onBlur={() => setEditingName(false)}
            onKeyDown={e => { if (e.key === 'Enter') setEditingName(false) }}
            className="text-sm font-semibold bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-0.5 border border-[var(--gold)]/40 outline-none font-mono"
          />
        ) : (
          <span
            onClick={() => setEditingName(true)}
            className="text-sm font-semibold text-[var(--text)] cursor-text hover:text-[var(--gold)] transition-colors select-none"
            title="Clicca per rinominare"
          >
            {project.name}
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Badges */}
        <Badge color={project.mode === 'img2video' ? 'amber' : 'blue'}>
          {project.mode}
        </Badge>
        <Badge color="dim">{project.width}x{project.height}</Badge>
        <Badge color="dim">{project.fps}fps</Badge>
        <Badge color="dim">{project.clips.length} clip{project.clips.length !== 1 ? 's' : ''}</Badge>
      </div>

      {/* ── Content Area ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Timeline Panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Global prompt strip */}
          <div
            className="flex items-center gap-2 px-4 shrink-0 border-b border-[#252533]"
            style={{ height: 44, background: 'var(--bg2)' }}
          >
            <textarea
              value={project.globalPrompt}
              onChange={e => onUpdateProject({ globalPrompt: e.target.value })}
              placeholder="Descrizione globale della scena..."
              rows={1}
              className="flex-1 text-[11px] bg-transparent text-[var(--text)] font-mono resize-none outline-none placeholder-[var(--text3)] leading-tight"
              style={{ paddingTop: 2, paddingBottom: 2 }}
            />
            <button
              onClick={handleEnhanceGlobal}
              disabled={!project.globalPrompt.trim()}
              className="flex items-center gap-1 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors shrink-0 px-2 py-1 rounded border border-[#252533] hover:border-[#32324a]"
            >
              <Wand2 size={10} />
              Migliora
            </button>
          </div>

          {/* Timeline canvas area */}
          <div className="flex-1 overflow-x-auto overflow-y-hidden" style={{ background: 'var(--bg0)' }}>
            <div style={{ width: timelineWidth, minHeight: '100%', position: 'relative', padding: '16px' }}>
              {/* ── Clips track label ── */}
              <div className="flex items-center gap-1 mb-2">
                <Film size={10} className="text-[var(--text3)]" />
                <span className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Clips</span>
                <span className="text-[9px] font-mono text-[var(--text3)] ml-2">{totalClipsDuration.toFixed(1)}s total</span>
              </div>

              {/* ── Clips track ── */}
              <div
                className="flex gap-0.5 mb-4 relative"
                style={{ height: 120 }}
              >
                {project.clips.map((clip, i) => (
                  <ClipCard
                    key={clip.id}
                    clip={clip}
                    index={i}
                    mode={project.mode}
                    isSelected={selectedClipId === clip.id}
                    onSelect={setSelectedClipId}
                    onDelete={deleteClip}
                    onResize={resizeClip}
                  />
                ))}

                {/* Add clip button */}
                <button
                  onClick={addClip}
                  className="flex-shrink-0 flex flex-col items-center justify-center gap-1 border border-dashed border-[#252533] rounded hover:border-[var(--gold)]/40 hover:bg-[var(--gold)]/5 transition-all text-[var(--text3)] hover:text-[var(--gold)]"
                  style={{ width: 80, height: '100%' }}
                >
                  <Plus size={16} />
                  <span className="text-[8px] font-mono">Clip</span>
                </button>
              </div>

              {/* ── Audio track label ── */}
              <div className="flex items-center gap-1 mb-1.5">
                <Music size={10} className="text-[var(--text3)]" />
                <span className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Audio</span>
              </div>

              {/* ── Audio track ── */}
              <div style={{ height: 40 }}>
                <AudioTrack
                  audio={project.audio}
                  totalWidth={totalClipsDuration * PX_PER_SEC}
                  onAdd={handleAddAudio}
                  onRemove={handleRemoveAudio}
                />
              </div>

              {/* ── Timecode ruler ── */}
              <div className="relative mt-3" style={{ height: 16 }}>
                {Array.from({ length: Math.ceil(totalClipsDuration) + 1 }, (_, i) => (
                  <div
                    key={i}
                    className="absolute flex flex-col items-start"
                    style={{ left: i * PX_PER_SEC }}
                  >
                    <div className="w-px h-2 bg-[#252533]" />
                    <span className="text-[8px] font-mono text-[var(--text3)] mt-0.5">{i}s</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ── Clip Editor Sidebar ── */}
        {selectedClip && (
          <ClipEditorSidebar
            clip={selectedClip}
            clipIndex={selectedClipIndex}
            mode={project.mode}
            project={project}
            onUpdate={patch => updateClip(selectedClip.id, patch)}
            onDelete={id => { deleteClip(id); setSelectedClipId(null) }}
            onClose={() => setSelectedClipId(null)}
          />
        )}
      </div>

      {/* ── Generation Dock ── */}
      <GenerationDock
        project={project}
        workflows={workflows}
        generating={generating}
        genProgress={genProgress}
        genMsg={genMsg}
        genResult={genResult}
        genError={genError}
        onGenerate={handleGenerate}
        onDismissError={() => setGenError(null)}
        onUpdateProject={onUpdateProject}
      />
    </div>
  )
}

// ── Main Screen ────────────────────────────────────────────────────────────────

export default function DirectorCinemaScreen() {
  const location = useLocation()
  const navigate = useNavigate()
  const [projects, setProjects]        = useState(() => loadProjects())
  const [activeProjectId, setActiveId] = useState(null)
  const [showNewModal, setShowNew]     = useState(false)

  useEffect(() => {
    if (!location.state?.newProject) return
    setShowNew(true)
    navigate('/director', { replace: true, state: {} })
  }, [location.state?.newProject])

  // Persist on every projects change
  useEffect(() => {
    saveProjects(projects)
  }, [projects])

  const activeProject = projects.find(p => p.id === activeProjectId) ?? null

  function createProject(project) {
    const updated = [project, ...projects]
    setProjects(updated)
    setActiveId(project.id)
    setShowNew(false)
  }

  function deleteProject(id) {
    setProjects(prev => prev.filter(p => p.id !== id))
    if (activeProjectId === id) setActiveId(null)
  }

  function updateProject(patch) {
    setProjects(prev => prev.map(p => p.id === activeProjectId ? { ...p, ...patch } : p))
  }

  function openProject(id) {
    setActiveId(id)
  }

  function goBack() {
    setActiveId(null)
  }

  // Workspace view
  if (activeProject) {
    return (
      <WorkspaceView
        key={activeProject.id}
        project={activeProject}
        onBack={goBack}
        onUpdateProject={updateProject}
      />
    )
  }

  // Projects list view
  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: 'var(--bg0)' }}>
      {showNewModal && (
        <NewProjectModal
          existingCount={projects.length}
          onClose={() => setShowNew(false)}
          onCreate={createProject}
        />
      )}
      <ProjectsListView
        projects={projects}
        onOpen={openProject}
        onDelete={deleteProject}
        onNew={() => setShowNew(true)}
      />
    </div>
  )
}
