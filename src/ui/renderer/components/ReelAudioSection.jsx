/**
 * Upload audio, player con offset start, analisi e lirica manuale per CreateReel.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Music2, Upload, Play, Pause, Loader2, X, Sparkles, CheckCircle2, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { BACKEND_ORIGIN } from '../utils/mediaUrl'

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function reelAudioStreamUrl(filePath) {
  if (!filePath) return null
  return `${BACKEND_ORIGIN}/api/reel/source?path=${encodeURIComponent(filePath)}`
}

function ReelAudioDropZone({ audioFile, onPick, onFile, onClear }) {
  const [dragging, setDragging] = useState(false)

  if (audioFile) {
    return (
      <div className="rounded-lg border border-[#c9a84c]/30 bg-[#c9a84c]/5 p-3 flex items-center gap-3">
        <Music2 size={18} className="text-[#c9a84c] shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-[#e8e4dd] truncate">{audioFile.name}</p>
          <p className="text-[9px] font-mono text-[#9090a8]">{audioFile.path}</p>
        </div>
        <button type="button" onClick={onClear} className="text-[#555568] hover:text-[#ef4444]">
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onPick()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        const file = e.dataTransfer.files?.[0]
        if (file?.path) {
          const ext = file.name.split('.').pop()?.toLowerCase()
          if (['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'].includes(ext)) {
            onFile({ path: file.path, name: file.name, size: file.size })
          }
        }
      }}
      onClick={onPick}
      className={clsx(
        'rounded-lg border-2 border-dashed p-5 flex flex-col items-center gap-2 cursor-pointer transition-colors',
        dragging ? 'border-[#c9a84c] bg-[#c9a84c]/10' : 'border-[#252533] hover:border-[#32324a]',
      )}
    >
      <Upload size={20} className="text-[#555568]" />
      <p className="text-[10px] font-mono text-[#9090a8]">Trascina o clicca — mp3, wav, m4a, flac…</p>
    </div>
  )
}

function ReelAudioPlayer({
  filePath,
  startSec,
  playDurationSec,
  onStartSecChange,
  fileDurationSec,
  analysis,
}) {
  const audioRef = useRef(null)
  const streamUrl = reelAudioStreamUrl(filePath)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(startSec)
  const [duration, setDuration] = useState(fileDurationSec || 0)

  const windowEnd = startSec + playDurationSec

  useEffect(() => {
    const el = audioRef.current
    if (!el || !streamUrl) return
    setReady(false)
    setPlaying(false)
    el.src = streamUrl
    el.load()
  }, [streamUrl])

  useEffect(() => {
    const el = audioRef.current
    if (!el || !ready) return
    if (el.currentTime < startSec - 0.05 || el.currentTime > windowEnd + 0.05) {
      el.currentTime = startSec
      setCurrentTime(startSec)
    }
  }, [startSec, playDurationSec, ready, windowEnd])

  const relTime = Math.max(0, currentTime - startSec)
  const relPct = playDurationSec > 0 ? (relTime / playDurationSec) * 100 : 0

  function toggle() {
    const el = audioRef.current
    if (!el || !ready) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      if (el.currentTime < startSec || el.currentTime >= windowEnd) {
        el.currentTime = startSec
      }
      el.play().then(() => setPlaying(true)).catch(() => {})
    }
  }

  function handleSeek(e) {
    const el = audioRef.current
    if (!el || !playDurationSec) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t = startSec + ratio * playDurationSec
    el.currentTime = t
    setCurrentTime(t)
  }

  return (
    <div className="rounded-lg border border-[#c9a84c]/30 bg-[#0f0f18] p-3">
      <audio
        ref={audioRef}
        preload="metadata"
        onCanPlay={() => setReady(true)}
        onLoadedMetadata={() => {
          const d = audioRef.current?.duration ?? 0
          setDuration(d)
          setReady(true)
          if (audioRef.current) {
            audioRef.current.currentTime = startSec
            setCurrentTime(startSec)
          }
        }}
        onTimeUpdate={() => {
          const t = audioRef.current?.currentTime ?? 0
          if (t >= windowEnd) {
            audioRef.current?.pause()
            setPlaying(false)
            audioRef.current.currentTime = startSec
            setCurrentTime(startSec)
            return
          }
          setCurrentTime(t)
        }}
        onEnded={() => {
          setPlaying(false)
          if (audioRef.current) {
            audioRef.current.currentTime = startSec
            setCurrentTime(startSec)
          }
        }}
      />
      <div className="flex items-center justify-between mb-2">
        <span className="text-[8px] font-mono text-[#c9a84c] uppercase">Anteprima traccia</span>
        {analysis && (
          <span className="text-[8px] font-mono text-[#22c55e]">
            ✓ {Math.round(analysis.bpm || 0)} BPM · {analysis.sections} sez.
            {analysis.lyric_beats > 0 ? ` · ${analysis.lyric_beats} righe testo` : ''}
          </span>
        )}
      </div>
      <div
        className="h-1 rounded-full bg-[#1e1e2a] mb-2 cursor-pointer"
        onClick={handleSeek}
        role="presentation"
      >
        <div className="h-full bg-[#c9a84c] rounded-full" style={{ width: `${relPct}%` }} />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={toggle}
          disabled={!ready}
          className="w-7 h-7 rounded-full flex items-center justify-center bg-[#c9a84c]/20 border border-[#c9a84c]/40 disabled:opacity-40"
        >
          {playing ? <Pause size={10} className="text-[#c9a84c]" /> : <Play size={10} className="text-[#c9a84c] ml-0.5" />}
        </button>
        <span className="text-[9px] font-mono text-[#9090a8] tabular-nums">
          {formatTime(relTime)} / {formatTime(playDurationSec)} (reel)
        </span>
        <span className="text-[9px] font-mono text-[#555568] ml-auto tabular-nums">
          file {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[9px] font-mono text-[#9090a8]">Inizio audio (secondo)</label>
          <span className="text-[9px] font-mono text-[#c9a84c] tabular-nums">{startSec.toFixed(1)}s</span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, (duration || playDurationSec * 2) - playDurationSec)}
          step={0.1}
          value={startSec}
          onChange={e => {
            const v = parseFloat(e.target.value)
            onStartSecChange(v)
            if (audioRef.current) {
              audioRef.current.currentTime = v
              setCurrentTime(v)
            }
          }}
          className="w-full accent-[#c9a84c]"
        />
        <p className="text-[8px] font-mono text-[#555568] mt-1">
          Il reel usa {playDurationSec}s dalla traccia a partire da questo punto.
        </p>
      </div>
    </div>
  )
}

const ENERGY_COLORS = {
  low: '#555568',
  medium: '#3b82f6',
  high: '#f59e0b',
  peak: '#ef4444',
}

const SECTION_TYPE_COLORS = {
  chorus: '#c9a84c',
  verse: '#3b82f6',
  hook: '#22c55e',
  drop: '#ef4444',
  bridge: '#a855f7',
  intro: '#555568',
  outro: '#555568',
}

function ReelAudioAnalysisResult({ analysis, hasLyrics }) {
  const [openSections, setOpenSections] = useState(true)
  const [openLyrics, setOpenLyrics] = useState(true)

  if (!analysis?.raw) return null

  const raw = analysis.raw
  const sections = raw.sections || []
  const lyricBeats = raw.lyric_beats || []
  const energyBreakdown = sections.reduce((acc, s) => {
    const e = s.energy || 'medium'
    acc[e] = (acc[e] || 0) + 1
    return acc
  }, {})

  return (
    <div className="rounded-lg border border-[#22c55e]/40 bg-[#22c55e]/5 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <CheckCircle2 size={16} className="text-[#22c55e] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-mono text-[#22c55e] uppercase tracking-wider">
            Analisi completata
          </p>
          <p className="text-[9px] font-mono text-[#9090a8] mt-0.5 leading-relaxed">
            Finestra reel {raw.audio_start_sec?.toFixed?.(1) ?? 0}s →{' '}
            {((raw.audio_start_sec || 0) + (raw.duration_sec || 0)).toFixed(1)}s sulla traccia.
            I dati restano in questa sessione finché non avvii la generazione (la pipeline li ricalcola).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'BPM', value: Math.round(analysis.bpm || raw.bpm || 0) },
          { label: 'Sezioni', value: analysis.sections },
          { label: 'Downbeat', value: raw.downbeat_count ?? '—' },
          { label: 'Durata reel', value: `${raw.duration_sec ?? '—'}s` },
        ].map(({ label, value }) => (
          <div key={label} className="rounded bg-[#0f0f18] border border-[#252533] p-2 text-center">
            <p className="text-[7px] font-mono text-[#555568] uppercase">{label}</p>
            <p className="text-[11px] font-mono text-[#c9a84c] tabular-nums">{value}</p>
          </div>
        ))}
      </div>

      {Object.keys(energyBreakdown).length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(energyBreakdown).map(([energy, count]) => (
            <span
              key={energy}
              className="text-[8px] font-mono px-1.5 py-0.5 rounded"
              style={{
                background: `${ENERGY_COLORS[energy] || '#555568'}22`,
                color: ENERGY_COLORS[energy] || '#9090a8',
                border: `1px solid ${ENERGY_COLORS[energy] || '#555568'}44`,
              }}
            >
              {energy} ×{count}
            </span>
          ))}
        </div>
      )}

      {sections.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpenSections(o => !o)}
            className="flex items-center gap-1 text-[9px] font-mono text-[#9090a8] hover:text-[#e8e4dd]"
          >
            {openSections ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Timeline sezioni ({sections.length})
          </button>
          {openSections && (
            <div className="mt-2 max-h-40 overflow-y-auto space-y-1 pr-1">
              {sections.map((s, i) => (
                <div
                  key={s.section_id || i}
                  className="flex items-center gap-2 text-[8px] font-mono py-1 border-b border-[#252533]/60"
                >
                  <span
                    className="px-1 rounded shrink-0"
                    style={{
                      color: SECTION_TYPE_COLORS[s.section_type] || '#9090a8',
                      background: `${SECTION_TYPE_COLORS[s.section_type] || '#555568'}18`,
                    }}
                  >
                    {s.section_type || '—'}
                  </span>
                  <span className="text-[#555568] tabular-nums shrink-0">
                    {Number(s.start_sec).toFixed(1)}–{Number(s.end_sec).toFixed(1)}s
                  </span>
                  <span
                    className="shrink-0"
                    style={{ color: ENERGY_COLORS[s.energy] || '#9090a8' }}
                  >
                    {s.energy}
                  </span>
                  {s.has_vocal && (
                    <span className="text-[#c9a84c] shrink-0">vocale</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {hasLyrics ? (
        lyricBeats.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setOpenLyrics(o => !o)}
              className="flex items-center gap-1 text-[9px] font-mono text-[#9090a8] hover:text-[#e8e4dd]"
            >
              {openLyrics ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Timing lirica ({lyricBeats.length} righe)
            </button>
            {openLyrics && (
              <div className="mt-2 max-h-36 overflow-y-auto space-y-1 pr-1">
                {lyricBeats.slice(0, 24).map((b, i) => (
                  <div key={i} className="text-[8px] font-mono flex gap-2 py-0.5 border-b border-[#252533]/40">
                    <span className="text-[#c9a84c] tabular-nums shrink-0 w-14">
                      {Number(b.time_sec).toFixed(1)}s
                    </span>
                    <span className="text-[#e8e4dd] truncate">{b.lyric_line}</span>
                  </div>
                ))}
                {lyricBeats.length > 24 && (
                  <p className="text-[8px] font-mono text-[#555568]">
                    … altre {lyricBeats.length - 24} righe in pipeline
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-[9px] font-mono text-[#f59e0b] flex items-center gap-1">
            <AlertCircle size={12} />
            Testo presente ma nessun beat generato — verifica righe non vuote nel campo lirica.
          </p>
        )
      ) : (
        <p className="text-[9px] font-mono text-[#555568]">
          Senza testo incollato: analisi solo BPM/sezioni/energia. Per il timing lirica aggiungi i versi e rianalizza.
        </p>
      )}
    </div>
  )
}

export default function ReelAudioSection({
  audioFile,
  setAudioFile,
  audioStartSec,
  setAudioStartSec,
  reelDurationSec,
  lyrics,
  setLyrics,
  onAnalysis,
}) {
  const [analyzing, setAnalyzing] = useState(false)
  const [analysis, setAnalysis] = useState(null)
  const [analyzeError, setAnalyzeError] = useState(null)

  const pickAudio = useCallback(async () => {
    const picked = await window.studio?.reel?.pickAudio?.()
    if (picked?.path) {
      setAudioFile(picked)
      setAnalysis(null)
      setAnalyzeError(null)
    }
  }, [setAudioFile])

  async function runAnalysis() {
    if (!audioFile?.path) return
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      const res = await fetch(`${BACKEND_ORIGIN}/api/reel/analyze-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_path: audioFile.path,
          audio_start_sec: audioStartSec,
          duration_sec: reelDurationSec,
          lyrics: lyrics?.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || data.error || res.statusText)
      setAnalysis({
        bpm: data.bpm,
        sections: data.sections?.length ?? 0,
        lyric_beats: data.lyric_beats?.length ?? 0,
        raw: data,
      })
      onAnalysis?.(data)
    } catch (e) {
      setAnalyzeError(e.message || 'Analisi fallita')
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4 mb-6 space-y-4">
      <div>
        <p className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider mb-1">
          Traccia audio (opzionale)
        </p>
        <p className="text-[9px] font-mono text-[#555568] leading-relaxed">
          Con audio: analisi BPM/mood, timing lirica, regia sincronizzata e generazione clip con workflow{' '}
          <span className="text-[#c9a84c]">LTX image+audio→video</span>.
          Puoi incollare i testi manualmente (nessuna estrazione automatica dalla traccia).
        </p>
      </div>

      <ReelAudioDropZone
        audioFile={audioFile}
        onPick={pickAudio}
        onFile={(f) => {
          setAudioFile(f)
          setAnalysis(null)
          onAnalysis?.(null)
        }}
        onClear={() => {
          setAudioFile(null)
          setAnalysis(null)
          onAnalysis?.(null)
        }}
      />

      {audioFile && (
        <>
          <ReelAudioPlayer
            filePath={audioFile.path}
            startSec={audioStartSec}
            playDurationSec={reelDurationSec}
            onStartSecChange={setAudioStartSec}
            analysis={analysis}
          />

          <div>
            <label className="text-[10px] font-mono text-[#9090a8] uppercase tracking-wider block mb-1">
              Testo / lirica (opzionale, manuale)
            </label>
            <textarea
              value={lyrics}
              onChange={e => setLyrics(e.target.value)}
              rows={5}
              placeholder="Incolla qui il testo della canzone (una riga per verso). Se compilato, non verrà estratto dalla traccia — solo analisi e allineamento temporale."
              className="w-full bg-[#0f0f18] border border-[#252533] rounded px-3 py-2 text-xs font-mono text-[#e8e4dd] resize-y"
            />
          </div>

          <button
            type="button"
            onClick={runAnalysis}
            disabled={analyzing}
            className="flex items-center gap-2 px-3 py-2 rounded text-[10px] font-mono border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/10 disabled:opacity-50"
          >
            {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {analyzing ? 'Analisi in corso…' : 'Analizza audio e timing lirica'}
          </button>
          {analyzeError && (
            <p className="text-[10px] font-mono text-[#ef4444] flex items-center gap-1">
              <AlertCircle size={12} />
              {analyzeError}
            </p>
          )}

          {analysis && !analyzing && (
            <ReelAudioAnalysisResult
              analysis={analysis}
              hasLyrics={Boolean(lyrics?.trim())}
            />
          )}
        </>
      )}
    </div>
  )
}
