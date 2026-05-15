import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, CheckCircle, XCircle, Loader2, Film,
  Camera, Image as ImageIcon, Play, RotateCcw,
  ChevronRight, Sparkles, Zap, AlertTriangle,
} from 'lucide-react'
import clsx from 'clsx'

const BACKEND = 'http://localhost:8765'

// Shot production phases
const PH = {
  PENDING:          0,
  FRAME_GENERATING: 1,
  FRAME_READY:      2,
  FRAME_APPROVED:   3,
  CLIP_GENERATING:  4,
  CLIP_READY:       5,
  DONE:             6,
}

function phaseLabel(ph) {
  return [
    'In attesa',
    'Generando frame…',
    'Frame pronto',
    'Frame approvato',
    'Generando clip…',
    'Clip pronta',
    'Completato',
  ][ph] || '?'
}

function phaseBadgeClass(ph) {
  if (ph === PH.DONE)             return 'bg-green-900/30 text-green-300 border-green-500/20'
  if (ph === PH.FRAME_READY || ph === PH.CLIP_READY)
                                  return 'bg-amber-900/30 text-amber-300 border-amber-500/20'
  if (ph === PH.FRAME_GENERATING || ph === PH.CLIP_GENERATING)
                                  return 'bg-blue-900/30 text-blue-300 border-blue-500/20'
  return 'bg-[var(--bg3)] text-[var(--text3)] border-[var(--border)]'
}

// ── SSE reader ────────────────────────────────────────────────────────────────

async function streamSSE(url, method = 'POST', onEvent, signal) {
  const resp = await fetch(url, { method, signal })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))) } catch {}
      }
    }
  }
}

// ── Shot sidebar item ─────────────────────────────────────────────────────────

function ShotItem({ shot, phase, active, onClick }) {
  const cam = shot.camera || {}
  return (
    <button
      onClick={onClick}
      className={clsx(
        'w-full text-left px-3 py-2.5 rounded-lg border transition-colors',
        active
          ? 'border-[var(--gold)]/60 bg-[var(--gold)]/10'
          : 'border-[var(--border)] hover:border-[var(--gold)]/30 hover:bg-[var(--bg3)]'
      )}
    >
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono text-[var(--text3)] w-5 shrink-0">
          {shot.shot_id?.split('_').slice(-1)[0] || '?'}
        </span>
        <span className="text-[11px] text-[var(--text)] flex-1 truncate font-medium">
          {shot.shot_id || shot.id}
        </span>
        {phase === PH.DONE
          ? <CheckCircle size={11} className="text-green-400 shrink-0" />
          : phase === PH.FRAME_GENERATING || phase === PH.CLIP_GENERATING
            ? <Loader2 size={11} className="animate-spin text-blue-400 shrink-0" />
            : null
        }
      </div>
      <div className="flex items-center gap-2 mt-0.5 ml-5">
        {cam.shot_type && (
          <span className="text-[9px] font-mono text-[var(--text3)]">{cam.shot_type}</span>
        )}
        {shot.duration_sec && (
          <span className="text-[9px] font-mono text-[var(--text3)]">{shot.duration_sec}s</span>
        )}
        <span className={clsx('text-[9px] px-1.5 py-px rounded border font-mono ml-auto', phaseBadgeClass(phase))}>
          {phaseLabel(phase)}
        </span>
      </div>
    </button>
  )
}

// ── Frame section ─────────────────────────────────────────────────────────────

