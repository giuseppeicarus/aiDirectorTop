from pathlib import Path

path = Path(r"f:\SOLO_AI\AidirectorTOP\src\ui\renderer\screens\CreateReelScreen.jsx")
content = path.read_text(encoding="utf-8")

# Part 1: Add Clock, Upload, Play, Pause, Copy, Tv to lucide-react imports
bad_imports = """import {
  ImagePlus, Loader2, Sparkles, Check, RefreshCw, X, Film,
  LayoutGrid, AlertCircle, Image as ImageIcon, Trash2, Clapperboard,
  ChevronRight, Instagram, Library, Search, ChevronDown, Settings2, Cpu, Square,
  Save, RotateCcw, Edit3, ChevronUp, Wand2, UserRound, Music2, Maximize2, List,
} from 'lucide-react'"""

good_imports = """import {
  ImagePlus, Loader2, Sparkles, Check, RefreshCw, X, Film,
  LayoutGrid, AlertCircle, Image as ImageIcon, Trash2, Clapperboard,
  ChevronRight, Instagram, Library, Search, ChevronDown, Settings2, Cpu, Square,
  Save, RotateCcw, Edit3, ChevronUp, Wand2, UserRound, Music2, Maximize2, List,
  Clock, Upload, Play, Pause, Copy, Tv
} from 'lucide-react'"""

if bad_imports in content:
    content = content.replace(bad_imports, good_imports)
    print("Imports updated successfully!")
elif bad_imports.replace("\n", "\r\n") in content:
    content = content.replace(bad_imports.replace("\n", "\r\n"), good_imports.replace("\n", "\r\n"))
    print("Imports (CRLF) updated successfully!")
else:
    print("Imports already up to date or not matched.")

# Part 2: Replace JobDetailView definition
start_marker = "function JobDetailView({ job, projectId, onBack, onOpenReview, onResumePipeline, onRestartFromScratch, onDelete }) {"
end_marker = "  return (\n    <div className=\"flex-1 flex flex-col overflow-hidden\">\n      <div className=\"flex items-center justify-between px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0\">"

# Instead of matching the exact return block which might be long, let's replace the whole function using normalized content
normalized_content = content.replace("\r\n", "\n")

# Find index of JobDetailView
idx_func = normalized_content.find("function JobDetailView({")
if idx_func == -1:
    print("Error: function JobDetailView not found!")
    exit(1)

# Find the end of JobDetailView. The function ends just before the picker modal:
# // ── Media Library picker modal ───────────────────────────────────────────────
idx_picker = normalized_content.find("// ── Media Library picker modal ───────────────────────────────────────────────")
if idx_picker == -1:
    print("Error: Picker modal comment not found!")
    exit(1)

# Grab everything before JobDetailView and everything after it
before_part = normalized_content[:idx_func]
after_part = normalized_content[idx_picker:]

