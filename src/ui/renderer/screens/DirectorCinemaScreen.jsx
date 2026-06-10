/**
 * DirectorCinemaScreen — Timeline-based AI video director tool.
 * Maps to LTX Director 2.3 ComfyUI workflow parameters.
 * Projects are persisted in localStorage('director-cinema-projects').
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, X, Trash2, Music, Image, Wand2, Play,
  Film, Loader2, CheckCircle, AlertCircle,
  Upload, Clock, Settings, Sparkles, Maximize2, Check, RefreshCw,
} from 'lucide-react'
import clsx from 'clsx'
import { normalizeUnifiedPrompt } from '../utils/promptEnhance'
import { API_BASE, BACKEND_ORIGIN } from '../utils/apiClient'
import {
  buildDirectorCinemaEnhanceContext,
  syncDirectorProjectToVault,
} from '../utils/obsidianEnhanceContext'
import { useDirectorMediaReconcile } from '../hooks/useMediaReconcile'
import ImageLightbox from '../components/ImageLightbox'
import TransitionPicker from '../components/TransitionPicker'
import { TRANSITIONS, DEFAULT_TRANSITION } from '../components/TransitionEngine'
import TimelinePreview from '../components/TimelinePreview'

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

// Risoluzioni immagine per generazione txt2img — stesso aspect ratio, dal più basso al 4K
const IMG_GEN_RESOLUTIONS = {
  '16:9': [
    { label: '720p',  w: 1280,  h: 720  },
    { label: '1080p', w: 1920,  h: 1080 },
    { label: '1440p', w: 2560,  h: 1440 },
    { label: '4K',    w: 3840,  h: 2160 },
  ],
  '9:16': [
    { label: '720p',  w: 720,   h: 1280  },
    { label: '1080p', w: 1080,  h: 1920  },
    { label: '1440p', w: 1440,  h: 2560  },
    { label: '4K',    w: 2160,  h: 3840  },
  ],
  '1:1': [
    { label: '512',   w: 512,   h: 512   },
    { label: '1024',  w: 1024,  h: 1024  },
    { label: '1536',  w: 1536,  h: 1536  },
    { label: '2048',  w: 2048,  h: 2048  },
    { label: '3840',  w: 3840,  h: 3840  },
  ],
  '4:3': [
    { label: '768p',  w: 1024,  h: 768   },
    { label: '960p',  w: 1280,  h: 960   },
    { label: '1200p', w: 1600,  h: 1200  },
    { label: '4K',    w: 3840,  h: 2880  },
  ],
  '21:9': [
    { label: '576p',  w: 1344,  h: 576   },
    { label: '1080p', w: 2560,  h: 1080  },
    { label: '1440p', w: 3440,  h: 1440  },
    { label: '4K',    w: 3840,  h: 1646  },
  ],
}

function imgGenDefaultRes(aspectRatio, projectW, projectH) {
  const list = IMG_GEN_RESOLUTIONS[aspectRatio] ?? IMG_GEN_RESOLUTIONS['16:9']
  const targetW = projectW * 2
  const targetH = projectH * 2
  // Cerca la risoluzione più vicina al doppio del progetto
  return list.reduce((best, r) => {
    const dBest = Math.abs(r.w - targetW) + Math.abs(r.h - targetH)
    const dCurr = Math.abs(best.w - targetW) + Math.abs(best.h - targetH)
    return dBest < dCurr ? r : best
  }, list[list.length - 1])
}

const FPS_OPTIONS = [24, 25, 30]

// ── Utilities ──────────────────────────────────────────────────────────────────

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  try {
    fetch(`${API}/director/projects`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (Array.isArray(data) && data.length > 0) {
          localStorage.setItem(LS_KEY, JSON.stringify(data))
        }
      })
      .catch(() => {})
  } catch {
    // ignore
  }
  return []
}

function saveProjects(projects) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(projects))
  } catch {
    // storage full — silently ignore
  }
  projects.forEach(project => {
    fetch(`${API}/director/projects/${project.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(project),
    }).catch(() => {})
  })
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
      <div className="h-0.5 w-full" style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }} />

      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <p className="font-semibold text-[var(--text)] text-sm leading-tight truncate flex-1">{project.name}</p>
          <button
            onClick={handleDelete}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-[var(--text3)] hover:text-[var(--red)]"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Badge color={project.mode === 'img2video' ? 'amber' : 'blue'}>
            {project.mode === 'img2video' ? 'img2video' : 'txt2video'}
          </Badge>
          <Badge color="dim">{project.width}x{project.height}</Badge>
          <Badge color="dim">{project.fps ?? 24} fps</Badge>
        </div>

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

        <p className="text-[9px] text-[var(--text3)] font-mono mt-2">{formatDate(project.createdAt)}</p>
      </div>

      <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
           style={{ boxShadow: 'inset 0 0 0 1px rgba(201,168,76,0.25)' }} />
    </div>
  )
}

function ProjectsListView({ projects, onOpen, onDelete, onNew }) {
  return (
    <div className="flex flex-col h-full">
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
  const [ar, setAr]             = useState('16:9')
  const [resIdx, setResIdx]     = useState(0)
  const [fps, setFps]           = useState(24)

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
      mode:        'img2video',
      workflowId:  'ltx_director_img2video',
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
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#252533]">
          <span className="font-semibold text-sm text-[var(--text)]">Nuovo progetto Director</span>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Nome progetto</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full text-sm bg-[#1e1e2a] text-[var(--text)] rounded-lg px-3 py-2.5 border border-[#252533] outline-none focus:border-[var(--gold)] transition-colors"
              autoFocus
            />
          </div>

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
        </div>

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
      const snapped = Math.max(1, Math.round(newDur))
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

      <div className={clsx('absolute inset-0 flex flex-col justify-between p-1.5', hasImage && 'pl-16')}>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-[var(--gold)] opacity-60">#{index + 1}</span>
        </div>

        <p className="text-[9px] text-[var(--text2)] leading-tight line-clamp-2 font-mono overflow-hidden flex-1 mt-1">
          {clip.prompt
            ? clip.prompt
            : <span className="text-[var(--text3)] italic">Prompt vuoto</span>}
        </p>

        <div className="flex items-center justify-between mt-1">
          <span className="text-[8px] font-mono text-[var(--text3)]">{clip.duration}s</span>
          {(() => {
            const ct = clip.clipType ?? (clip.image ? 'img2video' : 'txt2video')
            const colors = { txt2img: '#a78bfa', img2video: '#f59e0b', txt2video: '#3b82f6' }
            return <span className="text-[7px] font-mono" style={{ color: colors[ct] ?? '#9090a8', opacity: 0.8 }}>{ct}</span>
          })()}
          {clip.transition && clip.transition !== 'cut' && (
            <span className="text-[8px] font-mono text-[#c9a84c] opacity-70">
              {TRANSITIONS[clip.transition]?.icon || ''}
            </span>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(clip.id) }}
            className="opacity-0 group-hover/clip:opacity-100 transition-opacity text-[var(--text3)] hover:text-[var(--red)]"
          >
            <X size={10} />
          </button>
        </div>
      </div>

      <div
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize bg-transparent hover:bg-[var(--gold)]/20 transition-colors"
        onMouseDown={onResizeMouseDown}
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}

// ── Audio Track Bar ────────────────────────────────────────────────────────────

function AudioTrack({ audio, totalWidth, onAdd, onRemove, onOffsetChange }) {
  const dragRef = useRef(null)

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

  const offsetSec = audio.audioOffsetSec ?? 0
  const blockWidth = Math.max(totalWidth - offsetSec * PX_PER_SEC, 120)

  function onDragMouseDown(e) {
    e.preventDefault()
    const startX      = e.clientX
    const startOffset = offsetSec

    function onMouseMove(me) {
      const deltaX    = me.clientX - startX
      const newOffset = Math.max(0, startOffset + deltaX / PX_PER_SEC)
      onOffsetChange(Math.round(newOffset * 10) / 10)
    }
    function onMouseUp() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    dragRef.current = onMouseUp
  }

  return (
    <div className="relative h-full" style={{ width: Math.max(totalWidth, 200) }}>
      {offsetSec > 0 && (
        <div style={{ width: offsetSec * PX_PER_SEC, display: 'inline-block' }} />
      )}
      <div
        className="inline-flex items-center gap-2 h-full rounded border border-amber-500/30 bg-amber-500/10 px-3 overflow-hidden group/audio relative cursor-grab active:cursor-grabbing"
        style={{ width: blockWidth, verticalAlign: 'top' }}
        onMouseDown={onDragMouseDown}
      >
        <Music size={11} className="text-amber-400 shrink-0" />
        <span className="text-[9px] font-mono text-amber-300 truncate flex-1">{audio.name}</span>
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="opacity-0 group-hover/audio:opacity-100 transition-opacity text-amber-400 hover:text-[var(--red)] shrink-0"
          onMouseDown={e => e.stopPropagation()}
        >
          <X size={11} />
        </button>
        {offsetSec > 0 && (
          <span className="absolute bottom-0.5 left-2 text-[8px] font-mono text-amber-500/70">+{offsetSec}s</span>
        )}
      </div>
    </div>
  )
}

// ── Clip Editor Sidebar ────────────────────────────────────────────────────────

const CLIP_TYPES = [
  { key: 'txt2img',   label: 'txt→img',   hint: 'Genera immagine da testo',    colorActive: 'bg-[#a78bfa]/15 border-[#a78bfa]/40 text-[#a78bfa]', colorDot: '#a78bfa' },
  { key: 'img2video', label: 'img→video', hint: 'Anima immagine in video',     colorActive: 'bg-[#f59e0b]/15 border-[#f59e0b]/40 text-[#f59e0b]', colorDot: '#f59e0b' },
  { key: 'txt2video', label: 'txt→video', hint: 'Genera video da testo diretto', colorActive: 'bg-[#3b82f6]/15 border-[#3b82f6]/40 text-[#3b82f6]', colorDot: '#3b82f6' },
]

function ClipEditorSidebar({ clip, clipIndex, mode, project, expanded, onToggleExpand, onUpdate, onDelete, onClose }) {
  // Derive clip type: saved value > infer from clip.image > project mode
  const clipType = clip.clipType ?? (clip.image ? 'img2video' : (mode === 'img2video' ? 'img2video' : 'txt2video'))
  const [enhancing, setEnhancing]               = useState(false)
  const [uploading, setUploading]               = useState(false)
  const [uploadError, setUploadError]           = useState(null)
  const [aiMagicLoading, setAiMagicLoading]     = useState(false)
  const [genImageOpen, setGenImageOpen]         = useState(false)
  const [txt2imgWorkflows, setTxt2imgWorkflows] = useState([])
  const [selectedTxt2Img, setSelectedTxt2Img]   = useState('')
  const [generatingImage, setGeneratingImage]   = useState(false)
  const [imageGenProgress, setImageGenProgress] = useState(0)
  const [enhancingImgPrompt, setEnhancingImgPrompt] = useState(false)
  const [imgGenPrompt, setImgGenPrompt]         = useState('')
  const [imgGenSteps, setImgGenSteps]           = useState(20)
  const [imgGenRes, setImgGenRes] = useState(() =>
    imgGenDefaultRes(project.aspectRatio, project.width, project.height)
  )

  // Task 1 — live ComfyUI step progress
  const [imgGenStep, setImgGenStep]       = useState(0)
  const [imgGenStepMax, setImgGenStepMax] = useState(0)

  // Task 2 — pending image preview + lightbox
  const [pendingImage, setPendingImage]   = useState(null)
  const [lightboxOpen, setLightboxOpen]   = useState(false)

  // Task 3 — per-clip video generation
  const [clipVideoWorkflow, setClipVideoWorkflow]     = useState('')
  const [clipVideoWorkflows, setClipVideoWorkflows]   = useState([])
  const [generatingClipVideo, setGeneratingClipVideo] = useState(false)
  const [clipVideoProgress, setClipVideoProgress]     = useState(0)
  const [clipVideoDone, setClipVideoDone]             = useState(false)

  // Job recovery state
  const [currentJobId, setCurrentJobId]   = useState(null)
  const [pendingJobs, setPendingJobs]     = useState([])
  const [recoveringJob, setRecoveringJob] = useState(false)
  const [recoveryError, setRecoveryError] = useState(null)

  useEffect(() => {
    if (!genImageOpen) return
    setImgGenPrompt(clip.sceneDescription?.trim() || clip.prompt?.trim() || '')
    setImgGenRes(imgGenDefaultRes(project.aspectRatio, project.width, project.height))
    fetch(`${API}/reel/workflows`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const list = data?.txt2img ?? []
        setTxt2imgWorkflows(list)
        if (list.length > 0) setSelectedTxt2Img(list[0].id)
      })
      .catch(() => {})
    fetch(`${API}/director/jobs/pending?project_id=${encodeURIComponent(project.id)}&clip_id=${encodeURIComponent(clip.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.jobs?.length > 0) setPendingJobs(data.jobs)
      })
      .catch(() => {})
  }, [genImageOpen])

  useEffect(() => {
    fetch(`${API}/director/jobs/pending?project_id=${encodeURIComponent(project.id)}&clip_id=${encodeURIComponent(clip.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.jobs?.length > 0) setPendingJobs(data.jobs) })
      .catch(() => {})
  }, [clip.id, project.id])

  useEffect(() => {
    fetch(`${API}/reel/workflows`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const hasAudio = Boolean(project.audio?.path)
        let list
        if (clipType === 'img2video' && hasAudio) list = data?.img_audio2video ?? []
        else if (clipType === 'img2video')         list = data?.img2video ?? []
        else                                       list = data?.txt2video ?? []
        setClipVideoWorkflows(list)
        if (list.length > 0) setClipVideoWorkflow(v => v || list[0].id)
      })
      .catch(() => {})
  }, [clipType, Boolean(project.audio?.path)])

  async function handleEnhance() {
    if (!clip.prompt.trim() || enhancing) return
    setEnhancing(true)
    try {
      await syncDirectorProjectToVault(project, BACKEND_ORIGIN)
      const baseContext = buildDirectorCinemaEnhanceContext(project, clip)
      const res = await director.enhance({
        prompt: clip.prompt,
        context: 'director_clip',
        project_context: {
          ...baseContext,
          scene_description: clip.sceneDescription || '',
          image_prompt: clip.image?.generationPrompt || '',
          has_image: Boolean(clip.image),
          mode: clip.image ? 'img2video' : 'txt2video',
        },
      })
      onUpdate({ prompt: normalizeUnifiedPrompt(res?.enhanced, clip.prompt, res?.negative_prompt) })
    } catch {
      // silent
    } finally {
      setEnhancing(false)
    }
  }

  async function handleEnhanceImgPrompt() {
    if (!imgGenPrompt.trim() || enhancingImgPrompt) return
    setEnhancingImgPrompt(true)
    try {
      const res = await fetch(`${API}/director/enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: imgGenPrompt,
          context: 'director_image_prompt',
          project_context: {
            scene_description: clip.sceneDescription || '',
            global_prompt: project.globalPrompt || '',
            aspect_ratio: project.aspectRatio || '16:9',
            width: imgGenRes?.w || project.width,
            height: imgGenRes?.h || project.height,
            workflow_id: selectedTxt2Img,
            mode: 'txt2img',
          },
        }),
      })
      const data = await res.json()
      if (data?.enhanced) setImgGenPrompt(data.enhanced)
    } catch { }
    finally { setEnhancingImgPrompt(false) }
  }

  async function handlePickImage() {
    const picked = await director.pickImage()
    if (!picked?.path) return
    setUploading(true)
    setUploadError(null)
    try {
      // Verifica aspect ratio tramite img element
      await new Promise((resolve, reject) => {
        const img = new window.Image()
        img.onload = () => {
          const targetRatio = project.width / project.height
          const imgRatio    = img.naturalWidth / img.naturalHeight
          const tolerance   = 0.05
          if (Math.abs(imgRatio - targetRatio) > tolerance) {
            reject(new Error(
              `Formato immagine non compatibile (${img.naturalWidth}×${img.naturalHeight}). ` +
              `Il progetto usa ${project.aspectRatio} (${project.width}×${project.height}).`
            ))
          } else {
            resolve()
          }
        }
        img.onerror = () => resolve() // se non si riesce a leggere, passa lo stesso
        img.src = `file://${picked.path.replace(/\\/g, '/')}`
      })
      const image = await uploadToMediaLibrary(picked.path, picked.name, 'director-cinema,clip-image')
      onUpdate({ image })
    } catch (e) {
      setUploadError(e.message || 'Upload fallito')
    } finally {
      setUploading(false)
    }
  }

  async function handleAiMagic() {
    if (!clip.sceneDescription?.trim() || aiMagicLoading) return
    setAiMagicLoading(true)
    try {
      const res = await fetch(`${API}/director/ai-scene-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scene_description: clip.sceneDescription,
          global_prompt: project.globalPrompt,
          mode: project.mode,
        }),
      })
      const data = await res.json()
      if (data.ok && data.prompt) {
        onUpdate({ prompt: data.prompt })
      }
    } catch {
      // silent
    } finally {
      setAiMagicLoading(false)
    }
  }

  async function handleGenerateImage() {
    if (generatingImage) return
    setGeneratingImage(true)
    setImageGenProgress(0)
    setImgGenStep(0)
    setImgGenStepMax(0)
    setPendingImage(null)
    try {
      const promptToUse = imgGenPrompt.trim() || clip.sceneDescription?.trim() || clip.prompt
      const res = await fetch(`${API}/director/clips/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clip_id: clip.id,
          project_id: project.id,
          prompt: promptToUse,
          workflow_id: selectedTxt2Img,
          width: imgGenRes.w,
          height: imgGenRes.h,
          steps: imgGenSteps,
        }),
      })

      if (!res.ok) {
        setGeneratingImage(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const evt = JSON.parse(line.slice(5).trim())
            if (evt.event === 'job_tracking' && evt.job_id) {
              setCurrentJobId(evt.job_id)
            }
            if ((evt.event === 'progress' || evt.event === 'comfyui_progress') && evt.pct !== undefined) {
              setImageGenProgress(Math.round(evt.pct * 100))
            }
            if ((evt.event === 'progress' || evt.event === 'comfyui_progress') && evt.step !== undefined) {
              setImgGenStep(evt.step ?? 0)
              setImgGenStepMax(evt.max_step ?? imgGenSteps)
            }
            if (evt.event === 'done' && evt.image_path) {
              setPendingImage({
                path: evt.image_path,
                previewUrl: evt.preview_url ?? null,
                name: evt.image_path.split(/[/\\]/).pop(),
                mediaId: evt.media_id ?? null,
              })
              setGeneratingImage(false)
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch {
      // silent
    } finally {
      setGeneratingImage(false)
    }
  }

  async function handleRecoverJob(jobId) {
    if (recoveringJob) return
    setRecoveringJob(true)
    setRecoveryError(null)
    try {
      const res = await fetch(`${API}/director/jobs/${jobId}/recover`, { method: 'POST' })
      const data = await res.json()
      if (data.ok && data.result_path) {
        const fname = data.result_path.split(/[/\\]/).pop()
        setPendingImage({
          path: data.result_path,
          name: fname,
          mediaId: null,
          previewUrl: data.preview_url
            ? `${BACKEND_ORIGIN}${data.preview_url}`
            : `${BACKEND_ORIGIN}/api/director/projects/${project.id}/images/${fname}`,
        })
        setPendingJobs(prev => prev.filter(j => j.job_id !== jobId))
        setGenImageOpen(true)
      } else if (data.status === 'still_running') {
        setRecoveryError('Job ancora in esecuzione su ComfyUI — riprova tra qualche secondo')
      } else {
        setRecoveryError(data.error || 'Recovery fallita')
      }
    } catch (e) {
      setRecoveryError(e.message || 'Errore di rete')
    } finally {
      setRecoveringJob(false)
    }
  }

  async function handleGenerateClipVideo() {
    if (generatingClipVideo || !clipVideoWorkflow) return
    setGeneratingClipVideo(true)
    setClipVideoProgress(0)
    setClipVideoDone(false)
    try {
      // Calcola audio_start_sec: posizione della clip sulla timeline + offset audio
      const hasAudio   = Boolean(project.audio?.path)
      const audioOffset = project.audio?.audioOffsetSec ?? 0
      const clipStartSec = project.clips
        .slice(0, project.clips.findIndex(c => c.id === clip.id))
        .reduce((s, c) => s + (c.duration || 3), 0)
      const audioStartSec = hasAudio ? audioOffset + clipStartSec : 0

      const body = {
        clip_id:      clip.id,
        project_id:   project.id,
        prompt:       clip.prompt || clip.sceneDescription || '',
        workflow_id:  clipVideoWorkflow,
        image_path:   clip.image?.path || null,
        audio_path:   hasAudio ? project.audio.path : null,
        audio_start_sec: audioStartSec,
        width:        project.width,
        height:       project.height,
        fps:          project.fps,
        duration_sec: clip.duration,
      }
      const res = await fetch(`${API}/director/clips/generate-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) { setGeneratingClipVideo(false); return }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const evt = JSON.parse(line.slice(5).trim())
            if (evt.event === 'progress' && evt.pct !== undefined)
              setClipVideoProgress(Math.round(evt.pct * 100))
            if (evt.event === 'done') {
              setClipVideoDone(true)
              setGeneratingClipVideo(false)
              if (evt.video_path) onUpdate({ videoPath: evt.video_path, videoUrl: evt.video_url })
            }
            if (evt.error) setGeneratingClipVideo(false)
          } catch { /* ignore */ }
        }
      }
    } catch {
      // silent
    } finally {
      setGeneratingClipVideo(false)
    }
  }

  return (
    <div
      className="shrink-0 border-l border-[#252533] bg-[#0f0f18] flex flex-col overflow-hidden"
      style={{
        width: expanded ? 520 : 280,
        transition: 'width 180ms cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#252533] shrink-0">
        <span className="text-xs font-semibold text-[var(--text)]">Clip {clipIndex + 1}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleExpand}
            title={expanded ? 'Riduci' : 'Espandi'}
            className="text-[var(--text3)] hover:text-[var(--gold)] transition-colors p-0.5"
          >
            {expanded
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6m-6 0 6-6M9 21H3v-6m6 0-6 6"/></svg>
            }
          </button>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)] transition-colors">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* ── TIPO CLIP ── */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-1.5 uppercase tracking-wider">Tipo clip</label>
          <div className="flex gap-1 p-1 bg-[#0f0f18] rounded-lg border border-[#252533]">
            {CLIP_TYPES.map(opt => {
              const active = clipType === opt.key
              return (
                <button
                  key={opt.key}
                  title={opt.hint}
                  onClick={() => onUpdate({ clipType: opt.key, image: opt.key !== 'img2video' ? null : clip.image })}
                  className={clsx(
                    'flex-1 py-1.5 rounded text-[9px] font-mono border transition-all',
                    active ? opt.colorActive : 'border-transparent text-[#555568] hover:text-[#9090a8]',
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[9px] font-mono text-[#555568]">
            {CLIP_TYPES.find(t => t.key === clipType)?.hint}
          </p>
        </div>

        {/* ── IMMAGINE INIZIALE (img2video only) ── */}
        {clipType === 'img2video' && (
          <div>
            <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">Immagine iniziale</label>
            <div
              onClick={uploading ? undefined : handlePickImage}
              className={clsx(
                'relative h-32 rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden transition-colors group/img',
                uploading ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:border-[var(--gold)]/40',
              )}
            >
              {uploading ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--gold)]">
                  <Loader2 size={22} className="animate-spin" />
                  <span className="text-[10px] font-mono">Upload in corso…</span>
                </div>
              ) : generatingImage ? (
                <div className="flex flex-col items-center justify-center h-full gap-2 bg-[#0f0f18]">
                  <Loader2 size={20} className="animate-spin text-[#c9a84c]" />
                  <div className="w-full px-4">
                    <div className="h-1 bg-[#252533] rounded-full overflow-hidden mb-1.5">
                      <div className="h-full bg-[#c9a84c] transition-all duration-300 rounded-full" style={{ width: `${imageGenProgress}%` }} />
                    </div>
                    <div className="flex justify-between text-[8px] font-mono text-[#9090a8]">
                      <span>{imageGenProgress}%</span>
                      {imgGenStep > 0 && <span>step {imgGenStep}/{imgGenStepMax || imgGenSteps}</span>}
                    </div>
                  </div>
                </div>
              ) : clip.image?.mediaId ? (
                <>
                  <img src={clip.image.previewUrl || mediaPreviewUrl(clip.image)} alt="" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                    <Upload size={18} className="text-white" />
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--text3)]">
                  <Image size={24} />
                  <span className="text-[10px] font-mono text-center px-2">Clicca per caricare immagine</span>
                </div>
              )}
            </div>
            {uploadError && <p className="mt-1 text-[10px] text-[var(--red)] font-mono">{uploadError}</p>}
            {pendingJobs.length > 0 && !generatingImage && !pendingImage && (
              <div className="mt-2 rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/5 p-3 space-y-2">
                <div className="flex items-center gap-1.5">
                  <AlertCircle size={11} className="text-[#f59e0b] shrink-0" />
                  <span className="text-[9px] font-mono text-[#f59e0b] uppercase tracking-wider">Job ComfyUI non completato</span>
                </div>
                {pendingJobs.slice(0, 3).map(job => (
                  <div key={job.job_id} className="flex items-center justify-between gap-2">
                    <p className="text-[8px] font-mono text-[#9090a8] truncate flex-1">{job.width}×{job.height} · {new Date(job.created_at).toLocaleTimeString('it-IT', {hour:'2-digit',minute:'2-digit'})}</p>
                    <button onClick={() => handleRecoverJob(job.job_id)} disabled={recoveringJob}
                      className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[8px] font-mono bg-[#f59e0b]/15 border border-[#f59e0b]/40 text-[#f59e0b] hover:bg-[#f59e0b]/25 disabled:opacity-40 transition-colors">
                      {recoveringJob ? <Loader2 size={8} className="animate-spin" /> : <RefreshCw size={8} />} Recupera
                    </button>
                  </div>
                ))}
                {recoveryError && <p className="text-[8px] font-mono text-[#ef4444]">{recoveryError}</p>}
              </div>
            )}
            {clip.image && !generatingImage && (
              <button onClick={handlePickImage} className="mt-1 w-full text-[10px] font-mono text-[var(--text3)] hover:text-[var(--text2)] py-1 border border-[#252533] rounded transition-colors">
                Cambia immagine
              </button>
            )}
            {/* Genera con AI collapsible */}
            <div className="mt-2">
              <button onClick={() => setGenImageOpen(v => !v)}
                className="flex items-center gap-1.5 text-[10px] font-mono bg-[#c9a84c]/15 border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/25 px-2.5 py-1.5 rounded transition-colors w-full justify-center">
                <Sparkles size={11} /> Genera immagine con AI
              </button>
              {genImageOpen && (
                <div className="mt-2 rounded-lg border border-[#252533] bg-[#16161f] p-3 space-y-2">
                  <label className="block text-[9px] text-[var(--text3)] font-mono uppercase tracking-wider">Workflow txt2img</label>
                  {txt2imgWorkflows.length > 0 ? (
                    <select value={selectedTxt2Img} onChange={e => setSelectedTxt2Img(e.target.value)}
                      className="w-full text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono outline-none">
                      {txt2imgWorkflows.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
                    </select>
                  ) : <p className="text-[10px] font-mono text-[var(--text3)] py-1">Caricamento workflow...</p>}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Risoluzione · {project.aspectRatio}</label>
                      <span className="text-[9px] font-mono text-[#555568]">{imgGenRes.w}×{imgGenRes.h}{imgGenRes.w === project.width * 2 && <span className="ml-1 text-[#c9a84c]">2×</span>}</span>
                    </div>
                    <div className="flex gap-1 flex-wrap">
                      {(IMG_GEN_RESOLUTIONS[project.aspectRatio] ?? IMG_GEN_RESOLUTIONS['16:9']).map(r => (
                        <button key={`${r.w}x${r.h}`} type="button" onClick={() => setImgGenRes(r)}
                          className={clsx('px-2 py-1 rounded text-[9px] font-mono border transition-colors',
                            imgGenRes.w === r.w && imgGenRes.h === r.h ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]' : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]')}>
                          {r.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider shrink-0">Step</label>
                    <div className="flex gap-1">
                      {[10, 15, 20, 25, 30, 40].map(s => (
                        <button key={s} type="button" onClick={() => setImgGenSteps(s)}
                          className={clsx('px-2 py-1 rounded text-[9px] font-mono border transition-colors',
                            imgGenSteps === s ? 'bg-[#c9a84c]/15 border-[#c9a84c]/50 text-[#c9a84c]' : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]')}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-[9px] text-[var(--text3)] font-mono uppercase tracking-wider mb-1">Prompt immagine</label>
                    <textarea value={imgGenPrompt} onChange={e => setImgGenPrompt(e.target.value)} rows={4}
                      placeholder="Descrivi l'immagine da generare per questa clip…"
                      className="w-full text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono resize-none outline-none focus:border-[#c9a84c]/50 placeholder-[var(--text3)]" />
                  </div>
                  <button type="button" onClick={handleEnhanceImgPrompt} disabled={enhancingImgPrompt || !imgGenPrompt.trim()}
                    className="flex items-center gap-1 text-[9px] font-mono text-[#9090a8] hover:text-[#c9a84c] disabled:opacity-40 transition-colors">
                    {enhancingImgPrompt ? <Loader2 size={10} className="animate-spin" /> : <Wand2 size={10} />}
                    {enhancingImgPrompt ? 'Miglioramento…' : 'Migliora con AI'}
                  </button>
                  <button onClick={handleGenerateImage} disabled={generatingImage || !selectedTxt2Img || !imgGenPrompt.trim()}
                    className="flex items-center justify-center gap-1.5 w-full text-[10px] font-mono bg-[#c9a84c]/15 border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/25 px-2.5 py-1.5 rounded transition-colors disabled:opacity-40">
                    {generatingImage ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                    {generatingImage ? `${imageGenProgress}%` : 'Genera immagine'}
                  </button>
                  {pendingImage && !generatingImage && (
                    <div className="mt-2 space-y-2">
                      <div className="relative h-48 rounded-lg overflow-hidden border border-[#c9a84c]/30 cursor-zoom-in group" onClick={() => setLightboxOpen(true)}>
                        <img src={pendingImage.previewUrl || `${BACKEND_ORIGIN}/api/director/projects/${project.id}/images/${pendingImage.name}`}
                          alt="Anteprima generata" className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Maximize2 size={18} className="text-white" />
                        </div>
                        <div className="absolute bottom-1 right-1 bg-black/60 rounded px-1.5 py-0.5 text-[8px] font-mono text-[#c9a84c]">{imgGenRes.w}×{imgGenRes.h}</div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => { onUpdate({ image: { path: pendingImage.path, name: pendingImage.name, mediaId: pendingImage.mediaId ?? null, type: 'image', previewUrl: pendingImage.previewUrl ?? null, generationPrompt: imgGenPrompt } }); setPendingImage(null); setGenImageOpen(false) }}
                          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-mono bg-[#22c55e]/15 border border-[#22c55e]/40 text-[#22c55e] hover:bg-[#22c55e]/25 transition-colors">
                          <Check size={11} /> Approva
                        </button>
                        <button onClick={() => setPendingImage(null)} className="px-3 py-1.5 rounded text-[10px] font-mono border border-[#252533] text-[#555568] hover:text-[#9090a8] transition-colors">Scarta</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── DESCRIZIONE SCENA ── */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">Descrizione scena</label>
          <textarea
            value={clip.sceneDescription || ''}
            onChange={e => onUpdate({ sceneDescription: e.target.value })}
            rows={3}
            placeholder="Cosa succede in questa scena? Chi c'è, dove, quale atmosfera..."
            className="w-full text-[11px] bg-[#1e1e2a] text-[var(--text)] rounded-lg px-3 py-2.5 border border-[#252533] font-mono resize-none outline-none placeholder-[var(--text3)] focus:border-[#32324a] transition-colors"
          />
          <button onClick={handleAiMagic} disabled={aiMagicLoading || !clip.sceneDescription?.trim()}
            className="mt-2 flex items-center gap-1.5 text-[10px] font-mono bg-[#c9a84c]/15 border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/25 px-2.5 py-1.5 rounded transition-colors disabled:opacity-40 w-full justify-center">
            {aiMagicLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {aiMagicLoading ? 'Generazione...' : 'Genera prompt clip'}
          </button>
        </div>

        {/* ── PROMPT (etichetta contestuale) ── */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">
            {clipType === 'txt2img' ? 'Prompt immagine' : clipType === 'img2video' ? 'Prompt motion' : 'Prompt video'}
          </label>
          <div className={clsx(
            'rounded-lg border transition-all',
            enhancing ? 'border-[var(--gold)]/60 shadow-[0_0_0_1px_rgba(201,168,76,0.2)] animate-pulse' : 'border-[#252533] focus-within:border-[#32324a]'
          )}>
            <textarea
              value={clip.prompt}
              onChange={e => onUpdate({ prompt: e.target.value })}
              disabled={enhancing}
              rows={clipType === 'txt2img' ? 6 : 5}
              placeholder={
                clipType === 'txt2img'   ? 'Descrivi visivamente l\'immagine da generare, stile, luce, composizione...' :
                clipType === 'img2video' ? 'Descrivi il movimento della camera e del soggetto...' :
                'Descrivi la scena visiva e i movimenti per generare il video...'
              }
              className="w-full text-[11px] bg-transparent text-[var(--text)] px-3 py-2.5 font-mono resize-none outline-none rounded-lg placeholder-[var(--text3)] disabled:opacity-60"
            />
          </div>
          <button onClick={handleEnhance} disabled={enhancing || !clip.prompt.trim()}
            className="mt-2 flex items-center gap-1.5 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors">
            {enhancing ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            {enhancing ? 'Miglioramento...' : 'Migliora con AI'}
          </button>
        </div>

        {/* ── GENERAZIONE IMMAGINE (txt2img: workflow + res + steps + genera) ── */}
        {clipType === 'txt2img' && (
          <div className="rounded-lg border border-[#a78bfa]/30 bg-[#a78bfa]/5 p-3 space-y-3">
            <div className="flex items-center gap-1.5 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[#a78bfa] shrink-0" />
              <span className="text-[9px] font-mono text-[#a78bfa] uppercase tracking-wider">Genera immagine</span>
            </div>
            <div>
              <label className="block text-[9px] text-[var(--text3)] font-mono uppercase tracking-wider mb-1">Workflow txt2img</label>
              {txt2imgWorkflows.length > 0 ? (
                <select value={selectedTxt2Img} onChange={e => setSelectedTxt2Img(e.target.value)}
                  className="w-full text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono outline-none">
                  {txt2imgWorkflows.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
                </select>
              ) : <p className="text-[10px] font-mono text-[var(--text3)]">Caricamento workflow...</p>}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Risoluzione · {project.aspectRatio}</label>
                <span className="text-[9px] font-mono text-[#555568]">{imgGenRes.w}×{imgGenRes.h}</span>
              </div>
              <div className="flex gap-1 flex-wrap">
                {(IMG_GEN_RESOLUTIONS[project.aspectRatio] ?? IMG_GEN_RESOLUTIONS['16:9']).map(r => (
                  <button key={`${r.w}x${r.h}`} type="button" onClick={() => setImgGenRes(r)}
                    className={clsx('px-2 py-1 rounded text-[9px] font-mono border transition-colors',
                      imgGenRes.w === r.w && imgGenRes.h === r.h
                        ? 'bg-[#a78bfa]/15 border-[#a78bfa]/50 text-[#a78bfa]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]')}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider shrink-0">Step</label>
              <div className="flex gap-1">
                {[10, 15, 20, 25, 30, 40].map(s => (
                  <button key={s} type="button" onClick={() => setImgGenSteps(s)}
                    className={clsx('px-2 py-1 rounded text-[9px] font-mono border transition-colors',
                      imgGenSteps === s
                        ? 'bg-[#a78bfa]/15 border-[#a78bfa]/50 text-[#a78bfa]'
                        : 'border-[#252533] text-[#555568] hover:border-[#32324a] hover:text-[#9090a8]')}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {generatingImage && (
              <div>
                <div className="h-1 bg-[#252533] rounded-full overflow-hidden mb-1">
                  <div className="h-full bg-[#a78bfa] transition-all duration-300 rounded-full" style={{ width: `${imageGenProgress}%` }} />
                </div>
                <div className="flex justify-between text-[8px] font-mono text-[#9090a8]">
                  <span>{imageGenProgress}%</span>
                  {imgGenStep > 0 && <span>step {imgGenStep}/{imgGenStepMax || imgGenSteps}</span>}
                </div>
              </div>
            )}
            <button onClick={() => { setImgGenPrompt(clip.prompt || clip.sceneDescription || ''); handleGenerateImage() }}
              disabled={generatingImage || !selectedTxt2Img || (!clip.prompt.trim() && !clip.sceneDescription?.trim())}
              className="flex items-center justify-center gap-1.5 w-full text-[10px] font-mono bg-[#a78bfa]/15 border border-[#a78bfa]/40 text-[#a78bfa] hover:bg-[#a78bfa]/25 px-2.5 py-1.5 rounded transition-colors disabled:opacity-40">
              {generatingImage ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
              {generatingImage ? `Generazione ${imageGenProgress}%...` : 'Genera immagine'}
            </button>
            {pendingImage && !generatingImage && (
              <div className="space-y-2">
                <div className="relative h-40 rounded-lg overflow-hidden border border-[#a78bfa]/30 cursor-zoom-in group" onClick={() => setLightboxOpen(true)}>
                  <img src={pendingImage.previewUrl || `${BACKEND_ORIGIN}/api/director/projects/${project.id}/images/${pendingImage.name}`}
                    alt="Anteprima" className="w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <Maximize2 size={18} className="text-white" />
                  </div>
                  <div className="absolute bottom-1 right-1 bg-black/60 rounded px-1.5 py-0.5 text-[8px] font-mono text-[#a78bfa]">{imgGenRes.w}×{imgGenRes.h}</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { onUpdate({ image: { path: pendingImage.path, name: pendingImage.name, mediaId: pendingImage.mediaId ?? null, type: 'image', previewUrl: pendingImage.previewUrl ?? null, generationPrompt: clip.prompt } }); setPendingImage(null) }}
                    className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[10px] font-mono bg-[#22c55e]/15 border border-[#22c55e]/40 text-[#22c55e] hover:bg-[#22c55e]/25 transition-colors">
                    <Check size={11} /> Salva come immagine clip
                  </button>
                  <button onClick={() => setPendingImage(null)} className="px-3 py-1.5 rounded text-[10px] font-mono border border-[#252533] text-[#555568] hover:text-[#9090a8] transition-colors">Scarta</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── DURATA ── */}
        <div>
          <label className="block text-[10px] text-[var(--text3)] font-mono mb-2 uppercase tracking-wider">
            Durata{clipType === 'txt2img' ? ' (immagine statica)' : ''}
          </label>
          <div className="flex items-center gap-2 mb-2">
            <input type="number" min={1} max={30} step={1} value={clip.duration}
              onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) onUpdate({ duration: Math.min(30, Math.max(1, v)) }) }}
              className="w-20 text-[11px] bg-[#1e1e2a] text-[var(--text)] rounded border border-[#252533] px-2 py-1.5 font-mono outline-none focus:border-[#32324a]" />
            <span className="text-[11px] text-[var(--text3)] font-mono">s</span>
          </div>
          <input type="range" min={1} max={30} step={1} value={clip.duration}
            onChange={e => onUpdate({ duration: parseInt(e.target.value, 10) })}
            className="w-full accent-[#c9a84c] h-1" />
          <div className="flex justify-between text-[9px] text-[var(--text3)] font-mono mt-1"><span>1s</span><span>30s</span></div>
        </div>

        {/* ── GENERA VIDEO CLIP (img2video + txt2video only) ── */}
        {(clipType === 'img2video' || clipType === 'txt2video') && (
          <div className={clsx(
            'border-t pt-4',
            clipType === 'img2video' ? 'border-[#f59e0b]/20' : 'border-[#3b82f6]/20',
          )}>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[10px] font-mono text-[var(--text3)] uppercase tracking-wider">Genera video clip</label>
              <span className={clsx(
                'text-[8px] font-mono px-1.5 py-0.5 rounded',
                clipType === 'img2video'
                  ? 'bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/30'
                  : 'bg-[#3b82f6]/10 text-[#3b82f6] border border-[#3b82f6]/30',
              )}>
                {clip.image && project.audio?.path ? 'img+audio→video' : clipType === 'img2video' ? 'img→video' : 'txt→video'}
              </span>
            </div>
            {clipType === 'img2video' && !clip.image && (
              <p className="text-[9px] font-mono text-[#f59e0b] mb-2">⚠ Carica o genera un'immagine prima di procedere</p>
            )}
            {clipVideoWorkflows.length > 0 && (
              <select value={clipVideoWorkflow} onChange={e => setClipVideoWorkflow(e.target.value)}
                className="w-full text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono outline-none mb-2">
                {clipVideoWorkflows.map(wf => <option key={wf.id} value={wf.id}>{wf.name}</option>)}
              </select>
            )}
            {generatingClipVideo && (
              <div className="mb-2">
                <div className="h-1 bg-[#252533] rounded-full overflow-hidden mb-1">
                  <div className={clsx('h-full transition-all duration-300 rounded-full', clipType === 'img2video' ? 'bg-[#f59e0b]' : 'bg-[#3b82f6]')}
                    style={{ width: `${clipVideoProgress}%` }} />
                </div>
                <span className="text-[8px] font-mono text-[#9090a8]">{clipVideoProgress}%</span>
              </div>
            )}
            {clipVideoDone && <p className="text-[9px] font-mono text-[#22c55e] mb-2 flex items-center gap-1"><Check size={10} /> Video clip generato</p>}
            <button onClick={handleGenerateClipVideo}
              disabled={generatingClipVideo || !clipVideoWorkflow || (clipType === 'img2video' && !clip.image)}
              className={clsx(
                'flex items-center justify-center gap-1.5 w-full py-2 rounded text-[10px] font-mono border disabled:opacity-40 transition-colors',
                clipType === 'img2video'
                  ? 'bg-[#f59e0b]/15 border-[#f59e0b]/40 text-[#f59e0b] hover:bg-[#f59e0b]/25'
                  : 'bg-[#3b82f6]/15 border-[#3b82f6]/40 text-[#3b82f6] hover:bg-[#3b82f6]/25',
              )}>
              {generatingClipVideo
                ? <><Loader2 size={10} className="animate-spin" />{clipVideoProgress}%</>
                : <><Film size={10} />Genera video</>}
            </button>
          </div>
        )}

      </div>

      <div className="p-4 border-t border-[#252533] shrink-0">
        <button
          onClick={() => onDelete(clip.id)}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-[var(--red)]/30 text-[var(--red)] text-[11px] font-mono hover:bg-[var(--red)]/10 transition-colors"
        >
          <Trash2 size={13} />
          Elimina clip
        </button>
      </div>

      {lightboxOpen && pendingImage && (
        <ImageLightbox
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          items={[{
            src: pendingImage.previewUrl || `${BACKEND_ORIGIN}/api/director/projects/${project.id}/images/${pendingImage.name}`,
            alt: `Clip ${clipIndex + 1} — immagine generata`,
          }]}
        />
      )}
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
      {generating && (
        <div className="h-0.5 w-full bg-[#252533]">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${genProgress}%`, background: 'var(--gold)' }}
          />
        </div>
      )}

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

      {genError && !generating && (
        <div className="flex items-center gap-3 px-4 py-2 bg-red-900/20 border-b border-red-500/20">
          <AlertCircle size={14} className="text-red-400 shrink-0" />
          <span className="text-[11px] text-red-400 font-mono flex-1 truncate">{genError}</span>
          <button onClick={onDismissError} className="text-[var(--text3)] hover:text-[var(--text)]">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-4 px-4" style={{ height: 56 }}>
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

        {/* Info automatica modalità per clip */}
        <div className="flex gap-2 flex-1 justify-center items-center">
          {(() => {
            const hasAudio = Boolean(project.audio?.path)
            const withImg  = project.clips.filter(c => c.image).length
            const noImg    = project.clips.length - withImg
            return (
              <>
                {withImg > 0 && (
                  <span className="text-[9px] font-mono px-2 py-1 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">
                    {withImg} {hasAudio ? 'img+audio→video' : 'img→video'}
                  </span>
                )}
                {noImg > 0 && (
                  <span className="text-[9px] font-mono px-2 py-1 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400">
                    {noImg} testo→video
                  </span>
                )}
                {hasAudio && (
                  <span className="text-[9px] font-mono px-2 py-1 rounded border border-[#22c55e]/30 bg-[#22c55e]/10 text-[#22c55e]">
                    🎵 audio
                  </span>
                )}
              </>
            )
          })()}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <select
            value={project.fps}
            onChange={e => onUpdateProject({ fps: parseInt(e.target.value) })}
            className="text-[10px] bg-[#1e1e2a] text-[var(--text)] rounded px-1.5 py-1.5 border border-[#252533] font-mono outline-none"
          >
            {FPS_OPTIONS.map(f => <option key={f} value={f}>{f}fps</option>)}
          </select>

          <span className="text-[10px] font-mono text-[var(--text3)]">{project.width}x{project.height}</span>

          <button
            onClick={handleEnhanceGlobal}
            disabled={enhancingGlobal || !project.globalPrompt.trim()}
            className="flex items-center gap-1 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
          >
            {enhancingGlobal ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />}
            Migliora Globale
          </button>

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

      {generating && genMsg && (
        <div className="px-4 pb-2">
          <span className="text-[9px] font-mono text-[var(--text3)]">{genMsg}</span>
        </div>
      )}
    </div>
  )
}

// ── Transition Handle ────────────────────────────────────────────────────────

function TransitionHandle({ clip, prevClip, onSetTransition }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef(null)
  const trans  = TRANSITIONS[clip.transition] || TRANSITIONS.cut
  const hasAnim = trans.id !== 'cut'

  // Immagini sorgente per anteprima WebGL nel picker
  const fromSrc = prevClip?.image?.previewUrl || null
  const toSrc   = clip?.image?.previewUrl || null

  return (
    <div className="relative flex items-center shrink-0" style={{ height: '100%' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        title={trans.label}
        className={clsx(
          'flex items-center justify-center rounded transition-all h-full',
          hasAnim
            ? 'w-8 bg-[#c9a84c]/15 border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/25'
            : 'w-4 bg-[#1e1e2a] border border-[#252533] text-[#555568] hover:border-[#c9a84c]/30 hover:text-[#c9a84c]',
        )}
      >
        <span className="text-[10px] leading-none">{trans.icon || '◇'}</span>
      </button>

      {open && (
        <TransitionPicker
          value={clip.transition || 'cut'}
          onChange={onSetTransition}
          onClose={() => setOpen(false)}
          anchorRef={btnRef}
          fromSrc={fromSrc}
          toSrc={toSrc}
        />
      )}
    </div>
  )
}

// ── VIEW 3: Workspace ──────────────────────────────────────────────────────────

function WorkspaceView({ project, onBack, onUpdateProject }) {
  const [selectedClipId, setSelectedClipId]   = useState(null)
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
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

  const selectedClip      = project.clips.find(c => c.id === selectedClipId) ?? null
  const selectedClipIndex = project.clips.findIndex(c => c.id === selectedClipId)

  const totalClipsDuration = project.clips.reduce((s, c) => s + c.duration, 0)
  const timelineWidth      = Math.max(totalClipsDuration * PX_PER_SEC + 200, 600)

  function addClip() {
    const defaultType = project.mode === 'img2video' ? 'img2video' : 'txt2video'
    const clip = {
      id:               genId(),
      clipType:         defaultType,
      prompt:           '',
      duration:         4,
      image:            null,
      sceneDescription: '',
      transition:       DEFAULT_TRANSITION,
    }
    onUpdateProject({ clips: [...project.clips, clip] })
    setSelectedClipId(clip.id)
  }

  function deleteClip(id) {
    if (selectedClipId === id) { setSelectedClipId(null); setSidebarExpanded(false) }
    onUpdateProject({ clips: project.clips.filter(c => c.id !== id) })
  }

  function resizeClip(id, duration) {
    onUpdateProject({ clips: project.clips.map(c => c.id === id ? { ...c, duration } : c) })
  }

  function updateClip(id, patch) {
    onUpdateProject({ clips: project.clips.map(c => c.id === id ? { ...c, ...patch } : c) })
  }

  function setClipTransition(clipId, transId) {
    onUpdateProject({ clips: project.clips.map(c => c.id === clipId ? { ...c, transition: transId } : c) })
  }

  async function handleAddAudio() {
    const picked = await director.pickAudio()
    if (!picked?.path) return
    try {
      const uploaded = await uploadToMediaLibrary(picked.path, picked.name, 'director-cinema,audio')
      onUpdateProject({ audio: { ...uploaded, audioOffsetSec: 0 } })
    } catch (e) {
      setGenError(e.message || 'Upload audio fallito')
    }
  }

  function handleRemoveAudio() {
    onUpdateProject({ audio: null })
  }

  function handleAudioOffsetChange(offsetSec) {
    if (!project.audio) return
    onUpdateProject({ audio: { ...project.audio, audioOffsetSec: offsetSec } })
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

  async function handleGenerate() {
    setGenerating(true)
    setGenProgress(0)
    setGenMsg('')
    setGenResult(null)
    setGenError(null)
    setDirectorJobId(null)

    const hasAudio   = Boolean(project.audio?.path)
    const audioOffset = project.audio?.audioOffsetSec ?? 0

    // Calcola start time di ogni clip sulla timeline
    let clipCursor = 0
    const clipsWithAudio = project.clips.map(c => {
      const startSec = clipCursor
      clipCursor += c.duration || 3
      const hasImg = Boolean(c.image?.path)
      const mode = hasAudio && hasImg ? 'img_audio2video' : hasImg ? 'img2video' : 'txt2video'
      return {
        id:             c.id,
        prompt:         c.prompt,
        duration_sec:   c.duration,
        image_path:     c.image?.path ?? null,
        mode,
        audio_start_sec: hasAudio ? audioOffset + startSec : 0,
      }
    })

    const params = {
      workflow_id:   project.workflowId,
      mode:          clipsWithAudio.every(c => c.mode === 'txt2video') ? 'txt2video' : 'img2video',
      global_prompt: project.globalPrompt,
      clips:         clipsWithAudio,
      audio_path:    project.audio?.path ?? null,
      audio_offset_sec: audioOffset,
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
      <div
        className="flex items-center gap-3 px-4 shrink-0 border-b border-[#252533]"
        style={{ height: 48, background: 'var(--bg1)' }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--text3)] hover:text-[var(--text)] transition-colors"
        >
          <ArrowLeft size={14} />
          Indietro
        </button>

        <div className="w-px h-5 bg-[#252533]" />

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

        <div className="flex-1" />

        <Badge color={project.mode === 'img2video' ? 'amber' : 'blue'}>
          {project.mode}
        </Badge>
        <Badge color="dim">{project.width}x{project.height}</Badge>
        <Badge color="dim">{project.fps}fps</Badge>
        <Badge color="dim">{project.clips.length} clip{project.clips.length !== 1 ? 's' : ''}</Badge>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
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

          <div className="flex-1 overflow-x-auto overflow-y-hidden" style={{ background: 'var(--bg0)' }}>
            <div style={{ width: timelineWidth, minHeight: '100%', position: 'relative', padding: '16px' }}>
              <div className="flex items-center gap-1 mb-2">
                <Film size={10} className="text-[var(--text3)]" />
                <span className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Clips</span>
                <span className="text-[9px] font-mono text-[var(--text3)] ml-2">{totalClipsDuration.toFixed(0)}s total</span>
              </div>

              <div
                className="flex gap-0.5 mb-4 relative"
                style={{ height: 120 }}
              >
                {project.clips.map((clip, i) => (
                  <React.Fragment key={clip.id}>
                    {i > 0 && (
                      <TransitionHandle
                        clip={clip}
                        prevClip={project.clips[i - 1]}
                        onSetTransition={(transId) => setClipTransition(clip.id, transId)}
                      />
                    )}
                    <ClipCard
                      clip={clip}
                      index={i}
                      mode={project.mode}
                      isSelected={selectedClipId === clip.id}
                      onSelect={setSelectedClipId}
                      onDelete={deleteClip}
                      onResize={resizeClip}
                    />
                  </React.Fragment>
                ))}

                <button
                  onClick={addClip}
                  className="flex-shrink-0 flex flex-col items-center justify-center gap-1 border border-dashed border-[#252533] rounded hover:border-[var(--gold)]/40 hover:bg-[var(--gold)]/5 transition-all text-[var(--text3)] hover:text-[var(--gold)]"
                  style={{ width: 80, height: '100%' }}
                >
                  <Plus size={16} />
                  <span className="text-[8px] font-mono">Clip</span>
                </button>
              </div>

              <div className="flex items-center gap-1 mb-1.5">
                <Music size={10} className="text-[var(--text3)]" />
                <span className="text-[9px] font-mono text-[var(--text3)] uppercase tracking-wider">Audio</span>
              </div>

              <div style={{ height: 40 }}>
                <AudioTrack
                  audio={project.audio}
                  totalWidth={totalClipsDuration * PX_PER_SEC}
                  onAdd={handleAddAudio}
                  onRemove={handleRemoveAudio}
                  onOffsetChange={handleAudioOffsetChange}
                />
              </div>

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

        {selectedClip && (
          <ClipEditorSidebar
            clip={selectedClip}
            clipIndex={selectedClipIndex}
            mode={project.mode}
            project={project}
            expanded={sidebarExpanded}
            onToggleExpand={() => setSidebarExpanded(v => !v)}
            onUpdate={patch => updateClip(selectedClip.id, patch)}
            onDelete={id => { deleteClip(id); setSelectedClipId(null); setSidebarExpanded(false) }}
            onClose={() => { setSelectedClipId(null); setSidebarExpanded(false) }}
          />
        )}
      </div>

      {/* Timeline preview player */}
      {project.clips.length > 0 && (
        <div className="px-4 pb-3 shrink-0">
          <TimelinePreview clips={project.clips} project={project} />
        </div>
      )}

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
    fetch(`${API}/director/projects/${encodeURIComponent(id)}?cleanup=true`, { method: 'DELETE' })
      .catch(() => {})
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
