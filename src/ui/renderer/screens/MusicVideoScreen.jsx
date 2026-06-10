import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Music2, Upload, Plus, X, ChevronUp, ChevronDown, Film, Loader2,
  Check, Sparkles, RefreshCw, Settings2, AlertCircle, Play,
  Trash2, Clock, FileText, Wand2, RotateCcw, StopCircle, Mic,
} from 'lucide-react'
import clsx from 'clsx'
import { BACKEND_ORIGIN } from '../utils/mediaUrl'

// ─── helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60) return `${diff}s fa`
  if (diff < 3600) return `${Math.floor(diff / 60)}m fa`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h fa`
  return `${Math.floor(diff / 86400)}g fa`
}

function secsToTimecode(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function mmssToSecs(str) {
  const parts = str.split(':')
  if (parts.length !== 2) return 0
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)
}

function scenesToSrt(scenes) {
  return scenes
    .map((sc, i) => {
      const startMs = mmssToSecs(sc.start) * 1000
      const endMs = mmssToSecs(sc.end) * 1000
      const fmt = ms => {
        const h = Math.floor(ms / 3600000)
        const m = Math.floor((ms % 3600000) / 60000)
        const s = Math.floor((ms % 60000) / 1000)
        const cs = Math.floor((ms % 1000) / 10)
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(cs).padStart(3,'0')}`
      }
      return `${i + 1}\n${fmt(startMs)} --> ${fmt(endMs)}\n${sc.desc.trim()}`
    })
    .join('\n\n')
}