function FrameSection({ projectId, shot, phase, messages, onGenerate, onApprove, onRegen }) {
  const frameUrl = `${BACKEND}/api/pipeline/${projectId}/frames/${shot.shot_id}_first.png`
  const generating = phase === PH.FRAME_GENERATING

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-4">
      <div className="flex items-center gap-2 mb-3">
        <ImageIcon size={14} className="text-[var(--text2)]" />
        <span className="text-xs font-semibold text-[var(--text)]">Prima Immagine</span>
        {phase >= PH.FRAME_APPROVED && (
          <span className="ml-auto text-[10px] text-green-400 flex items-center gap-1">
            <CheckCircle size={10} /> Approvata
          </span>
        )}
      </div>

      {phase === PH.PENDING && (
        <button
          onClick={onGenerate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
        >
          <Sparkles size={13} /> Genera Prima Immagine
        </button>
      )}

      {generating && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-blue-300">
            <Loader2 size={13} className="animate-spin" />
            <span>Generazione in corso…</span>
          </div>
          {messages.map((m, i) => (
            <p key={i} className="text-[10px] text-[var(--text3)] font-mono pl-5">{m}</p>
          ))}
        </div>
      )}

      {(phase === PH.FRAME_READY || phase >= PH.FRAME_APPROVED) && (
        <div className="space-y-3">
          <img
            src={frameUrl}
            alt="First frame"
            className="w-full rounded-lg border border-[var(--border)] object-cover"
            style={{ maxHeight: 280 }}
          />
          {phase === PH.FRAME_READY && (
            <div className="flex gap-2">
              <button
                onClick={onApprove}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600/20 hover:bg-green-600/30 border border-green-500/30 text-green-300 transition-colors"
              >
                <CheckCircle size={12} /> Approva
              </button>
              <button
                onClick={onRegen}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] transition-colors"
              >
                <RotateCcw size={12} /> Rigenera
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Clip section ──────────────────────────────────────────────────────────────

function ClipSection({ projectId, shot, phase, messages, onGenerate, onApprove, onRegen }) {
  const clipUrl = `${BACKEND}/api/pipeline/${projectId}/clips/${shot.shot_id}.mp4`
  const generating = phase === PH.CLIP_GENERATING
  const enabled = phase >= PH.FRAME_APPROVED

  return (
    <div className={clsx(
      'rounded-xl border p-4 transition-colors',
      enabled ? 'border-[var(--border)] bg-[var(--bg2)]' : 'border-[var(--border)]/30 bg-[var(--bg2)]/40 opacity-50'
    )}>
      <div className="flex items-center gap-2 mb-3">
        <Film size={14} className="text-[var(--text2)]" />
        <span className="text-xs font-semibold text-[var(--text)]">Clip Video</span>
        {phase === PH.DONE && (
          <span className="ml-auto text-[10px] text-green-400 flex items-center gap-1">
            <CheckCircle size={10} /> Approvata
          </span>
        )}
      </div>

      {phase === PH.FRAME_APPROVED && (
        <button
          onClick={onGenerate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
        >
          <Play size={13} /> Genera Clip Video
        </button>
      )}

      {generating && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-blue-300">
            <Loader2 size={13} className="animate-spin" />
            <span>Generazione video in corso…</span>
          </div>
          {messages.map((m, i) => (
            <p key={i} className="text-[10px] text-[var(--text3)] font-mono pl-5">{m}</p>
          ))}
        </div>
      )}

      {(phase === PH.CLIP_READY || phase === PH.DONE) && (
        <div className="space-y-3">
          <video
            src={clipUrl}
            controls
            className="w-full rounded-lg border border-[var(--border)]"
            style={{ maxHeight: 240 }}
          />
          {phase === PH.CLIP_READY && (
            <div className="flex gap-2">
              <button
                onClick={onApprove}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600/20 hover:bg-green-600/30 border border-green-500/30 text-green-300 transition-colors"
              >
                <CheckCircle size={12} /> Approva Clip
              </button>
              <button
                onClick={onRegen}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] transition-colors"
              >
                <RotateCcw size={12} /> Rigenera
              </button>
            </div>
          )}
        </div>
      )}

      {!enabled && phase < PH.FRAME_APPROVED && (
        <p className="text-[11px] text-[var(--text3)]">Approva prima la prima immagine</p>
      )}
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function CopilotScreen() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [shots,            setShots]           = useState([])
  const [shotStates,       setShotStates]       = useState({})  // shotId → { phase, msgs }
  const [currentIdx,       setCurrentIdx]       = useState(0)
  const [loading,          setLoading]          = useState(true)
  const [assembling,       setAssembling]       = useState(false)
  const [assembleMessages, setAssembleMessages] = useState([])
  const [finalVideoPath,   setFinalVideoPath]   = useState(null)
  const [error,            setError]            = useState(null)

  const abortRef = useRef(null)

  // Load shots from pipeline state
  useEffect(() => {
    setLoading(true)
    window.studio.pipeline.state(id)
      .then(data => {
        const list = data?.data?.shot_list || []
        setShots(list)

        // Init shot states — check backend shot_states for already-done items
        const backendStates = data?.shot_states || {}
        const init = {}
        for (const shot of list) {
          const sid = shot.shot_id || shot.id
          const bs  = backendStates[sid] || {}
          let phase = PH.PENDING
          if (bs.clip_done)  phase = PH.DONE
          else if (bs.frame_done) phase = PH.FRAME_APPROVED
          init[sid] = { phase, msgs: [] }
        }
        setShotStates(init)
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })

    return () => abortRef.current?.abort()
  }, [id])

  function updateShotPhase(shotId, phase) {
    setShotStates(s => ({ ...s, [shotId]: { ...s[shotId], phase } }))
  }

  function addShotMsg(shotId, msg) {
    setShotStates(s => ({
      ...s,
      [shotId]: { ...s[shotId], msgs: [...(s[shotId]?.msgs || []).slice(-20), msg] },
    }))
  }

  async function handleGenFrame(shotId) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    updateShotPhase(shotId, PH.FRAME_GENERATING)
    setShotStates(s => ({ ...s, [shotId]: { ...s[shotId], phase: PH.FRAME_GENERATING, msgs: [] } }))

    try {
      await streamSSE(
        `${BACKEND}/api/pipeline/${id}/copilot/frame/${shotId}`,
        'POST',
        (data) => {
          if (data.message) addShotMsg(shotId, data.message)
          if (data.done)    updateShotPhase(shotId, PH.FRAME_READY)
          if (data.error)   { updateShotPhase(shotId, PH.PENDING); setError(data.error) }
        },
        ctrl.signal,
      )
    } catch (e) {
      if (e.name !== 'AbortError') {
        updateShotPhase(shotId, PH.PENDING)
        setError(e.message)
      }
    }
  }

  async function handleGenClip(shotId) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    updateShotPhase(shotId, PH.CLIP_GENERATING)
    setShotStates(s => ({ ...s, [shotId]: { ...s[shotId], phase: PH.CLIP_GENERATING, msgs: [] } }))

    try {
      await streamSSE(
        `${BACKEND}/api/pipeline/${id}/copilot/clip/${shotId}`,
        'POST',
        (data) => {
          if (data.message) addShotMsg(shotId, data.message)
          if (data.done)    updateShotPhase(shotId, PH.CLIP_READY)
          if (data.error)   { updateShotPhase(shotId, PH.FRAME_APPROVED); setError(data.error) }
        },
        ctrl.signal,
      )
    } catch (e) {
      if (e.name !== 'AbortError') {
        updateShotPhase(shotId, PH.FRAME_APPROVED)
        setError(e.message)
      }
    }
  }

  function handleApproveFrame(shotId) {
    updateShotPhase(shotId, PH.FRAME_APPROVED)
  }

  function handleApproveClip(shotId) {
    updateShotPhase(shotId, PH.DONE)
    // Auto-advance to next non-done shot
    const nextIdx = shots.findIndex((s, i) =>
      i > currentIdx && (shotStates[s.shot_id || s.id]?.phase || PH.PENDING) < PH.DONE
    )
    if (nextIdx !== -1) setCurrentIdx(nextIdx)
  }

  async function handleAssemble() {
    setAssembling(true)
    setAssembleMessages([])
    setFinalVideoPath(null)
    setError(null)

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      await streamSSE(
        `${BACKEND}/api/pipeline/${id}/copilot/assemble`,
        'POST',
        (data) => {
          if (data.message)      setAssembleMessages(m => [...m.slice(-30), data.message])
          if (data.artifact_path) setFinalVideoPath(data.artifact_path)
          if (data.error)        setError(data.error)
          if (data.done)         setAssembling(false)
        },
        ctrl.signal,
      )
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
      setAssembling(false)
    }
  }

  const currentShot   = shots[currentIdx]
  const currentShotId = currentShot?.shot_id || currentShot?.id
  const currentState  = shotStates[currentShotId] || { phase: PH.PENDING, msgs: [] }
  const allDone       = shots.length > 0 && shots.every(s => (shotStates[s.shot_id || s.id]?.phase || 0) === PH.DONE)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={24} className="animate-spin text-[var(--text3)]" />
      </div>
    )
  }

  if (shots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <AlertTriangle size={32} className="text-amber-400" />
        <p className="text-sm text-[var(--text2)]">Nessun shot trovato</p>
        <p className="text-xs text-[var(--text3)]">Esegui prima lo storyboard dalla schermata Pipeline.</p>
        <button
          onClick={() => navigate(`/projects/${id}/pipeline`)}
          className="mt-2 flex items-center gap-2 px-4 py-2 rounded-lg text-xs border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] transition-colors"
        >
          <ArrowLeft size={13} /> Vai alla Pipeline
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Shot sidebar ── */}
      <aside className="w-72 shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--bg1)]">
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center gap-2">
          <button
            onClick={() => navigate(`/projects/${id}/pipeline`)}
            className="text-[var(--text3)] hover:text-[var(--gold)] transition-colors"
          >
            <ArrowLeft size={15} />
          </button>
          <span className="text-sm font-semibold text-[var(--text)]">Copilot</span>
          <span className="ml-auto text-[10px] font-mono text-[var(--text3)]">
            {shots.filter(s => (shotStates[s.shot_id||s.id]?.phase||0) === PH.DONE).length}/{shots.length} shot
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {shots.map((shot, i) => {
            const sid = shot.shot_id || shot.id
            return (
              <ShotItem
                key={sid}
                shot={shot}
                phase={shotStates[sid]?.phase || PH.PENDING}
                active={i === currentIdx}
                onClick={() => setCurrentIdx(i)}
              />
            )
          })}
        </div>

        {/* Assemble button */}
        <div className="p-3 border-t border-[var(--border)]">
          {finalVideoPath ? (
            <div className="px-3 py-2 rounded-lg border border-green-500/30 bg-green-900/10">
              <div className="flex items-center gap-1.5 text-green-400 mb-1">
                <Film size={12} />
                <span className="text-[11px] font-semibold">Video finale pronto!</span>
              </div>
              <p className="text-[9px] text-[var(--text3)] font-mono break-all">{finalVideoPath}</p>
            </div>
          ) : (
            <button
              onClick={handleAssemble}
              disabled={!allDone || assembling}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-colors',
                allDone && !assembling
                  ? 'text-[var(--bg0)] cursor-pointer'
                  : 'border border-[var(--border)] text-[var(--text3)] cursor-not-allowed opacity-50'
              )}
              style={allDone && !assembling ? { background: 'var(--gold)' } : {}}
            >
              {assembling
                ? <><Loader2 size={13} className="animate-spin" /> Assemblaggio…</>
                : <><Zap size={13} /> Assembla Video Finale</>
              }
            </button>
          )}
          {assembleMessages.length > 0 && (
            <div className="mt-2 space-y-0.5 max-h-20 overflow-y-auto">
              {assembleMessages.map((m, i) => (
                <p key={i} className="text-[9px] font-mono text-[var(--text3)]">{m}</p>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── Shot detail panel ── */}
      <main className="flex-1 overflow-y-auto p-5">
        {error && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-900/10 text-red-300 text-xs mb-4">
            <XCircle size={14} />
            {error}
            <button onClick={() => setError(null)} className="ml-auto text-[var(--text3)] hover:text-red-300">✕</button>
          </div>
        )}

        {/* Shot navigation */}
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={() => setCurrentIdx(i => Math.max(0, i - 1))}
            disabled={currentIdx === 0}
            className="p-1.5 rounded border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] disabled:opacity-30 transition-colors"
          >
            <ArrowLeft size={13} />
          </button>
          <div className="flex-1">
            <p className="text-[10px] text-[var(--text3)] font-mono">
              Shot {currentIdx + 1} / {shots.length}
            </p>
            <h2 className="text-sm font-semibold text-[var(--text)]">
              {currentShotId}
            </h2>
          </div>
          <button
            onClick={() => setCurrentIdx(i => Math.min(shots.length - 1, i + 1))}
            disabled={currentIdx === shots.length - 1}
            className="p-1.5 rounded border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] disabled:opacity-30 transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </div>

        {currentShot && (
          <div className="space-y-4 max-w-2xl">
            {/* Shot details */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-4">
              <div className="flex items-center gap-2 mb-3">
                <Camera size={14} className="text-[var(--text2)]" />
                <span className="text-xs font-semibold text-[var(--text)]">Dettagli Shot</span>
                <span className={clsx('ml-auto text-[10px] px-2 py-0.5 rounded border font-mono', phaseBadgeClass(currentState.phase))}>
                  {phaseLabel(currentState.phase)}
                </span>
              </div>

              {currentShot.scene_description && (
                <p className="text-[11px] text-[var(--text2)] leading-relaxed mb-3">
                  {currentShot.scene_description}
                </p>
              )}

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                {currentShot.camera?.shot_type && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Shot type</span>
                    <span className="text-[var(--text2)] font-mono">{currentShot.camera.shot_type}</span>
                  </div>
                )}
                {currentShot.camera?.movement && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Movimento</span>
                    <span className="text-[var(--text2)] font-mono">{currentShot.camera.movement}</span>
                  </div>
                )}
                {currentShot.camera?.lens_mm && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Obiettivo</span>
                    <span className="text-[var(--text2)] font-mono">{currentShot.camera.lens_mm}mm</span>
                  </div>
                )}
                {currentShot.emotion && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Emozione</span>
                    <span className="text-[var(--text2)]">{currentShot.emotion}</span>
                  </div>
                )}
                {currentShot.transition_in && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Transizione</span>
                    <span className="text-[var(--text2)] font-mono">{currentShot.transition_in}</span>
                  </div>
                )}
                {currentShot.duration_sec && (
                  <div className="flex gap-1.5">
                    <span className="text-[var(--text3)] w-20 shrink-0">Durata</span>
                    <span className="text-[var(--text2)] font-mono">{currentShot.duration_sec}s</span>
                  </div>
                )}
              </div>

              {currentShot.first_frame?.prompt && (
                <div className="mt-3 pt-3 border-t border-[var(--border)]">
                  <p className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Prompt immagine</p>
                  <p className="text-[11px] text-[var(--text2)] leading-relaxed font-mono">
                    {currentShot.first_frame.prompt}
                  </p>
                </div>
              )}

              {currentShot.motion_prompt && (
                <div className="mt-2">
                  <p className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Motion prompt</p>
                  <p className="text-[11px] text-[var(--text2)] italic">{currentShot.motion_prompt}</p>
                </div>
              )}
            </div>

            {/* Frame generation */}
            <FrameSection
              projectId={id}
              shot={currentShot}
              phase={currentState.phase}
              messages={currentState.msgs}
              onGenerate={() => handleGenFrame(currentShotId)}
              onApprove={() => handleApproveFrame(currentShotId)}
              onRegen={() => handleGenFrame(currentShotId)}
            />

            {/* Clip generation */}
            <ClipSection
              projectId={id}
              shot={currentShot}
              phase={currentState.phase}
              messages={currentState.msgs}
              onGenerate={() => handleGenClip(currentShotId)}
              onApprove={() => handleApproveClip(currentShotId)}
              onRegen={() => handleGenClip(currentShotId)}
            />
          </div>
        )}
      </main>
    </div>
  )
}
