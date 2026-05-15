import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Scissors, Play, Plus, Trash2, ArrowUp, ArrowDown,
  AlertCircle, CheckCircle, Loader2, ChevronRight, X,
  Sliders, FolderOpen, Film, Eye, Download,
} from 'lucide-react'
import clsx from 'clsx'

// ── Constants ─────────────────────────────────────────────────────────────────

const STAGE_LABELS = {
  extracting_frames:   'Estrazione frame',
  analyzing_similarity:'Analisi similarità',
  analyzing_motion:    'Analisi movimento',
  deciding_cuts:       'Decisione tagli',
  trimming:            'Trim clip',
  merging:             'Unione clip',
  completed:           'Completato',
  failed:              'Errore',
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function FrameCutOptimizerScreen() {
  const [clips, setClips]               = useState([])
  const [transitions, setTransitions]   = useState([])
  const [selectedIdx, setSelectedIdx]   = useState(null)
  const [outputPath, setOutputPath]     = useState('')
  const [settings, setSettings]         = useState(null)
  const [activeTab, setActiveTab]       = useState('clips')  // clips | results | settings
  const [analyzing, setAnalyzing]       = useState(false)
  const [applying, setApplying]         = useState(false)
  const [currentJobId, setCurrentJobId] = useState(null)
  const [logs, setLogs]                 = useState([])
  const [progress, setProgress]         = useState(null)
  const [toolsOk, setToolsOk]          = useState(null)
  const logsEndRef = useRef(null)

  // ── Load settings + check tools ─────────────────────────────────────────

  useEffect(() => {
    window.studio.frameCut.getSettings().then(s => setSettings(s)).catch(() => {})
    window.studio.frameCut.checkTools({}).then(result => setToolsOk(result)).catch(() => {})
  }, [])

  // ── Progress listener ────────────────────────────────────────────────────

  useEffect(() => {
    const cleanup = window.studio.frameCut.onProgress(data => {
      setProgress(data)
      const label = STAGE_LABELS[data.stage] || data.stage
      addLog(`[${label}] ${data.message}`)
    })
    return cleanup
  }, [])

  // ── Auto-scroll logs ─────────────────────────────────────────────────────

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  function addLog(msg) {
    setLogs(prev => [...prev.slice(-199), { id: Date.now() + Math.random(), text: msg }])
  }

  // ── File pickers ─────────────────────────────────────────────────────────

  async function pickClips() {
    const result = await window.studio.frameCut.openVideoFiles()
    if (result?.filePaths?.length) {
      setClips(prev => {
        const existing = new Set(prev.map(c => c.path))
        const newClips = result.filePaths
          .filter(p => !existing.has(p))
          .map(p => ({ id: crypto.randomUUID(), path: p, name: p.split(/[\\/]/).pop() }))
        return [...prev, ...newClips]
      })
    }
  }

  async function pickOutputPath() {
    const result = await window.studio.frameCut.saveVideoFile({ defaultName: 'output_merged.mp4' })
    if (!result?.canceled && result?.filePath) {
      setOutputPath(result.filePath)
    }
  }

  // ── Clip list management ─────────────────────────────────────────────────

  function removeClip(id) {
    setClips(prev => prev.filter(c => c.id !== id))
    setTransitions([])
  }

  function moveClip(id, dir) {
    setClips(prev => {
      const idx = prev.findIndex(c => c.id === id)
      if (idx < 0) return prev
      const next = idx + dir
      if (next < 0 || next >= prev.length) return prev
      const arr = [...prev]
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })
    setTransitions([])
  }

  // ── Analysis ─────────────────────────────────────────────────────────────

  async function runAnalysis() {
    if (clips.length < 2) return addLog('⚠ Aggiungi almeno 2 clip')
    setAnalyzing(true)
    setTransitions([])
    setLogs([])
    setProgress(null)
    setActiveTab('results')

    try {
      const result = await window.studio.frameCut.analyze({
        clips: clips.map(c => c.path),
        settings,
      })
      setCurrentJobId(result.jobId)
      setTransitions(result.transitions)
      addLog(`✓ Analisi completata: ${result.transitions.length} transizioni`)
    } catch (e) {
      addLog(`✗ Errore analisi: ${e.message}`)
    } finally {
      setAnalyzing(false)
      setCurrentJobId(null)
    }
  }

  // ── Apply + merge ─────────────────────────────────────────────────────────

  async function runApplyAndMerge() {
    if (!outputPath) return addLog('⚠ Seleziona il file di output')
    if (clips.length < 2) return addLog('⚠ Aggiungi almeno 2 clip')
    setApplying(true)
    setProgress(null)
    setLogs([])

    try {
      const result = await window.studio.frameCut.apply({
        clips:       clips.map(c => c.path),
        transitions,
        outputPath,
        settings,
      })
      setCurrentJobId(result.jobId)
      addLog(`✓ Video salvato: ${result.outputPath}`)
    } catch (e) {
      addLog(`✗ Errore: ${e.message}`)
    } finally {
      setApplying(false)
      setCurrentJobId(null)
    }
  }

  async function cancelJob() {
    if (currentJobId) {
      await window.studio.frameCut.cancel({ jobId: currentJobId })
      addLog('⚠ Job cancellato')
    }
    setAnalyzing(false)
    setApplying(false)
  }

  // ── Settings update ──────────────────────────────────────────────────────

  async function updateSetting(key, value) {
    const updated = { ...settings, [key]: value }
    setSettings(updated)
    await window.studio.frameCut.updateSettings({ [key]: value }).catch(() => {})
  }

  const isBusy = analyzing || applying

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-[#0a0a0f] text-[#f0ede8]">
      {/* Header */}
      <header className="px-6 py-4 border-b border-[#2a2a38] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <Scissors className="text-[#c9a84c]" size={20} />
          <div>
            <h1 className="font-['Playfair_Display'] text-lg text-[#c9a84c]">Frame Cut Optimizer</h1>
            <p className="text-[11px] text-[#9090a0]">Elimina micro-freeze tra clip video consecutive</p>
          </div>
        </div>

        <ToolsStatus toolsOk={toolsOk} />
      </header>

      {/* Tab bar */}
      <div className="flex border-b border-[#2a2a38] shrink-0 px-6">
        {[
          { id: 'clips',    label: 'Clip' },
          { id: 'results',  label: `Analisi${transitions.length ? ` (${transitions.length})` : ''}` },
          { id: 'settings', label: 'Impostazioni' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'px-4 py-2.5 text-sm border-b-2 transition-colors',
              activeTab === tab.id
                ? 'border-[#c9a84c] text-[#c9a84c]'
                : 'border-transparent text-[#9090a0] hover:text-[#f0ede8]'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-auto">
          {activeTab === 'clips'    && (
            <ClipsPanel
              clips={clips}
              outputPath={outputPath}
              analyzing={analyzing}
              applying={applying}
              isBusy={isBusy}
              onPickClips={pickClips}
              onRemoveClip={removeClip}
              onMoveClip={moveClip}
              onPickOutput={pickOutputPath}
              onAnalyze={runAnalysis}
              onApply={runApplyAndMerge}
              onCancel={cancelJob}
              hasTransitions={transitions.length > 0}
            />
          )}
          {activeTab === 'results'  && (
            <ResultsPanel
              transitions={transitions}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
              analyzing={analyzing}
            />
          )}
          {activeTab === 'settings' && settings && (
            <SettingsPanel settings={settings} onUpdate={updateSetting} />
          )}
        </div>

        {/* Right: frame preview + log */}
        <div className="w-80 border-l border-[#2a2a38] flex flex-col shrink-0">
          {/* Frame preview */}
          {selectedIdx !== null && transitions[selectedIdx] && (
            <FramePreviewPanel transition={transitions[selectedIdx]} />
          )}

          {/* Progress + log */}
          <div className="flex-1 flex flex-col min-h-0">
            {progress && (
              <ProgressBar progress={progress} />
            )}
            <LogPanel logs={logs} logsEndRef={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ToolsStatus({ toolsOk }) {
  if (toolsOk === null) return null
  const ok = toolsOk?.ffmpeg?.available && toolsOk?.ffprobe?.available
  return (
    <div className={clsx(
      'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full',
      ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
    )}>
      {ok ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
      {ok ? 'FFmpeg OK' : `FFmpeg ${!toolsOk?.ffmpeg?.available ? 'mancante' : ''}${!toolsOk?.ffprobe?.available ? ' FFprobe mancante' : ''}`}
    </div>
  )
}

// ── Clips panel ───────────────────────────────────────────────────────────────

function ClipsPanel({
  clips, outputPath, isBusy, analyzing, applying,
  onPickClips, onRemoveClip, onMoveClip, onPickOutput,
  onAnalyze, onApply, onCancel, hasTransitions,
}) {
  return (
    <div className="p-6 space-y-6">
      {/* Clip list */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider">Clip ({clips.length})</h2>
          <button
            onClick={onPickClips}
            disabled={isBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 text-[#c9a84c] text-sm transition-colors disabled:opacity-40"
          >
            <Plus size={14} /> Aggiungi clip
          </button>
        </div>

        {clips.length === 0 ? (
          <EmptyDropHint onPick={onPickClips} />
        ) : (
          <div className="space-y-1.5">
            {clips.map((clip, idx) => (
              <ClipRow
                key={clip.id}
                clip={clip}
                index={idx}
                total={clips.length}
                disabled={isBusy}
                onRemove={() => onRemoveClip(clip.id)}
                onMoveUp={() => onMoveClip(clip.id, -1)}
                onMoveDown={() => onMoveClip(clip.id, +1)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Output path */}
      <section>
        <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider mb-3">File di output</h2>
        <button
          onClick={onPickOutput}
          disabled={isBusy}
          className={clsx(
            'w-full flex items-center gap-2 px-4 py-3 rounded-lg border text-sm transition-colors text-left',
            outputPath
              ? 'border-[#2a2a38] bg-[#12121a] text-[#f0ede8]'
              : 'border-dashed border-[#2a2a38] text-[#9090a0] hover:border-[#c9a84c]/50 hover:text-[#c9a84c]'
          )}
        >
          <FolderOpen size={15} />
          <span className="truncate">{outputPath || 'Seleziona percorso output...'}</span>
        </button>
      </section>

      {/* Action buttons */}
      <section className="space-y-2">
        <button
          onClick={onAnalyze}
          disabled={isBusy || clips.length < 2}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#c9a84c]/20 hover:bg-[#c9a84c]/30 text-[#c9a84c] font-medium transition-colors disabled:opacity-40"
        >
          {analyzing ? <Loader2 size={16} className="animate-spin" /> : <Eye size={16} />}
          {analyzing ? 'Analisi in corso...' : 'Analizza transizioni'}
        </button>

        <button
          onClick={onApply}
          disabled={isBusy || clips.length < 2 || !outputPath}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#1a1a24] hover:bg-[#252533] text-[#f0ede8] font-medium transition-colors disabled:opacity-40"
        >
          {applying ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {applying ? 'Elaborazione...' : hasTransitions ? 'Applica tagli e unisci' : 'Unisci senza analisi'}
        </button>

        {isBusy && (
          <button
            onClick={onCancel}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm transition-colors"
          >
            <X size={14} /> Annulla job
          </button>
        )}
      </section>
    </div>
  )
}

function EmptyDropHint({ onPick }) {
  return (
    <button
      onClick={onPick}
      className="w-full border-2 border-dashed border-[#2a2a38] rounded-lg p-10 flex flex-col items-center gap-3 text-[#9090a0] hover:border-[#c9a84c]/40 hover:text-[#c9a84c]/70 transition-colors"
    >
      <Film size={32} />
      <span className="text-sm">Clicca per selezionare le clip video</span>
      <span className="text-xs">MP4, MOV, AVI, MKV, WebM</span>
    </button>
  )
}

function ClipRow({ clip, index, total, disabled, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 bg-[#12121a] rounded-lg border border-[#2a2a38] group">
      <span className="text-[11px] text-[#555568] w-4 text-right shrink-0">{index + 1}</span>
      <ChevronRight size={12} className="text-[#555568] shrink-0" />
      <span className="flex-1 text-sm truncate font-mono" title={clip.path}>{clip.name}</span>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onMoveUp}
          disabled={disabled || index === 0}
          className="p-1 rounded text-[#9090a0] hover:text-[#f0ede8] disabled:opacity-20"
        >
          <ArrowUp size={13} />
        </button>
        <button
          onClick={onMoveDown}
          disabled={disabled || index === total - 1}
          className="p-1 rounded text-[#9090a0] hover:text-[#f0ede8] disabled:opacity-20"
        >
          <ArrowDown size={13} />
        </button>
        <button
          onClick={onRemove}
          disabled={disabled}
          className="p-1 rounded text-[#9090a0] hover:text-red-400 disabled:opacity-20"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ── Results panel ─────────────────────────────────────────────────────────────

function ResultsPanel({ transitions, selectedIdx, onSelect, analyzing }) {
  if (analyzing) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <Loader2 size={32} className="animate-spin text-[#c9a84c] mx-auto" />
          <p className="text-[#9090a0] text-sm">Analisi in corso...</p>
        </div>
      </div>
    )
  }

  if (transitions.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-[#555568] text-sm">Nessuna analisi ancora. Aggiungi clip e clicca "Analizza transizioni".</p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider mb-4">
        Transizioni analizzate
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[#9090a0] text-xs border-b border-[#2a2a38]">
              <th className="pb-2 pr-4 font-medium">Clip A → B</th>
              <th className="pb-2 pr-4 font-medium text-center">Sim. max</th>
              <th className="pb-2 pr-4 font-medium text-center">Static B</th>
              <th className="pb-2 pr-4 font-medium text-center">Trim B</th>
              <th className="pb-2 pr-4 font-medium text-center">Trim A</th>
              <th className="pb-2 pr-4 font-medium text-center">Conf.</th>
              <th className="pb-2 font-medium">Transizione</th>
            </tr>
          </thead>
          <tbody>
            {transitions.map((t, i) => {
              const cd = t.cut_decision
              return (
                <tr
                  key={i}
                  onClick={() => onSelect(i)}
                  className={clsx(
                    'border-b border-[#1a1a24] cursor-pointer transition-colors',
                    selectedIdx === i ? 'bg-[#1a1a24]' : 'hover:bg-[#12121a]'
                  )}
                >
                  <td className="py-2.5 pr-4">
                    <div className="flex items-center gap-1 text-[11px]">
                      <span className="truncate max-w-[90px] font-mono text-[#9090a0]" title={t.clip_a}>{t.clip_a}</span>
                      <ChevronRight size={10} className="shrink-0 text-[#555568]" />
                      <span className="truncate max-w-[90px] font-mono text-[#9090a0]" title={t.clip_b}>{t.clip_b}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 text-center">
                    <SimilarityBadge value={t.max_similarity} />
                  </td>
                  <td className="py-2.5 pr-4 text-center text-[#9090a0] text-xs">
                    {t.static_b_frames}
                  </td>
                  <td className="py-2.5 pr-4 text-center">
                    <span className={clsx(
                      'text-xs font-mono',
                      cd.clip_b_trim_start_frames > 0 ? 'text-amber-400' : 'text-[#555568]'
                    )}>
                      {cd.clip_b_trim_start_frames}fr
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-center">
                    <span className={clsx(
                      'text-xs font-mono',
                      cd.clip_a_trim_end_frames > 0 ? 'text-amber-400' : 'text-[#555568]'
                    )}>
                      {cd.clip_a_trim_end_frames}fr
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-center text-xs text-[#9090a0]">
                    {Math.round(cd.confidence * 100)}%
                  </td>
                  <td className="py-2.5 text-xs text-[#9090a0] font-mono">
                    {cd.recommended_transition}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Decision reason for selected row */}
      {selectedIdx !== null && transitions[selectedIdx] && (
        <div className="mt-4 p-3 bg-[#12121a] rounded-lg border border-[#2a2a38]">
          <p className="text-xs text-[#9090a0] leading-relaxed">
            <span className="text-[#c9a84c] font-medium">Motivazione: </span>
            {transitions[selectedIdx].cut_decision.reason}
          </p>
        </div>
      )}
    </div>
  )
}

function SimilarityBadge({ value }) {
  const pct = Math.round(value * 100)
  const color = value >= 0.96
    ? 'text-red-400 bg-red-400/10'
    : value >= 0.85
    ? 'text-amber-400 bg-amber-400/10'
    : 'text-green-400 bg-green-400/10'

  return (
    <span className={clsx('text-xs font-mono px-1.5 py-0.5 rounded', color)}>
      {pct}%
    </span>
  )
}

// ── Frame preview panel ───────────────────────────────────────────────────────

function FramePreviewPanel({ transition }) {
  const [frames, setFrames] = useState({ a: null, b: null, active: null })
  const { previews } = transition

  useEffect(() => {
    setFrames({ a: null, b: null, active: null })
    if (!previews) return

    Promise.all([
      window.studio.frameCut.readFrame(previews.last_frame_a),
      window.studio.frameCut.readFrame(previews.first_frame_b),
      window.studio.frameCut.readFrame(previews.first_active_b),
    ]).then(([a, b, active]) => setFrames({ a, b, active }))
  }, [transition])

  if (!previews) return null

  return (
    <div className="p-4 border-b border-[#2a2a38] space-y-3">
      <h3 className="text-xs text-[#9090a0] uppercase tracking-wider">Preview frame</h3>
      <div className="grid grid-cols-3 gap-2">
        <FrameThumb src={frames.a}      label="Ultimo A" />
        <FrameThumb src={frames.b}      label="Primo B" />
        <FrameThumb src={frames.active} label="Attivo B" highlight />
      </div>
    </div>
  )
}

function FrameThumb({ src, label, highlight }) {
  return (
    <div className="space-y-1">
      <div className={clsx(
        'aspect-video rounded overflow-hidden bg-[#0a0a0f] border',
        highlight ? 'border-[#c9a84c]/50' : 'border-[#2a2a38]'
      )}>
        {src
          ? <img src={src} alt={label} className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center">
              <Loader2 size={12} className="animate-spin text-[#555568]" />
            </div>
        }
      </div>
      <p className={clsx(
        'text-[10px] text-center',
        highlight ? 'text-[#c9a84c]' : 'text-[#555568]'
      )}>
        {label}
      </p>
    </div>
  )
}

// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ settings, onUpdate }) {
  const sliders = [
    { key: 'framesToAnalyze',              label: 'Frame da analizzare',          min: 4,     max: 30,   step: 1,    format: v => `${v} fr` },
    { key: 'duplicateSimilarityThreshold', label: 'Soglia duplicati',             min: 0.80,  max: 1.0,  step: 0.005,format: v => `${(v*100).toFixed(1)}%` },
    { key: 'staticMotionThreshold',        label: 'Soglia frame statici',         min: 0.001, max: 0.05, step: 0.001,format: v => v.toFixed(3) },
    { key: 'maxTrimFrames',                label: 'Trim max (frame)',             min: 1,     max: 15,   step: 1,    format: v => `${v} fr` },
    { key: 'minClipDurationRatio',         label: 'Durata min. clip',             min: 0.70,  max: 1.0,  step: 0.01, format: v => `${Math.round(v*100)}%` },
    { key: 'crossfadeFrames',              label: 'Frame crossfade',              min: 1,     max: 15,   step: 1,    format: v => `${v} fr` },
    { key: 'crf',                          label: 'CRF qualità output',           min: 14,    max: 30,   step: 1,    format: v => String(v) },
  ]

  const toggles = [
    { key: 'enableCrossfade',    label: 'Crossfade tra clip' },
    { key: 'enableInterpolation',label: 'Interpolazione frame (futuro)' },
  ]

  const textFields = [
    { key: 'outputCodec',  label: 'Codec video',   placeholder: 'libx264' },
    { key: 'audioCodec',   label: 'Codec audio',   placeholder: 'aac' },
    { key: 'preset',       label: 'Preset FFmpeg', placeholder: 'medium' },
    { key: 'ffmpegPath',   label: 'Percorso ffmpeg',  placeholder: 'ffmpeg' },
    { key: 'ffprobePath',  label: 'Percorso ffprobe', placeholder: 'ffprobe' },
  ]

  return (
    <div className="p-6 max-w-lg space-y-8">
      <section className="space-y-5">
        <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider flex items-center gap-2">
          <Sliders size={14} /> Parametri analisi
        </h2>
        {sliders.map(s => (
          <SliderRow
            key={s.key}
            label={s.label}
            value={settings[s.key] ?? s.min}
            min={s.min}
            max={s.max}
            step={s.step}
            format={s.format}
            disabled={s.key === 'crossfadeFrames' && !settings.enableCrossfade}
            onChange={v => onUpdate(s.key, v)}
          />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider">Opzioni</h2>
        {toggles.map(t => (
          <ToggleRow
            key={t.key}
            label={t.label}
            checked={!!settings[t.key]}
            onChange={v => onUpdate(t.key, v)}
          />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-[#9090a0] uppercase tracking-wider">Codec & Percorsi</h2>
        {textFields.map(f => (
          <div key={f.key} className="flex items-center gap-3">
            <label className="text-xs text-[#9090a0] w-36 shrink-0">{f.label}</label>
            <input
              type="text"
              value={settings[f.key] || ''}
              placeholder={f.placeholder}
              onChange={e => onUpdate(f.key, e.target.value)}
              className="flex-1 bg-[#12121a] border border-[#2a2a38] rounded px-3 py-1.5 text-sm text-[#f0ede8] font-mono focus:outline-none focus:border-[#c9a84c]/50"
            />
          </div>
        ))}
      </section>
    </div>
  )
}

function SliderRow({ label, value, min, max, step, format, disabled, onChange }) {
  return (
    <div className={clsx('space-y-1.5', disabled && 'opacity-40')}>
      <div className="flex justify-between text-xs">
        <span className="text-[#9090a0]">{label}</span>
        <span className="text-[#c9a84c] font-mono">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-[#c9a84c] cursor-pointer"
      />
    </div>
  )
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-[#f0ede8]">{label}</span>
      <button
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative w-10 h-5 rounded-full transition-colors',
          checked ? 'bg-[#c9a84c]' : 'bg-[#2a2a38]'
        )}
      >
        <span className={clsx(
          'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5'
        )} />
      </button>
    </div>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ progress }) {
  const pct = Math.round((progress.progress || 0) * 100)
  return (
    <div className="px-4 pt-4 pb-2 space-y-1 shrink-0">
      <div className="flex justify-between text-[10px] text-[#9090a0]">
        <span>{STAGE_LABELS[progress.stage] || progress.stage}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 bg-[#1a1a24] rounded-full overflow-hidden">
        <div
          className="h-full bg-[#c9a84c] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Log panel ─────────────────────────────────────────────────────────────────

function LogPanel({ logs, logsEndRef }) {
  return (
    <div className="flex-1 overflow-auto px-4 py-2 font-mono text-[10px] text-[#9090a0] space-y-0.5">
      {logs.length === 0 ? (
        <p className="text-[#555568] italic">Nessun log</p>
      ) : (
        logs.map(l => (
          <div key={l.id} className="leading-relaxed break-words">{l.text}</div>
        ))
      )}
      <div ref={logsEndRef} />
    </div>
  )
}