function parseSrt(raw) {
  const blocks = raw.trim().split(/\n\n+/)
  const results = []
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 3) continue
    const timeLine = lines[1]
    const m = timeLine.match(/(\d+:\d+:\d+[,.]?\d*)\s*-->\s*(\d+:\d+:\d+[,.]?\d*)/)
    if (!m) continue
    const toMmss = raw => {
      const parts = raw.replace(',', '.').split(':')
      const h = parseInt(parts[0], 10)
      const min = parseInt(parts[1], 10)
      const sec = Math.floor(parseFloat(parts[2]))
      return `${String(h * 60 + min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    }
    results.push({ start: toMmss(m[1]), end: toMmss(m[2]), desc: lines.slice(2).join('\n') })
  }
  return results
}

function randSeed() {
  return Math.floor(Math.random() * 2 ** 31)
}

// ─── constants ───────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'music', label: 'MUSICA' },
  { id: 'scenes', label: 'SCENE' },
  { id: 'story', label: 'STORIA' },
  { id: 'settings', label: 'IMPOSTAZIONI' },
]

const RESOLUTIONS = [
  { label: '1920 × 1080', w: 1920, h: 1080, ratio: '16:9' },
  { label: '1280 × 720', w: 1280, h: 720, ratio: '16:9' },
  { label: '3840 × 2160', w: 3840, h: 2160, ratio: '4K' },
  { label: '1080 × 1920', w: 1080, h: 1920, ratio: '9:16' },
  { label: '720 × 1280', w: 720, h: 1280, ratio: '9:16' },
  { label: '1080 × 1080', w: 1080, h: 1080, ratio: '1:1' },
]

const SSE_STAGE_ORDER = ['upload', 'reference_frame', 'scene', 'assembly', 'done']

const JOB_STATUS_STYLES = {
  done: 'bg-green-500/10 text-green-400 border-green-500/30',
  generating: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  error: 'bg-red-500/10 text-red-400 border-red-500/30',
  pending: 'bg-[#9090a8]/10 text-[#9090a8] border-[#9090a8]/30',
}

const JOB_STATUS_LABELS = {
  done: '✓ Completato',
  generating: '⏳ Generazione',
  error: '✗ Errore',
  pending: '● In attesa',
}

// ─── sub-components ──────────────────────────────────────────────────────────

function StepIndicator({ current }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {STEPS.map((step, idx) => {
        const done = idx < current
        const active = idx === current
        return (
          <div key={step.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  border: done || active ? '2px solid #c9a84c' : '2px solid #252533',
                  background: done ? '#c9a84c' : active ? 'transparent' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  boxShadow: active ? '0 0 12px #c9a84c55' : 'none',
                  transition: 'all 0.2s',
                }}
              >
                {done ? (
                  <Check size={14} color="#07070d" strokeWidth={2.5} />
                ) : (
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: active ? '#c9a84c' : '#252533',
                    }}
                  />
                )}
              </div>
              {idx < STEPS.length - 1 && (
                <div
                  style={{
                    width: 2,
                    height: 32,
                    background: done ? '#c9a84c44' : '#252533',
                    margin: '4px 0',
                  }}
                />
              )}
            </div>
            <div style={{ paddingTop: 4 }}>
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 2,
                  color: done ? '#c9a84c' : active ? '#e8e4dd' : '#555568',
                }}
              >
                {step.label}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AudioDropzone({ audioInfo, uploading, onFile }) {
  const inputRef = useRef()
  const [dragging, setDragging] = useState(false)

  const handleDrop = useCallback(e => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }, [onFile])

  if (audioInfo) {
    return (
      <div
        style={{
          background: '#0f0f18',
          border: '1px solid #c9a84c44',
          borderRadius: 10,
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 8,
            background: '#c9a84c22',
            border: '1px solid #c9a84c44',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Music2 size={20} color="#c9a84c" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              color: '#e8e4dd',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {audioInfo.audio_name}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 16,
              marginTop: 4,
            }}
          >
            {audioInfo.duration_sec != null && (
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8' }}>
                {secsToTimecode(audioInfo.duration_sec)}
              </span>
            )}
            {audioInfo.bpm != null && (
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#c9a84c' }}>
                {Math.round(audioInfo.bpm)} BPM
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => inputRef.current?.click()}
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: '#9090a8',
            background: 'none',
            border: '1px solid #252533',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          Cambia
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,.wav,.ogg,.flac,.m4a"
          style={{ display: 'none' }}
          onChange={e => e.target.files[0] && onFile(e.target.files[0])}
        />
      </div>
    )
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      style={{
        border: `2px dashed ${dragging ? '#c9a84c' : '#252533'}`,
        borderRadius: 12,
        padding: '40px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        cursor: uploading ? 'not-allowed' : 'pointer',
        background: dragging ? '#c9a84c08' : '#0f0f18',
        transition: 'all 0.2s',
      }}
    >
      {uploading ? (
        <Loader2 size={32} color="#c9a84c" style={{ animation: 'spin 1s linear infinite' }} />
      ) : (
        <Music2 size={32} color={dragging ? '#c9a84c' : '#555568'} />
      )}
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontFamily: 'Playfair Display, serif',
            fontSize: 15,
            color: dragging ? '#c9a84c' : '#9090a8',
          }}
        >
          {uploading ? 'Caricamento in corso…' : 'Trascina qui il file audio o clicca per sfogliare'}
        </div>
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: '#555568',
            marginTop: 4,
          }}
        >
          MP3 · WAV · OGG · FLAC · M4A
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.ogg,.flac,.m4a"
        style={{ display: 'none' }}
        onChange={e => e.target.files[0] && onFile(e.target.files[0])}
      />
    </div>
  )
}

function SceneRow({ scene, index, total, onChange, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '10px 12px',
        background: '#0f0f18',
        border: '1px solid #252533',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
        <button
          disabled={index === 0}
          onClick={onMoveUp}
          style={{
            background: 'none',
            border: 'none',
            color: index === 0 ? '#252533' : '#555568',
            cursor: index === 0 ? 'default' : 'pointer',
            padding: 2,
            borderRadius: 4,
            lineHeight: 1,
          }}
        >
          <ChevronUp size={14} />
        </button>
        <button
          disabled={index === total - 1}
          onClick={onMoveDown}
          style={{
            background: 'none',
            border: 'none',
            color: index === total - 1 ? '#252533' : '#555568',
            cursor: index === total - 1 ? 'default' : 'pointer',
            padding: 2,
            borderRadius: 4,
            lineHeight: 1,
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: '#c9a84c',
          background: '#c9a84c11',
          border: '1px solid #c9a84c22',
          borderRadius: 4,
          padding: '2px 6px',
          flexShrink: 0,
          alignSelf: 'flex-start',
          marginTop: 6,
        }}
      >
        {index + 1}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <input
          type="text"
          value={scene.start}
          onChange={e => onChange({ start: e.target.value })}
          placeholder="00:00"
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            width: 48,
            background: '#16161f',
            border: '1px solid #252533',
            borderRadius: 5,
            color: '#e8e4dd',
            padding: '4px 6px',
            textAlign: 'center',
          }}
        />
        <span style={{ color: '#555568', fontSize: 12 }}>→</span>
        <input
          type="text"
          value={scene.end}
          onChange={e => onChange({ end: e.target.value })}
          placeholder="00:08"
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            width: 48,
            background: '#16161f',
            border: '1px solid #252533',
            borderRadius: 5,
            color: '#e8e4dd',
            padding: '4px 6px',
            textAlign: 'center',
          }}
        />
      </div>

      <textarea
        value={scene.desc}
        onChange={e => onChange({ desc: e.target.value })}
        placeholder="Descrivi la scena visiva…"
        rows={2}
        style={{
          flex: 1,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          background: '#16161f',
          border: '1px solid #252533',
          borderRadius: 6,
          color: '#e8e4dd',
          padding: '6px 8px',
          resize: 'vertical',
          lineHeight: 1.5,
        }}
      />

      <button
        onClick={onRemove}
        style={{
          background: 'none',
          border: 'none',
          color: '#555568',
          cursor: 'pointer',
          padding: 4,
          borderRadius: 4,
          alignSelf: 'flex-start',
          marginTop: 4,
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}

function SrtPreviewPanel({ scenes }) {
  if (!scenes.length) return null
  const srt = scenesToSrt(scenes)
  return (
    <div
      style={{
        background: '#07070d',
        border: '1px solid #252533',
        borderRadius: 8,
        padding: 12,
        maxHeight: 180,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: '#555568',
          marginBottom: 6,
          letterSpacing: 1,
        }}
      >
        ANTEPRIMA SRT
      </div>
      <pre
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: '#9090a8',
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {srt}
      </pre>
    </div>
  )
}

function ProgressStageRow({ label, status, progress, detail }) {
  const colors = {
    done: '#22c55e',
    active: '#c9a84c',
    pending: '#252533',
    error: '#ef4444',
  }
  const color = colors[status] || colors.pending
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          boxShadow: status === 'active' ? `0 0 8px ${color}` : 'none',
        }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              color: status === 'pending' ? '#555568' : '#e8e4dd',
            }}
          >
            {label}
          </span>
          {progress != null && status === 'active' && (
            <span
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                color: '#c9a84c',
              }}
            >
              {progress}%
            </span>
          )}
          {status === 'done' && (
            <Check size={12} color="#22c55e" />
          )}
        </div>
        {status === 'active' && progress != null && (
          <div
            style={{
              height: 2,
              background: '#1e1e2a',
              borderRadius: 2,
            }}
          >
            <div
              style={{
                height: 2,
                background: '#c9a84c',
                borderRadius: 2,
                width: `${progress}%`,
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        )}
        {detail && (
          <div
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: '#9090a8',
              marginTop: 2,
            }}
          >
            {detail}
          </div>
        )}
      </div>
    </div>
  )
}

function JobCard({ job, onDelete }) {
  const status = job.status || 'pending'
  const statusCls = JOB_STATUS_STYLES[status] || JOB_STATUS_STYLES.pending
  const statusLabel = JOB_STATUS_LABELS[status] || status

  return (
    <div
      style={{
        background: '#0f0f18',
        border: '1px solid #252533',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'Playfair Display, serif',
              fontSize: 15,
              color: '#e8e4dd',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.title || job.job_id}
          </div>
          <div
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: '#555568',
              marginTop: 3,
            }}
          >
            {timeAgo(job.created_at)}
            {job.duration_sec ? ` · ${secsToTimecode(job.duration_sec)}` : ''}
          </div>
        </div>
        <span
          className={`text-[9px] px-1.5 py-0.5 rounded-full border ${statusCls}`}
          style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          {statusLabel}
        </span>
      </div>

      {job.video_url && (
        <div style={{ aspectRatio: '16/9', borderRadius: 8, overflow: 'hidden', background: '#07070d' }}>
          <video
            src={job.video_url}
            controls
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => onDelete(job)}
          style={{
            marginLeft: 'auto',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: '#ef4444',
            background: 'none',
            border: '1px solid #ef444422',
            borderRadius: 6,
            padding: '4px 10px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Trash2 size={12} />
          Elimina
        </button>
      </div>
    </div>
  )
}

// ─── main screen ────────────────────────────────────────────────────────────

export default function MusicVideoScreen() {
  const [view, setView] = useState('list') // 'list' | 'wizard' | 'progress'
  const [step, setStep] = useState(0)
  const [jobs, setJobs] = useState([])
  const [jobsLoading, setJobsLoading] = useState(false)

  // wizard state
  const [title, setTitle] = useState('')
  const [audioInfo, setAudioInfo] = useState(null)
  const [uploadingAudio, setUploadingAudio] = useState(false)
  const [audioError, setAudioError] = useState(null)
  const [analyzingAudio, setAnalyzingAudio] = useState(false)
  const [analyzeError, setAnalyzeError] = useState(null)

  const [lyrics, setLyrics] = useState('')

  const [sceneTab, setSceneTab] = useState('builder') // 'builder' | 'ai' | 'upload' | 'transcribe'

  // transcription state
  const [transcribeModelSize, setTranscribeModelSize] = useState('base')
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeError, setTranscribeError] = useState(null)
  const [transcribeWords, setTranscribeWords] = useState([])
  const [transcribeSrt, setTranscribeSrt] = useState('')

  // story fields AI generation
  const [generatingSubjects, setGeneratingSubjects] = useState(false)
  const [generatingStyle, setGeneratingStyle] = useState(false)
  const [generatingRefPrompt, setGeneratingRefPrompt] = useState(false)
  const [scenes, setScenes] = useState([{ start: '00:00', end: '00:08', desc: '' }])
  const [aiConcept, setAiConcept] = useState('')
  const [aiNumScenes, setAiNumScenes] = useState(8)
  const [aiStyleHint, setAiStyleHint] = useState('')
  const [generatingSrt, setGeneratingSrt] = useState(false)
  const [srtError, setSrtError] = useState(null)
  const [srtUploadDragging, setSrtUploadDragging] = useState(false)

  const [subjectsText, setSubjectsText] = useState('')
  const [subjectsError, setSubjectsError] = useState(null)
  const [styleText, setStyleText] = useState('')
  const [styleError, setStyleError] = useState(null)
  const [referencePrompt, setReferencePrompt] = useState('')
  const [refPromptError, setRefPromptError] = useState(null)
  const [negativePrompt, setNegativePrompt] = useState('bad hands, extra fingers, distorted face, blurry, watermark')

  const [resolution, setResolution] = useState(RESOLUTIONS[0])
  const [fps, setFps] = useState(24)
  const [seed, setSeed] = useState(randSeed())
  const [sceneDuration, setSceneDuration] = useState(0)
  const [crf, setCrf] = useState(19)

  // progress state
  const [progressStages, setProgressStages] = useState([])
  const [overallProgress, setOverallProgress] = useState(0)
  const [progressLogs, setProgressLogs] = useState([])
  const [progressError, setProgressError] = useState(null)
  const [generating, setGenerating] = useState(false)
  const [doneVideoUrl, setDoneVideoUrl] = useState(null)
  const abortRef = useRef(null)

  const srtInputRef = useRef()

  const loadJobs = useCallback(async () => {
    setJobsLoading(true)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/jobs?project_id=music_video`)
      if (res.ok) {
        const data = await res.json()
        setJobs(data.jobs || data || [])
      }
    } catch {}
    setJobsLoading(false)
  }, [])

  useEffect(() => {
    if (view === 'list') loadJobs()
  }, [view, loadJobs])

  // ── audio ──────────────────────────────────────────────────────────────────

  const handleAudioFile = useCallback(async file => {
    setUploadingAudio(true)
    setAudioError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/upload-audio`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setAudioInfo(data)
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''))
      // auto-analyze
      setAnalyzingAudio(true)
      setAnalyzeError(null)
      try {
        const ar = await fetch(`${BACKEND_ORIGIN}/api/music-video/analyze-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio_path: data.audio_path }),
        })
        if (!ar.ok) {
          let detail = await ar.text()
          try { detail = JSON.parse(detail)?.detail || detail } catch {}
          setAnalyzeError(detail || 'Analisi audio fallita')
        } else {
          const ad = await ar.json()
          setAudioInfo(prev => ({ ...prev, bpm: ad.bpm, duration_sec: ad.duration_sec || prev?.duration_sec }))
        }
      } catch (err) {
        setAnalyzeError(err.message || 'Analisi audio fallita')
      }
      setAnalyzingAudio(false)
    } catch (err) {
      setAudioError(err.message || 'Upload fallito')
    }
    setUploadingAudio(false)
  }, [title])

  const handleAnalyzeAudio = useCallback(async () => {
    if (!audioInfo?.audio_path) return
    setAnalyzingAudio(true)
    setAnalyzeError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/analyze-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_path: audioInfo.audio_path }),
      })
      if (!res.ok) {
        let detail = await res.text()
        try { detail = JSON.parse(detail)?.detail || detail } catch {}
        setAnalyzeError(detail || 'Analisi audio fallita')
      } else {
        const ad = await res.json()
        setAudioInfo(prev => ({ ...prev, bpm: ad.bpm, duration_sec: ad.duration_sec || prev?.duration_sec }))
      }
    } catch (err) {
      setAnalyzeError(err.message || 'Analisi audio fallita')
    }
    setAnalyzingAudio(false)
  }, [audioInfo])

  // ── scene helpers ──────────────────────────────────────────────────────────

  const addScene = useCallback(() => {
    setScenes(prev => {
      const last = prev[prev.length - 1]
      const lastEnd = last?.end || '00:00'
      const endSec = mmssToSecs(lastEnd)
      const newStart = secsToTimecode(endSec)
      const newEnd = secsToTimecode(endSec + 8)
      return [...prev, { start: newStart, end: newEnd, desc: '' }]
    })
  }, [])

  const updateScene = useCallback((idx, patch) => {
    setScenes(prev => prev.map((s, i) => i === idx ? { ...s, ...patch } : s))
  }, [])

  const removeScene = useCallback(idx => {
    setScenes(prev => prev.filter((_, i) => i !== idx))
  }, [])

  const moveScene = useCallback((idx, dir) => {
    setScenes(prev => {
      const arr = [...prev]
      const target = idx + dir
      if (target < 0 || target >= arr.length) return prev
      ;[arr[idx], arr[target]] = [arr[target], arr[idx]]
      return arr
    })
  }, [])

  const handleGenerateSrt = useCallback(async () => {
    if (!audioInfo?.audio_path) return
    setGeneratingSrt(true)
    setSrtError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/generate-srt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_path: audioInfo.audio_path,
          description: aiConcept,
          num_scenes: aiNumScenes,
          style_hint: aiStyleHint,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      const parsed = parseSrt(data.srt_content || '')
      if (parsed.length) {
        setScenes(parsed)
        setSceneTab('builder')
      } else {
        setSrtError('Nessuna scena generata. Prova con una descrizione più dettagliata.')
      }
    } catch (err) {
      setSrtError(err.message || 'Generazione fallita')
    }
    setGeneratingSrt(false)
  }, [audioInfo, aiConcept, aiNumScenes, aiStyleHint])

  const handleSrtUpload = useCallback(file => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = e => {
      const parsed = parseSrt(e.target.result || '')
      if (parsed.length) {
        setScenes(parsed)
        setSceneTab('builder')
      }
    }
    reader.readAsText(file)
  }, [])

  // ── transcription ─────────────────────────────────────────────────────────

  const handleTranscribeAlign = useCallback(async () => {
    if (!audioInfo?.audio_path) return
    setTranscribing(true)
    setTranscribeError(null)
    setTranscribeWords([])
    setTranscribeSrt('')
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/transcribe-align`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_path: audioInfo.audio_path,
          lyrics: lyrics.trim(),
          model_size: transcribeModelSize,
          max_gap: 1.5,
          max_words_per_segment: 8,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setTranscribeWords(data.words || [])
      setTranscribeSrt(data.srt_content || '')
    } catch (err) {
      setTranscribeError(err.message || 'Trascrizione fallita')
    }
    setTranscribing(false)
  }, [audioInfo, lyrics, transcribeModelSize])

  const applyTranscribeSrt = useCallback(() => {
    if (!transcribeSrt) return
    const parsed = parseSrt(transcribeSrt)
    if (parsed.length) {
      setScenes(parsed)
      setSceneTab('builder')
    }
  }, [transcribeSrt])

  // ── story field AI generation ─────────────────────────────────────────────

  const generateStoryField = useCallback(async (field, setter, setGenerating, setError) => {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/generate-story-field`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field,
          scenes: scenes.map(s => ({ start: s.start, end: s.end, desc: s.desc })),
          lyrics: lyrics.trim(),
          title: title.trim(),
          style_hint: aiStyleHint.trim(),
          audio_duration_sec: audioInfo?.duration_sec || 0,
        }),
      })
      if (!res.ok) {
        let detail = await res.text()
        try { detail = JSON.parse(detail)?.detail || detail } catch {}
        throw new Error(detail)
      }
      const data = await res.json()
      if (data.text) setter(data.text)
      else throw new Error('LLM ha restituito risposta vuota')
    } catch (err) {
      setError(err.message || 'Errore generazione AI')
    }
    setGenerating(false)
  }, [scenes, lyrics, title, aiStyleHint, audioInfo])

  const handleGenerateRefPrompt = useCallback(async () => {
    setGeneratingRefPrompt(true)
    setRefPromptError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/generate-reference-prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenes: scenes.map(s => ({ start: s.start, end: s.end, desc: s.desc })),
          lyrics: lyrics.trim(),
          subjects_text: subjectsText.trim(),
          style_text: styleText.trim(),
          title: title.trim(),
          resolution_w: resolution.w,
          resolution_h: resolution.h,
        }),
      })
      if (!res.ok) {
        let detail = await res.text()
        try { detail = JSON.parse(detail)?.detail || detail } catch {}
        throw new Error(detail)
      }
      const data = await res.json()
      if (data.prompt) setReferencePrompt(data.prompt)
      else throw new Error('LLM ha restituito prompt vuoto')
    } catch (err) {
      setRefPromptError(err.message || 'Errore generazione AI')
    }
    setGeneratingRefPrompt(false)
  }, [scenes, lyrics, subjectsText, styleText, title, resolution])

  // ── validation ─────────────────────────────────────────────────────────────

  const validStep0 = !!audioInfo?.audio_path
  const validStep1 = scenes.length > 0 && scenes.some(s => s.desc.trim().length > 0)
  const validStep2 = subjectsText.trim().length >= 20 && styleText.trim().length >= 10
  const validStep3 = referencePrompt.trim().length > 0

  const stepValid = [validStep0, validStep1, validStep2, validStep3]
  const canGenerate = validStep0 && validStep1 && validStep2 && validStep3

  // ── generate ───────────────────────────────────────────────────────────────

  const initProgressStages = useCallback(totalScenes => {
    const stages = [
      { id: 'upload', label: 'Upload file → ComfyUI', status: 'pending', progress: null, detail: null },
      { id: 'reference_frame', label: 'Generazione frame di riferimento', status: 'pending', progress: null, detail: null },
    ]
    for (let i = 0; i < totalScenes; i++) {
      stages.push({ id: `scene_${i}`, label: `Scena ${i + 1}/${totalScenes} — Generazione video`, status: 'pending', progress: null, detail: null })
    }
    stages.push({ id: 'assembly', label: 'Assemblaggio finale', status: 'pending', progress: null, detail: null })
    return stages
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return
    const srtContent = scenesToSrt(scenes)
    const body = {
      project_id: 'music_video',
      title: title || 'Music Video',
      audio_path: audioInfo.audio_path,
      srt_content: srtContent,
      subjects_text: subjectsText,
      style_text: styleText,
      reference_prompt: referencePrompt,
      negative_prompt: negativePrompt,
      width: resolution.w,
      height: resolution.h,
      fps,
      seed,
      scene_duration: sceneDuration,
      crf,
    }

    setProgressStages(initProgressStages(scenes.length))
    setOverallProgress(0)
    setProgressLogs([])
    setProgressError(null)
    setDoneVideoUrl(null)
    setGenerating(true)
    setView('progress')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/music-video/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const part of parts) {
          const line = part.trim().replace(/^data:\s*/, '')
          if (!line) continue
          try {
            const ev = JSON.parse(line)
            handleSseEvent(ev)
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setProgressError(err.message || 'Errore durante la generazione')
      }
    }

    setGenerating(false)
  }, [canGenerate, scenes, title, audioInfo, subjectsText, styleText, referencePrompt, negativePrompt, resolution, fps, seed, sceneDuration, crf, initProgressStages])

  const handleSseEvent = useCallback(ev => {
    if (!ev) return
    const { event, msg, progress_pct, scene_index, total, video_url, job_id } = ev

    if (msg) {
      setProgressLogs(prev => [...prev.slice(-99), msg])
    }

    if (progress_pct != null) {
      setOverallProgress(progress_pct)
    }

    const markDone = id => setProgressStages(prev =>
      prev.map(s => s.id === id ? { ...s, status: 'done', progress: 100 } : s)
    )
    const markActive = (id, progress, detail) => setProgressStages(prev =>
      prev.map(s => {
        if (s.id === id) return { ...s, status: 'active', progress: progress ?? s.progress, detail: detail ?? s.detail }
        if (s.status === 'active' && s.id !== id) return { ...s, status: 'done' }
        return s
      })
    )

    if (event === 'upload') {
      markActive('upload', progress_pct, msg)
    } else if (event === 'reference_frame') {
      markDone('upload')
      markActive('reference_frame', progress_pct, msg)
    } else if (event === 'scene') {
      markDone('reference_frame')
      if (scene_index != null) {
        for (let i = 0; i < scene_index; i++) markDone(`scene_${i}`)
        markActive(`scene_${scene_index}`, progress_pct, msg)
      }
    } else if (event === 'assembly') {
      if (total != null) {
        for (let i = 0; i < total; i++) markDone(`scene_${i}`)
      }
      setProgressStages(prev => prev.map(s =>
        s.id.startsWith('scene_') ? { ...s, status: 'done' } : s
      ))
      markActive('assembly', progress_pct, msg)
    } else if (event === 'done') {
      setProgressStages(prev => prev.map(s => ({ ...s, status: 'done', progress: 100 })))
      setOverallProgress(100)
      if (video_url) setDoneVideoUrl(`${BACKEND_ORIGIN}${video_url}`)
    } else if (event === 'error') {
      setProgressError(msg || 'Errore sconosciuto')
    }
  }, [])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    setGenerating(false)
  }, [])

  const handleDeleteJob = useCallback(async job => {
    if (!window.confirm(`Eliminare "${job.title || job.job_id}"?`)) return
    try {
      await fetch(`${BACKEND_ORIGIN}/api/music-video/jobs/${encodeURIComponent(job.project_id || 'music_video')}/${encodeURIComponent(job.job_id)}`, {
        method: 'DELETE',
      })
      setJobs(prev => prev.filter(j => j.job_id !== job.job_id))
    } catch {}
  }, [])

  // ── wizard navigation ──────────────────────────────────────────────────────

  const goNext = useCallback(() => setStep(s => Math.min(s + 1, STEPS.length - 1)), [])
  const goPrev = useCallback(() => setStep(s => Math.max(s - 1, 0)), [])

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  // ── progress view ──────────────────────────────────────────────────────────
  if (view === 'progress') {
    return (
      <div
        style={{
          padding: 32,
          maxWidth: 760,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h2
              style={{
                fontFamily: 'Playfair Display, serif',
                fontSize: 22,
                color: '#e8e4dd',
                margin: 0,
              }}
            >
              Generazione Music Video
            </h2>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                color: '#555568',
                marginTop: 4,
              }}
            >
              {title || 'Music Video'}
            </div>
          </div>
          {generating && (
            <button
              onClick={handleStop}
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                color: '#ef4444',
                background: '#ef444411',
                border: '1px solid #ef444433',
                borderRadius: 8,
                padding: '8px 16px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <StopCircle size={14} />
              Stop
            </button>
          )}
          {!generating && (
            <button
              onClick={() => setView('list')}
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                color: '#9090a8',
                background: '#1e1e2a',
                border: '1px solid #252533',
                borderRadius: 8,
                padding: '8px 16px',
                cursor: 'pointer',
              }}
            >
              Torna alla lista
            </button>
          )}
        </div>

        <div
          style={{
            background: '#0f0f18',
            border: '1px solid #252533',
            borderRadius: 12,
            padding: 20,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8' }}>
              Progresso totale
            </span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#c9a84c' }}>
              {overallProgress}%
            </span>
          </div>
          <div style={{ height: 4, background: '#1e1e2a', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                height: 4,
                background: 'linear-gradient(90deg, #c9a84c, #e6c46a)',
                borderRadius: 4,
                width: `${overallProgress}%`,
                transition: 'width 0.5s ease',
              }}
            />
          </div>
        </div>

        <div
          style={{
            background: '#0f0f18',
            border: '1px solid #252533',
            borderRadius: 12,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {progressStages.map(stage => (
            <ProgressStageRow
              key={stage.id}
              label={stage.label}
              status={stage.status}
              progress={stage.progress}
              detail={stage.detail}
            />
          ))}
        </div>

        {progressError && (
          <div
            style={{
              background: '#ef444411',
              border: '1px solid #ef444433',
              borderRadius: 10,
              padding: 16,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <AlertCircle size={16} color="#ef4444" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, color: '#ef4444' }}>
              {progressError}
            </span>
          </div>
        )}

        {progressLogs.length > 0 && (
          <div
            style={{
              background: '#07070d',
              border: '1px solid #1e1e2a',
              borderRadius: 10,
              padding: 12,
            }}
          >
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: '#555568',
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              LOG
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {progressLogs.slice(-10).map((log, i) => (
                <div
                  key={i}
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#9090a8',
                    lineHeight: 1.5,
                  }}
                >
                  {log}
                </div>
              ))}
            </div>
          </div>
        )}

        {doneVideoUrl && (
          <div
            style={{
              background: '#22c55e11',
              border: '1px solid #22c55e33',
              borderRadius: 12,
              padding: 20,
            }}
          >
            <div
              style={{
                fontFamily: 'Playfair Display, serif',
                fontSize: 16,
                color: '#22c55e',
                marginBottom: 12,
              }}
            >
              Music Video completato
            </div>
            <video
              src={doneVideoUrl}
              controls
              style={{ width: '100%', borderRadius: 8, display: 'block' }}
            />
          </div>
        )}
      </div>
    )
  }

  // ── list view ──────────────────────────────────────────────────────────────
  if (view === 'list') {
    return (
      <div style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1
              style={{
                fontFamily: 'Playfair Display, serif',
                fontSize: 26,
                color: '#e8e4dd',
                margin: 0,
              }}
            >
              Music Video
            </h1>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                color: '#555568',
                marginTop: 4,
              }}
            >
              Pipeline LTX per music video cinematografici
            </div>
          </div>
          <button
            onClick={() => { setStep(0); setView('wizard') }}
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              fontWeight: 700,
              color: '#07070d',
              background: 'linear-gradient(135deg, #c9a84c, #e6c46a)',
              border: 'none',
              borderRadius: 10,
              padding: '10px 20px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              letterSpacing: 0.5,
            }}
          >
            <Plus size={16} />
            Nuovo Music Video
          </button>
        </div>

        {jobsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#555568' }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>Caricamento…</span>
          </div>
        ) : jobs.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '80px 24px',
              border: '1px dashed #252533',
              borderRadius: 16,
              gap: 12,
            }}
          >
            <Film size={40} color="#252533" />
            <div
              style={{
                fontFamily: 'Playfair Display, serif',
                fontSize: 16,
                color: '#555568',
              }}
            >
              Nessun music video ancora
            </div>
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                color: '#32324a',
              }}
            >
              Crea il tuo primo music video con la pipeline LTX
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            {jobs.map(job => (
              <JobCard key={job.job_id} job={job} onDelete={handleDeleteJob} />
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── wizard view ────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* left panel — step indicator */}
      <div
        style={{
          width: 200,
          flexShrink: 0,
          background: '#0f0f18',
          borderRight: '1px solid #252533',
          padding: '32px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        <button
          onClick={() => setView('list')}
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: '#555568',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          ← Lista
        </button>
        <div>
          <div
            style={{
              fontFamily: 'Playfair Display, serif',
              fontSize: 13,
              color: '#c9a84c',
              marginBottom: 20,
              letterSpacing: 0.5,
            }}
          >
            Nuovo Music Video
          </div>
          <StepIndicator current={step} />
        </div>

        <div style={{ marginTop: 'auto' }}>
          {canGenerate && step === STEPS.length - 1 && (
            <div
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10,
                color: '#22c55e',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Check size={12} />
              Pronto
            </div>
          )}
        </div>
      </div>

      {/* right panel — step content */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: 1, overflowY: 'auto', padding: 32 }}>

          {/* STEP 0: MUSICA */}
          {step === 0 && (
            <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h2
                  style={{
                    fontFamily: 'Playfair Display, serif',
                    fontSize: 22,
                    color: '#e8e4dd',
                    margin: '0 0 6px',
                  }}
                >
                  Traccia audio
                </h2>
                <p
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: '#9090a8',
                    margin: 0,
                  }}
                >
                  Carica la traccia musicale. Il BPM e la durata vengono rilevati automaticamente.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#9090a8',
                    letterSpacing: 1,
                  }}
                >
                  TITOLO PROGETTO
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Es. Neon Dreams"
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 13,
                    background: '#1e1e2a',
                    border: '1px solid #252533',
                    borderRadius: 8,
                    color: '#e8e4dd',
                    padding: '10px 14px',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#9090a8',
                    letterSpacing: 1,
                  }}
                >
                  FILE AUDIO
                </label>
                <AudioDropzone
                  audioInfo={audioInfo}
                  uploading={uploadingAudio}
                  onFile={handleAudioFile}
                />
                {audioError && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
                    <AlertCircle size={13} />
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{audioError}</span>
                  </div>
                )}
              </div>

              {audioInfo && (
                <button
                  onClick={handleAnalyzeAudio}
                  disabled={analyzingAudio}
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: analyzingAudio ? '#555568' : '#c9a84c',
                    background: '#c9a84c11',
                    border: '1px solid #c9a84c33',
                    borderRadius: 8,
                    padding: '8px 16px',
                    cursor: analyzingAudio ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    alignSelf: 'flex-start',
                  }}
                >
                  {analyzingAudio ? (
                    <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  Analizza audio
                </button>
              )}
              {analyzeError && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
                  <AlertCircle size={13} />
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{analyzeError}</span>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#9090a8',
                    letterSpacing: 1,
                  }}
                >
                  LIRICA (opzionale)
                </label>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568', marginBottom: 2 }}>
                  Incolla il testo del brano per l'allineamento forzato (wav2vec2) nel tab Trascrizione
                </div>
                <textarea
                  value={lyrics}
                  onChange={e => setLyrics(e.target.value)}
                  rows={6}
                  placeholder={"[Verse 1]\nWords fall like rain on empty streets\nSilence speaks in broken beats…"}
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    background: '#1e1e2a',
                    border: '1px solid #252533',
                    borderRadius: 8,
                    color: '#e8e4dd',
                    padding: '10px 14px',
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />
              </div>
            </div>
          )}

          {/* STEP 1: SCENE */}
          {step === 1 && (
            <div style={{ maxWidth: 800, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h2
                  style={{
                    fontFamily: 'Playfair Display, serif',
                    fontSize: 22,
                    color: '#e8e4dd',
                    margin: '0 0 6px',
                  }}
                >
                  Scene
                </h2>
                <p
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: '#9090a8',
                    margin: 0,
                  }}
                >
                  Definisci i segmenti del video con timing e prompt visivo. Il formato SRT indica a ComfyUI cosa generare per ogni scena.
                </p>
              </div>

              {/* tabs */}
              <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid #252533', paddingBottom: 0 }}>
                {[
                  { id: 'builder', label: 'Crea scene', icon: <Plus size={12} /> },
                  { id: 'ai', label: 'Genera con AI', icon: <Sparkles size={12} /> },
                  { id: 'transcribe', label: 'Trascrizione', icon: <Mic size={12} /> },
                  { id: 'upload', label: 'Carica SRT', icon: <Upload size={12} /> },
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setSceneTab(tab.id)}
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12,
                      color: sceneTab === tab.id ? '#c9a84c' : '#555568',
                      background: 'none',
                      border: 'none',
                      borderBottom: sceneTab === tab.id ? '2px solid #c9a84c' : '2px solid transparent',
                      padding: '8px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      marginBottom: -1,
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* builder tab */}
              {sceneTab === 'builder' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {scenes.map((scene, idx) => (
                      <SceneRow
                        key={idx}
                        scene={scene}
                        index={idx}
                        total={scenes.length}
                        onChange={patch => updateScene(idx, patch)}
                        onRemove={() => removeScene(idx)}
                        onMoveUp={() => moveScene(idx, -1)}
                        onMoveDown={() => moveScene(idx, 1)}
                      />
                    ))}
                  </div>
                  <button
                    onClick={addScene}
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12,
                      color: '#c9a84c',
                      background: '#c9a84c11',
                      border: '1px dashed #c9a84c44',
                      borderRadius: 8,
                      padding: '10px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      alignSelf: 'flex-start',
                    }}
                  >
                    <Plus size={14} />
                    Aggiungi scena
                  </button>
                  {scenes.length > 0 && <SrtPreviewPanel scenes={scenes} />}
                </div>
              )}

              {/* AI tab */}
              {sceneTab === 'ai' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                      CONCEPT DEL VIDEO
                    </label>
                    <textarea
                      value={aiConcept}
                      onChange={e => setAiConcept(e.target.value)}
                      rows={5}
                      placeholder="Descrivi il concept del video. L'AI creerà le scene con timing basato sull'audio…"
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 12,
                        background: '#1e1e2a',
                        border: '1px solid #252533',
                        borderRadius: 8,
                        color: '#e8e4dd',
                        padding: '10px 14px',
                        resize: 'vertical',
                        lineHeight: 1.6,
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                        NUMERO SCENE ({aiNumScenes})
                      </label>
                      <input
                        type="range"
                        min={4}
                        max={20}
                        value={aiNumScenes}
                        onChange={e => setAiNumScenes(parseInt(e.target.value, 10))}
                        style={{ accentColor: '#c9a84c', width: '100%' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#555568' }}>4</span>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#555568' }}>20</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                        STILE
                      </label>
                      <input
                        type="text"
                        value={aiStyleHint}
                        onChange={e => setAiStyleHint(e.target.value)}
                        placeholder="noir, wes anderson, naturalismo…"
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 12,
                          background: '#1e1e2a',
                          border: '1px solid #252533',
                          borderRadius: 8,
                          color: '#e8e4dd',
                          padding: '10px 14px',
                        }}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleGenerateSrt}
                    disabled={generatingSrt || !audioInfo?.audio_path}
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 13,
                      fontWeight: 700,
                      color: generatingSrt || !audioInfo?.audio_path ? '#555568' : '#07070d',
                      background: generatingSrt || !audioInfo?.audio_path
                        ? '#1e1e2a'
                        : 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                      border: 'none',
                      borderRadius: 8,
                      padding: '10px 20px',
                      cursor: generatingSrt || !audioInfo?.audio_path ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      alignSelf: 'flex-start',
                    }}
                  >
                    {generatingSrt ? (
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    {generatingSrt ? 'Generazione in corso…' : 'Genera con AI'}
                  </button>
                  {srtError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
                      <AlertCircle size={13} />
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{srtError}</span>
                    </div>
                  )}
                  {!audioInfo?.audio_path && (
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568' }}>
                      Carica prima un file audio per abilitare la generazione AI
                    </div>
                  )}
                </div>
              )}

              {/* transcription tab */}
              {sceneTab === 'transcribe' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568', lineHeight: 1.6 }}>
                    {lyrics.trim()
                      ? 'Usa wav2vec2 per allineare la lirica fornita al brano (timestamp word-level precisi).'
                      : 'Trascrivi il brano con Whisper locale (word timestamps). Per allineamento preciso: incolla la lirica nel passo MUSICA.'}
                  </div>

                  {lyrics.trim() && (
                    <div style={{ background: '#0f0f18', border: '1px solid #c9a84c22', borderRadius: 8, padding: '10px 14px' }}>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#c9a84c', letterSpacing: 1, marginBottom: 6 }}>
                        LIRICA ({lyrics.trim().split(/\s+/).length} parole)
                      </div>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>
                        {lyrics.trim()}
                      </div>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    {!lyrics.trim() && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#555568', letterSpacing: 1 }}>
                          MODELLO WHISPER
                        </label>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {['tiny', 'base', 'small', 'medium'].map(m => (
                            <button
                              key={m}
                              onClick={() => setTranscribeModelSize(m)}
                              style={{
                                fontFamily: 'JetBrains Mono, monospace',
                                fontSize: 11,
                                color: transcribeModelSize === m ? '#c9a84c' : '#9090a8',
                                background: transcribeModelSize === m ? '#c9a84c11' : '#1e1e2a',
                                border: `1px solid ${transcribeModelSize === m ? '#c9a84c44' : '#252533'}`,
                                borderRadius: 5,
                                padding: '4px 10px',
                                cursor: 'pointer',
                              }}
                            >
                              {m}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={handleTranscribeAlign}
                      disabled={transcribing || !audioInfo?.audio_path}
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 13,
                        fontWeight: 700,
                        color: transcribing || !audioInfo?.audio_path ? '#555568' : '#07070d',
                        background: transcribing || !audioInfo?.audio_path
                          ? '#1e1e2a'
                          : 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                        border: 'none',
                        borderRadius: 8,
                        padding: '10px 20px',
                        cursor: transcribing || !audioInfo?.audio_path ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {transcribing ? (
                        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      ) : (
                        <Mic size={14} />
                      )}
                      {transcribing
                        ? 'Elaborazione…'
                        : lyrics.trim() ? 'Allinea lirica (wav2vec2)' : 'Trascrivi (Whisper)'}
                    </button>
                  </div>

                  {transcribeError && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
                      <AlertCircle size={13} />
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{transcribeError}</span>
                    </div>
                  )}

                  {transcribeWords.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8' }}>
                        {transcribeWords.length} parole · timeline word-level
                      </div>

                      {/* word timeline */}
                      {(() => {
                        const totalDur = transcribeWords[transcribeWords.length - 1]?.end || 1
                        return (
                          <div
                            style={{
                              position: 'relative',
                              height: 48,
                              background: '#07070d',
                              border: '1px solid #1e1e2a',
                              borderRadius: 8,
                              overflow: 'hidden',
                            }}
                          >
                            {transcribeWords.map((w, i) => {
                              const left = (w.start / totalDur) * 100
                              const width = Math.max(0.3, ((w.end - w.start) / totalDur) * 100)
                              return (
                                <div
                                  key={i}
                                  title={`${w.word} (${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s)`}
                                  style={{
                                    position: 'absolute',
                                    left: `${left}%`,
                                    width: `${width}%`,
                                    top: 6,
                                    bottom: 6,
                                    background: '#c9a84c44',
                                    border: '1px solid #c9a84c66',
                                    borderRadius: 3,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    overflow: 'hidden',
                                  }}
                                >
                                  <span style={{
                                    fontFamily: 'JetBrains Mono, monospace',
                                    fontSize: 8,
                                    color: '#c9a84c',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'clip',
                                  }}>
                                    {w.word}
                                  </span>
                                </div>
                              )
                            })}
                          </div>
                        )
                      })()}

                      {/* side-by-side: lirica originale | SRT risultante */}
                      {transcribeSrt && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          {/* colonna sinistra — lirica originale */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                            <div style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 10,
                              color: '#555568',
                              letterSpacing: 1,
                              padding: '6px 10px',
                              background: '#0f0f18',
                              border: '1px solid #1e1e2a',
                              borderBottom: 'none',
                              borderRadius: '6px 6px 0 0',
                            }}>
                              LIRICA ORIGINALE
                            </div>
                            <pre style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 11,
                              color: '#9090a8',
                              margin: 0,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              background: '#07070d',
                              border: '1px solid #1e1e2a',
                              borderRadius: '0 0 6px 6px',
                              padding: '10px 12px',
                              minHeight: 180,
                              maxHeight: 320,
                              overflowY: 'auto',
                              lineHeight: 1.7,
                            }}>
                              {lyrics.trim() || '(nessuna lirica)'}
                            </pre>
                          </div>

                          {/* colonna destra — SRT con timestamp */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                            <div style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 10,
                              color: '#c9a84c',
                              letterSpacing: 1,
                              padding: '6px 10px',
                              background: '#0f0f18',
                              border: '1px solid #c9a84c33',
                              borderBottom: 'none',
                              borderRadius: '6px 6px 0 0',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                            }}>
                              <span>SRT — {transcribeSrt.split('\n\n').filter(Boolean).length} segmenti</span>
                              <span style={{ color: '#555568' }}>{transcribeWords.length} parole</span>
                            </div>
                            <pre style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 11,
                              color: '#e8e4dd',
                              margin: 0,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              background: '#07070d',
                              border: '1px solid #c9a84c33',
                              borderRadius: '0 0 6px 6px',
                              padding: '10px 12px',
                              minHeight: 180,
                              maxHeight: 320,
                              overflowY: 'auto',
                              lineHeight: 1.7,
                            }}>
                              {transcribeSrt}
                            </pre>
                          </div>
                        </div>
                      )}

                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={applyTranscribeSrt}
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 12,
                            fontWeight: 700,
                            color: '#07070d',
                            background: 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                            border: 'none',
                            borderRadius: 8,
                            padding: '8px 18px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <Check size={13} />
                          Usa come scene
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* upload SRT tab */}
              {sceneTab === 'upload' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div
                    onDragOver={e => { e.preventDefault(); setSrtUploadDragging(true) }}
                    onDragLeave={() => setSrtUploadDragging(false)}
                    onDrop={e => {
                      e.preventDefault()
                      setSrtUploadDragging(false)
                      handleSrtUpload(e.dataTransfer.files[0])
                    }}
                    onClick={() => srtInputRef.current?.click()}
                    style={{
                      border: `2px dashed ${srtUploadDragging ? '#c9a84c' : '#252533'}`,
                      borderRadius: 12,
                      padding: '32px 24px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      background: srtUploadDragging ? '#c9a84c08' : '#0f0f18',
                      transition: 'all 0.2s',
                    }}
                  >
                    <FileText size={28} color={srtUploadDragging ? '#c9a84c' : '#555568'} />
                    <div style={{ fontFamily: 'Playfair Display, serif', fontSize: 14, color: '#9090a8' }}>
                      Trascina il file .srt o clicca per sfogliare
                    </div>
                    <input
                      ref={srtInputRef}
                      type="file"
                      accept=".srt"
                      style={{ display: 'none' }}
                      onChange={e => handleSrtUpload(e.target.files[0])}
                    />
                  </div>
                  {scenes.length > 0 && (
                    <div>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', marginBottom: 8 }}>
                        {scenes.length} scene caricate
                      </div>
                      <SrtPreviewPanel scenes={scenes} />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* STEP 2: STORIA */}
          {step === 2 && (
            <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div>
                <h2
                  style={{
                    fontFamily: 'Playfair Display, serif',
                    fontSize: 22,
                    color: '#e8e4dd',
                    margin: '0 0 6px',
                  }}
                >
                  Storia
                </h2>
                <p
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: '#9090a8',
                    margin: 0,
                  }}
                >
                  Descrivi i personaggi, la narrativa e l'estetica visiva. Questi testi guidano l'LLM nella generazione dei prompt.
                </p>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                    SOGGETTI &amp; SCENE
                  </label>
                  <button
                    onClick={() => generateStoryField('subjects', setSubjectsText, setGeneratingSubjects, setSubjectsError)}
                    disabled={generatingSubjects}
                    title="Genera con AI"
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11,
                      color: generatingSubjects ? '#555568' : '#c9a84c',
                      background: '#c9a84c11',
                      border: '1px solid #c9a84c33',
                      borderRadius: 6,
                      padding: '4px 10px',
                      cursor: generatingSubjects ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    {generatingSubjects ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={11} />}
                    {generatingSubjects ? 'Generazione…' : 'Genera con AI'}
                  </button>
                </div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568', marginBottom: 4 }}>
                  Descrivi i personaggi, l'ambientazione e la narrativa generale
                </div>
                <textarea
                  value={subjectsText}
                  onChange={e => setSubjectsText(e.target.value)}
                  rows={8}
                  placeholder="Una donna in un vestito bianco cammina attraverso una foresta oscura. Il suo sguardo trasmette malinconia e speranza..."
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    background: '#1e1e2a',
                    border: `1px solid ${subjectsText.trim().length > 0 && subjectsText.trim().length < 20 ? '#ef444466' : '#252533'}`,
                    borderRadius: 8,
                    color: '#e8e4dd',
                    padding: '12px 14px',
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />
                {subjectsText.trim().length > 0 && subjectsText.trim().length < 20 && (
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#ef4444' }}>
                    Minimo 20 caratteri
                  </div>
                )}
                {subjectsError && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#ef4444' }}>
                    <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{subjectsError}</span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                    TEMA &amp; STILE
                  </label>
                  <button
                    onClick={() => generateStoryField('style', setStyleText, setGeneratingStyle, setStyleError)}
                    disabled={generatingStyle}
                    title="Genera con AI"
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11,
                      color: generatingStyle ? '#555568' : '#c9a84c',
                      background: '#c9a84c11',
                      border: '1px solid #c9a84c33',
                      borderRadius: 6,
                      padding: '4px 10px',
                      cursor: generatingStyle ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    {generatingStyle ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={11} />}
                    {generatingStyle ? 'Generazione…' : 'Genera con AI'}
                  </button>
                </div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568', marginBottom: 4 }}>
                  Descrivi lo stile visivo, i colori e l'estetica
                </div>
                <textarea
                  value={styleText}
                  onChange={e => setStyleText(e.target.value)}
                  rows={5}
                  placeholder="Cinematografico, luce drammatica, tonalità fredde con accenti dorati, stile pittorico..."
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    background: '#1e1e2a',
                    border: `1px solid ${styleText.trim().length > 0 && styleText.trim().length < 10 ? '#ef444466' : '#252533'}`,
                    borderRadius: 8,
                    color: '#e8e4dd',
                    padding: '12px 14px',
                    resize: 'vertical',
                    lineHeight: 1.6,
                  }}
                />
                {styleText.trim().length > 0 && styleText.trim().length < 10 && (
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#ef4444' }}>
                    Minimo 10 caratteri
                  </div>
                )}
                {styleError && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#ef4444' }}>
                    <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{styleError}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: IMPOSTAZIONI */}
          {step === 3 && (
            <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 28 }}>
              <div>
                <h2
                  style={{
                    fontFamily: 'Playfair Display, serif',
                    fontSize: 22,
                    color: '#e8e4dd',
                    margin: '0 0 6px',
                  }}
                >
                  Frame di riferimento &amp; Impostazioni
                </h2>
                <p
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    color: '#9090a8',
                    margin: 0,
                  }}
                >
                  Il frame di riferimento è la prima immagine generata via txt2img. Imposta risoluzione, FPS e altri parametri.
                </p>
              </div>

              {/* reference prompt */}
              <div
                style={{
                  background: '#0f0f18',
                  border: '1px solid #252533',
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}
              >
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#c9a84c',
                    letterSpacing: 1,
                  }}
                >
                  FRAME DI RIFERIMENTO (TXT2IMG)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                      PROMPT POSITIVO
                    </label>
                    <button
                      onClick={handleGenerateRefPrompt}
                      disabled={generatingRefPrompt}
                      title="Genera con AI leggendo scene, lirica, soggetti e stile"
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11,
                        color: generatingRefPrompt ? '#555568' : '#07070d',
                        background: generatingRefPrompt
                          ? '#1e1e2a'
                          : 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                        border: 'none',
                        borderRadius: 6,
                        padding: '5px 12px',
                        cursor: generatingRefPrompt ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        fontWeight: 700,
                      }}
                    >
                      {generatingRefPrompt
                        ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                        : <Sparkles size={11} />}
                      {generatingRefPrompt ? 'Generazione…' : 'Crea con AI'}
                    </button>
                  </div>
                  <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568', marginBottom: 2 }}>
                    Descrive il personaggio principale o la scena di riferimento
                  </div>
                  <textarea
                    value={referencePrompt}
                    onChange={e => setReferencePrompt(e.target.value)}
                    rows={5}
                    placeholder="cinematic still, a woman in a white dress standing at the edge of a dark forest, dramatic backlight, golden hour, 35mm film grain, shallow depth of field..."
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12,
                      background: '#1e1e2a',
                      border: `1px solid ${!referencePrompt.trim() ? '#ef444433' : '#252533'}`,
                      borderRadius: 8,
                      color: '#e8e4dd',
                      padding: '10px 14px',
                      resize: 'vertical',
                      lineHeight: 1.6,
                    }}
                  />
                  {!referencePrompt.trim() && (
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 5 }}>
                      <AlertCircle size={11} />
                      Campo obbligatorio
                    </div>
                  )}
                  {refPromptError && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: '#ef4444' }}>
                      <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{refPromptError}</span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                    PROMPT NEGATIVO
                  </label>
                  <textarea
                    value={negativePrompt}
                    onChange={e => setNegativePrompt(e.target.value)}
                    rows={3}
                    style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12,
                      background: '#1e1e2a',
                      border: '1px solid #252533',
                      borderRadius: 8,
                      color: '#9090a8',
                      padding: '10px 14px',
                      resize: 'vertical',
                      lineHeight: 1.6,
                    }}
                  />
                </div>
              </div>

              {/* settings grid */}
              <div
                style={{
                  background: '#0f0f18',
                  border: '1px solid #252533',
                  borderRadius: 12,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20,
                }}
              >
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: '#c9a84c',
                    letterSpacing: 1,
                  }}
                >
                  PARAMETRI OUTPUT
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* resolution */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                      RISOLUZIONE
                    </label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {RESOLUTIONS.map(r => (
                        <button
                          key={`${r.w}x${r.h}`}
                          onClick={() => setResolution(r)}
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 11,
                            color: resolution.w === r.w && resolution.h === r.h ? '#c9a84c' : '#9090a8',
                            background: resolution.w === r.w && resolution.h === r.h ? '#c9a84c11' : 'transparent',
                            border: `1px solid ${resolution.w === r.w && resolution.h === r.h ? '#c9a84c44' : '#252533'}`,
                            borderRadius: 6,
                            padding: '6px 10px',
                            cursor: 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            textAlign: 'left',
                          }}
                        >
                          <span>{r.label}</span>
                          <span style={{ color: '#555568', fontSize: 10 }}>{r.ratio}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#555568' }}>
                      {resolution.w} × {resolution.h}
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* fps */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                        FPS
                      </label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[24, 25, 30].map(f => (
                          <button
                            key={f}
                            onClick={() => setFps(f)}
                            style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: 12,
                              color: fps === f ? '#c9a84c' : '#9090a8',
                              background: fps === f ? '#c9a84c11' : '#1e1e2a',
                              border: `1px solid ${fps === f ? '#c9a84c44' : '#252533'}`,
                              borderRadius: 6,
                              padding: '6px 14px',
                              cursor: 'pointer',
                              flex: 1,
                            }}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* seed */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                        SEED
                      </label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="number"
                          value={seed}
                          onChange={e => setSeed(parseInt(e.target.value, 10) || 0)}
                          style={{
                            flex: 1,
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 12,
                            background: '#1e1e2a',
                            border: '1px solid #252533',
                            borderRadius: 6,
                            color: '#e8e4dd',
                            padding: '6px 10px',
                          }}
                        />
                        <button
                          onClick={() => setSeed(randSeed())}
                          title="Seed casuale"
                          style={{
                            fontFamily: 'JetBrains Mono, monospace',
                            fontSize: 11,
                            color: '#9090a8',
                            background: '#1e1e2a',
                            border: '1px solid #252533',
                            borderRadius: 6,
                            padding: '6px 10px',
                            cursor: 'pointer',
                          }}
                        >
                          <RefreshCw size={13} />
                        </button>
                      </div>
                    </div>

                    {/* scene duration */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                          DURATA SCENA
                        </label>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: sceneDuration === 0 ? '#c9a84c' : '#e8e4dd' }}>
                          {sceneDuration === 0 ? 'SRT' : `${sceneDuration}s`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={15}
                        step={1}
                        value={sceneDuration}
                        onChange={e => setSceneDuration(parseInt(e.target.value, 10))}
                        style={{ accentColor: '#c9a84c', width: '100%' }}
                      />
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#555568' }}>
                        0 = usa timing SRT
                      </div>
                    </div>

                    {/* crf */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <label style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#9090a8', letterSpacing: 1 }}>
                          CRF QUALITA
                        </label>
                        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: '#e8e4dd' }}>
                          {crf}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={15}
                        max={30}
                        step={1}
                        value={crf}
                        onChange={e => setCrf(parseInt(e.target.value, 10))}
                        style={{ accentColor: '#c9a84c', width: '100%' }}
                      />
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#555568' }}>
                        Valore più basso = qualità maggiore
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* bottom nav bar */}
        <div
          style={{
            borderTop: '1px solid #252533',
            padding: '16px 32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: '#0f0f18',
            flexShrink: 0,
          }}
        >
          <button
            onClick={goPrev}
            disabled={step === 0}
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              color: step === 0 ? '#252533' : '#9090a8',
              background: 'none',
              border: '1px solid',
              borderColor: step === 0 ? '#1e1e2a' : '#252533',
              borderRadius: 8,
              padding: '9px 20px',
              cursor: step === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            ← Indietro
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {step < STEPS.length - 1 ? (
              <button
                onClick={goNext}
                disabled={!stepValid[step]}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 13,
                  fontWeight: 700,
                  color: !stepValid[step] ? '#555568' : '#07070d',
                  background: !stepValid[step]
                    ? '#1e1e2a'
                    : 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 24px',
                  cursor: !stepValid[step] ? 'not-allowed' : 'pointer',
                  letterSpacing: 0.5,
                }}
              >
                Avanti →
              </button>
            ) : (
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 13,
                  fontWeight: 700,
                  color: !canGenerate ? '#555568' : '#07070d',
                  background: !canGenerate
                    ? '#1e1e2a'
                    : 'linear-gradient(135deg, #c9a84c, #e6c46a)',
                  border: 'none',
                  borderRadius: 10,
                  padding: '10px 28px',
                  cursor: !canGenerate ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  letterSpacing: 0.5,
                }}
              >
                <Film size={15} />
                Genera Music Video
              </button>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