# Define new upgraded JobDetailView and ReelAudioPlayerCard
new_components = """// ── Audio Player Card for Reels ───────────────────────────────────────────────
function ReelAudioPlayerCard({ filePath, label, displayName, highlight = False }) {
  const audioRef = useRef(null)
  const streamUrl = reelAudioStreamUrl(filePath)
  const [ready, setReady] = useState(False)
  const [playing, setPlaying] = useState(False)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    setLoadError(null)
    setReady(False)
    setPlaying(False)
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
      setPlaying(False)
    } else {
      audioRef.current.play()
        .then(() => setPlaying(True))
        .catch(e => console.error('[AudioPlayer] play() rejected:', e?.message))
    }
  }

  function handleSeek(e) {
    if (!audioRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    audioRef.current.currentTime = ratio * (audioRef.current.duration || 0)
  }

  function formatTimeLocal(sec) {
    if (!sec || isNaN(sec)) return '0:00'
    const m = Math.floor(sec / 60)
    const s = Math.floor(sec % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const BAR_HEIGHTS = [3, 5, 7, 4, 8, 6, 4, 7, 5, 3, 6, 4, 7, 5, 6]
  const accentColor = highlight ? '#c9a84c' : '#3b82f6'

  return (
    <div
      className="rounded-lg p-3 shrink-0"
      style={{
        background: highlight ? '#c9a84c0a' : '#0f0f18',
        border: `1px solid ${highlight ? '#c9a84c44' : '#252533'}`,
      }}
    >
      <audio
        ref={audioRef}
        preload="metadata"
        crossOrigin="anonymous"
        onCanPlay={() => setReady(True)}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => {
          setDuration(audioRef.current?.duration ?? 0)
          setReady(True)
        }}
        onEnded={() => { setPlaying(False); setCurrentTime(0) }}
        onError={() => {
          const code = audioRef.current?.error?.code
          const msg = code === 4 ? 'Formato non supportato' : (loadError || 'Impossibile caricare l\\'audio')
          setLoadError(msg)
          setReady(False)
          setPlaying(False)
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
          {displayName ?? filePath?.split(/[\\\\/]/).pop() ?? '—'}
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
          {formatTimeLocal(currentTime)}
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
            : <Play size={8} style={{ color: ready ? '#9090a8' : '#555568', marginLeft: 1 }} />}
        </button>

        <span className="text-[9px] font-mono text-[#555568] w-8 text-right tabular-nums">
          {formatTimeLocal(duration)}
        </span>
      </div>
    </div>
  )
}

function formatBytesLocal(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
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
    let cancelled = False
    setLoadingJob(True)
    ;(async () => {
      try {
        const res = await fetch(
          `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${encodeURIComponent(job.job_id)}`,
        )
        if (res.ok && !cancelled) setFullJob(await res.json())
      } catch { /* keep list snapshot */ }
      finally {
        if (!cancelled) setLoadingJob(False)
      }
    })()
    return () => { cancelled = True }
  }, [projectId, job.job_id])

  const reviewLabel = fullJob.status === 'awaiting_storyboard'
    ? 'Revisione storyboard'
    : isLive
      ? 'Riprendi monitoraggio pipeline'
      : jobHasFinalVideo(fullJob)
        ? 'Anteprime e reel'
        : 'Anteprime e vision'

  async function handleDelete() {
    setDeleting(True)
    try {
      const res = await fetch(
        `${BACKEND_ORIGIN}/api/reel/jobs/${encodeURIComponent(projectId)}/${job.job_id}?cleanup=True`,
        { method: 'DELETE' },
      )
      if (res.ok) onDelete()
    } finally {
      setDeleting(False)
    }
  }

  const durationTarget = fullJob.config?.duration_sec != null ? `${fullJob.config.duration_sec}s` : '—'
  const resolutionFormat = fullJob.config?.aspect_ratio 
    ? `${fullJob.config.aspect_ratio} · ${fullJob.config.width}×${fullJob.config.height}`
    : '—'

  const detailsRows = [
    { label: 'Stato', value: <StatusBadge status={fullJob.status} /> },
    { label: 'Job ID', value: <code className="text-[#c9a84c]">{fullJob.job_id}</code> },
    {
      label: 'Cartella Progetto',
      value: (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-[#c9a84c] hover:text-[#e6c46a] font-mono text-[9px]"
          title="Clicca per copiare"
          onClick={async () => {
            try { await navigator.clipboard.writeText(storageId) } catch {}
          }}
        >
          <code>{storageId}</code>
          <Copy size={9} />
        </button>
      )
    },
    { label: 'Creato', value: fullJob.created_at ? new Date(fullJob.created_at).toLocaleString('it-IT') : '—' },
    { label: 'Traccia Audio', value: fullJob.audio_name || 'Nessuna' },
    { label: 'Durata Target', value: durationTarget },
    { label: 'Formato / Ris.', value: resolutionFormat },
    { label: 'FPS Video', value: fullJob.config?.fps || '—' },
    { label: 'Workflow ComfyUI', value: fullJob.config?.img2video_workflow || '—' },
    ...(fullJob.result ? [
      { label: 'Durata Finale', value: fullJob.result.duration_sec != null ? `${fullJob.result.duration_sec.toFixed(1)}s` : '—', accent: True },
      { label: 'Clip Totali', value: fullJob.result.clips?.length ?? fullJob.result.storyboard?.length ?? '—', accent: True },
      { label: 'Dimensione File', value: fullJob.result.size_bytes ? formatBytesLocal(fullJob.result.size_bytes) : '—', accent: True }
    ] : [])
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[#07070d]">
      
      {/* ── slate dashboard header ── */}
      <header className="border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="flex items-center gap-1 text-[10px] font-mono text-[#9090a8] hover:text-[#e8e4dd] transition-colors"
            >
              <ChevronRight size={12} className="rotate-180" />
              Lista
            </button>
            <span className="text-[#252533]">/</span>
            <Tv size={16} className="text-[#c9a84c]" />
            <h1 className="text-sm font-mono text-[#e8e4dd] truncate max-w-xs">{fullJob.audio_name || fullJob.description?.slice(0, 40) || 'Dettaglio Reel'}</h1>
            <StatusBadge status={fullJob.status} small />
          </div>
          
          <div className="flex gap-2">
            {canResume && onResumePipeline && (
              <GoldBtn onClick={() => onResumePipeline(fullJob)} disabled={loadingJob}>
                <RotateCcw size={13} />
                Riprendi Pipeline
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
                Stato Live
              </GhostBtn>
            )}
            <GhostBtn onClick={() => onRestartFromScratch(job)}>
              <RefreshCw size={12} />
              Rigenera da Zero
            </GhostBtn>
            <GhostBtn onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
              Elimina
            </GhostBtn>
          </div>
        </div>
      </header>

      {/* ── Split Deck panels ── */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-6xl mx-auto">
          
          {/* LEFT DECK: Live Monitors */}
          <div className="space-y-4">
            
            {/* Audio sources */}
            {fullJob.audio_path && (
              <ReelAudioPlayerCard
                filePath={fullJob.audio_path}
                label="Traccia Sorgente Audio"
                displayName={fullJob.audio_name}
              />
            )}
            {fullJob.result?.reel_audio_path && (
              <ReelAudioPlayerCard
                filePath={fullJob.result.reel_audio_path}
                label="Reel Audio Muxed (Assembly)"
                highlight={True}
              />
            )}

            {/* Video preview monitor */}
            <div className="rounded-xl border border-[#252533] bg-[#16161f] overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-[#252533] bg-[#0f0f18] flex items-center justify-between">
                <span className="text-[9px] font-mono uppercase tracking-widest text-[#555568]">Monitor Video Principale</span>
                <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e]" />
              </div>
              <div className="p-3 flex items-center justify-center bg-[#07070d]">
                {videoSrc ? (
                  <video
                    src={videoSrc}
                    controls
                    autoPlay
                    className="w-full rounded border border-[#252533] max-h-[50vh] object-contain bg-[#000]"
                  />
                ) : fullJob.status === 'failed' ? (
                  <div className="flex flex-col items-center gap-3 py-16 text-center">
                    <AlertCircle size={28} className="text-[#ef4444]" />
                    <p className="text-xs font-mono text-[#ef4444] px-4 font-bold">Generazione fallita</p>
                    <p className="text-[9px] font-mono text-[#9090a8] max-w-sm px-6">{fullJob.error || 'Errore indefinito della pipeline'}</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-20 text-[#555568]">
                    <Film size={32} className="animate-pulse" />
                    <span className="text-[9px] font-mono uppercase tracking-wider">Video in fase di elaborazione...</span>
                  </div>
                )}
              </div>
              {videoSrc && (
                <div className="px-3 py-2.5 bg-[#0f0f18] border-t border-[#252533] flex gap-2">
                  <GhostBtn
                    onClick={() => window.studio?.shell?.openPath?.(fullJob.result?.video_path)}
                    className="flex-1 justify-center text-[9px]"
                  >
                    <Film size={11} /> Apri File Nativo
                  </GhostBtn>
                  <GhostBtn
                    onClick={() => {
                      const a = document.createElement('a')
                      a.href = videoSrc
                      a.download = fullJob.result?.filename || 'reel.mp4'
                      a.click()
                    }}
                    className="flex-1 justify-center text-[9px]"
                  >
                    <Upload size={11} /> Scarica MP4
                  </GhostBtn>
                </div>
              )}
            </div>

            {/* Prompt Brief panel */}
            <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2">Brief / Descrizione Originale</div>
              <p className="text-xs text-[#e8e4dd] leading-relaxed break-words whitespace-pre-wrap">{fullJob.description || 'Nessuna descrizione specificata.'}</p>
            </div>

          </div>

          {/* RIGHT DECK: Slate & Control details */}
          <div className="space-y-4">
            
            {/* Slate metadata details */}
            <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
              <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-3">Slate Tecnico di Regia</div>
              <div className="space-y-2.5">
                {detailsRows.map(({ label, value, accent }) => value != null && (
                  <div key={label} className="flex items-start gap-4 text-[10px] font-mono py-1 border-b border-[#252533]/40 last:border-0">
                    <span className="text-[#555568] w-32 shrink-0">{label}</span>
                    <span className={clsx(
                      'break-all flex-1 text-right',
                      accent ? 'text-[#c9a84c] font-bold' : 'text-[#e8e4dd]'
                    )}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Visual style banner */}
            {fullJob.config?.style && (
              <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2">Visore Stile Visivo Regista</div>
                <div className="rounded border border-[#c9a84c]/20 bg-[#c9a84c]/[0.02] p-2.5 border-dashed">
                  <p className="text-[10px] font-mono text-[#9090a8] leading-relaxed break-words whitespace-pre-wrap">{fullJob.config.style}</p>
                </div>
              </div>
            )}

            {/* Live Progress Visor (only when generating or active) */}
            {fullJob.progress_pct != null && (
              <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
                <div className="text-[9px] font-mono uppercase tracking-widest text-[#555568] mb-2">Avanzamento Cabina Regia</div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-[#9090a8]">Progresso Globale</span>
                    <span className="text-[#c9a84c] font-bold">{Math.round(fullJob.progress_pct)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[#1e1e2a] overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#c9a84c] to-[#e6c46a]"
                      style={{ width: `${fullJob.progress_pct}%` }}
                    />
                  </div>
                </div>
              </div>
            )}

          </div>

        </div>
      </div>
    </div>
  )
}

"""

# Stitch it back
normalized_content = before_part + new_components + after_part

# Convert back to CRLF if needed
if "\r\n" in content:
    content = normalized_content.replace("\n", "\r\n")
else:
    content = normalized_content

# Write back
path.write_text(content, encoding="utf-8")
print("Detail view overhauled successfully!")
