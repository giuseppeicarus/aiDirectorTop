import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Clapperboard, Play, ChevronDown, ChevronRight, AlertTriangle,
  Music2, CheckCircle, Loader2, Image as ImageIcon, Zap, RefreshCw, Video,
} from 'lucide-react'
import { useProjectStore } from '../stores/index'
import { API_BASE } from '../utils/apiClient'
import ElegantLoader from '../components/ElegantLoader'

const API = API_BASE

// ── Helpers ───────────────────────────────────────────────────────────────────

function Badge({ label, color = 'text3' }) {
  if (!label) return null
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-mono text-[var(--${color})]`}
          style={{ background: 'var(--bg3)' }}>
      {label}
    </span>
  )
}

/** Convert absolute OS path → URL served by backend frame endpoint */
function frameUrl(projectId, imagePath) {
  if (!imagePath) return null
  const filename = imagePath.replace(/\\/g, '/').split('/').pop()
  return `${API}/projects/${projectId}/frames/${encodeURIComponent(filename)}`
}

// ── FrameBox: shows image + prompt ───────────────────────────────────────────

function FrameBox({ label, prompt, imagePath, projectId }) {
  const [imgError, setImgError] = useState(false)
  const url = projectId ? frameUrl(projectId, imagePath) : null

  return (
    <div className="flex-1 border border-[var(--border)] rounded overflow-hidden" style={{ background: 'var(--bg0)' }}>
      {/* Image preview */}
      <div className="relative bg-[var(--bg0)] border-b border-[var(--border)]" style={{ paddingTop: '56.25%' }}>
        {url && !imgError ? (
          <img
            src={url}
            alt={label}
            onError={() => setImgError(true)}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <ImageIcon size={18} className="text-[var(--border2)]" />
            <span className="text-[9px] text-[var(--text3)] font-mono">
              {imagePath ? 'Caricamento…' : 'Non generato'}
            </span>
          </div>
        )}
        <span className="absolute top-1.5 left-1.5 text-[9px] font-mono px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(0,0,0,0.7)', color: 'var(--gold)' }}>
          {label}
        </span>
      </div>

      {/* Prompt text */}
      {prompt && (
        <p className="text-[10px] text-[var(--text2)] leading-relaxed p-2 line-clamp-3">{prompt}</p>
      )}
    </div>
  )
}

// ── ShotRow ───────────────────────────────────────────────────────────────────

function ShotRow({ shot, index, projectId }) {
  const [open, setOpen] = useState(false)
  const id = shot.shot_id || `shot_${String(index + 1).padStart(3, '0')}`
  const hasFullData = !!(shot.camera?.shot_type)
  const hasLyrics   = !!shot.lyrics_segment
  const hasFrames   = !!(shot.first_frame?.image_path || shot.last_frame?.image_path)

  return (
    <div className="border border-[var(--border)] rounded-lg mb-2 overflow-hidden">
      <button
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-[var(--bg3)] transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown  size={14} className="text-[var(--text3)] shrink-0" />
          : <ChevronRight size={14} className="text-[var(--text3)] shrink-0" />}

        <span className="text-xs font-mono text-[var(--gold)] w-16 shrink-0">{id}</span>

        <span className="flex-1 text-xs text-[var(--text)] truncate">
          {shot.scene_description || shot.emotional_intent || shot.description || '—'}
        </span>

        <div className="flex items-center gap-2 shrink-0">
          {hasLyrics && <Music2 size={11} className="text-[var(--gold)] opacity-80" />}
          {hasFrames && (
            <span className="w-4 h-4 rounded overflow-hidden shrink-0 border border-[var(--border)]">
              <img
                src={frameUrl(projectId, shot.first_frame?.image_path)}
                alt=""
                className="w-full h-full object-cover"
                onError={e => { e.target.style.display = 'none' }}
              />
            </span>
          )}
          {hasFullData && (
            <>
              <Badge label={shot.camera?.shot_type} />
              <Badge label={shot.camera?.movement} />
            </>
          )}
          {shot.emotion && <Badge label={shot.emotion} color="text3" />}
          <span className="text-xs text-[var(--text3)] font-mono">
            {shot.duration_sec ? `${shot.duration_sec}s` : '—'}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-[var(--border)]" style={{ background: 'var(--bg1)' }}>

          {hasLyrics && (
            <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded"
                 style={{ background: 'var(--gold-dim)', borderLeft: '2px solid var(--gold)' }}>
              <Music2 size={12} className="text-[var(--gold)] shrink-0 mt-0.5" />
              <p className="text-xs text-[var(--gold)] italic leading-relaxed">"{shot.lyrics_segment}"</p>
            </div>
          )}

          {/* Frame previews — always shown */}
          <div className="flex gap-3 mb-3">
            <FrameBox
              label="First Frame"
              prompt={shot.first_frame?.prompt}
              imagePath={shot.first_frame?.image_path}
              projectId={projectId}
            />
            <FrameBox
              label="Last Frame"
              prompt={shot.last_frame?.prompt}
              imagePath={shot.last_frame?.image_path}
              projectId={projectId}
            />
          </div>

          {hasFullData && (
            <>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="text-xs">
                  <div className="text-[var(--text3)] mb-1">Camera</div>
                  <div className="text-[var(--text2)] font-mono">{shot.camera?.shot_type} · {shot.camera?.lens_mm}mm</div>
                  <div className="text-[var(--text2)] font-mono">{shot.camera?.movement}</div>
                  {shot.camera?.depth_of_field && (
                    <div className="text-[var(--text3)] font-mono">DoF: {shot.camera.depth_of_field}</div>
                  )}
                </div>
                <div className="text-xs">
                  <div className="text-[var(--text3)] mb-1">Luce</div>
                  <div className="text-[var(--text2)] font-mono">{shot.lighting?.time_of_day}</div>
                  <div className="text-[var(--text2)] font-mono">{shot.lighting?.mood}</div>
                  {shot.lighting?.sources?.length > 0 && (
                    <div className="text-[var(--text3)] font-mono">{shot.lighting.sources.join(', ')}</div>
                  )}
                </div>
                <div className="text-xs">
                  <div className="text-[var(--text3)] mb-1">Transizione</div>
                  <div className="text-[var(--text2)] font-mono">IN: {shot.transition_in || '—'}</div>
                  <div className="text-[var(--text2)] font-mono">OUT: {shot.transition_out || '—'}</div>
                  {shot.time_start && (
                    <div className="text-[var(--text3)] font-mono mt-1">{shot.time_start} → {shot.time_end}</div>
                  )}
                </div>
              </div>

              {shot.characters?.length > 0 && (
                <div className="text-xs mb-3">
                  <div className="text-[var(--text3)] mb-1">Personaggi</div>
                  {shot.characters.map((c, ci) => (
                    <div key={ci} className="text-[var(--text2)] font-mono">
                      {c.name} — {c.action} ({c.position})
                    </div>
                  ))}
                </div>
              )}

              {shot.continuity_notes?.length > 0 && (
                <div className="text-xs mb-3">
                  <div className="text-[var(--text3)] mb-1">Note continuità</div>
                  {shot.continuity_notes.map((n, ni) => (
                    <div key={ni} className="text-[var(--text2)] font-mono">• {n}</div>
                  ))}
                </div>
              )}

              {/* LTX Director Video Generation Prompts */}
              {(shot.ltx_global_prompt || shot.motion_prompt || shot.scene_description) && (
                <div className="mt-3 border border-[var(--border2)] rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 flex items-center gap-2"
                       style={{ background: 'var(--bg3)' }}>
                    <Video size={11} className="text-[var(--blue)]" />
                    <span className="text-[10px] text-[var(--blue)] font-medium uppercase tracking-wider">
                      LTX Director 2.3 — Prompts Generazione Video
                    </span>
                  </div>
                  <div className="divide-y divide-[var(--border)]">
                    {/* Global Prompt */}
                    <div className="px-3 py-2">
                      <div className="text-[9px] text-[var(--text3)] uppercase tracking-wider mb-1 font-mono">
                        global_prompt (stile + atmosfera)
                      </div>
                      <p className="text-[11px] text-[var(--text2)] leading-relaxed font-mono">
                        {shot.ltx_global_prompt || [
                          shot.scene_description,
                          shot.emotion && `Emotional tone: ${shot.emotion}`,
                          shot.location && `Location: ${shot.location}`,
                          shot.lighting && `${shot.lighting.time_of_day} ${shot.lighting.mood}`,
                          shot.camera && `${shot.camera.shot_type} ${shot.camera.movement} ${shot.camera.lens_mm}mm`,
                        ].filter(Boolean).join('. ') || '—'}
                      </p>
                    </div>
                    {/* Segment 1 — intro */}
                    <div className="px-3 py-2">
                      <div className="text-[9px] text-[var(--text3)] uppercase tracking-wider mb-1 font-mono">
                        local_prompt[0] — intro segment
                      </div>
                      <p className="text-[11px] text-[var(--text2)] leading-relaxed font-mono">
                        {[
                          shot.lyrics_segment && `"${shot.lyrics_segment}"`,
                          shot.scene_description,
                          shot.characters?.length > 0 && shot.characters.slice(0, 2).map(c => `${c.name}: ${c.action}`).join(', '),
                        ].filter(Boolean).join('. ') || shot.scene_description || '—'}
                      </p>
                    </div>
                    {/* Segment 2 — motion */}
                    <div className="px-3 py-2">
                      <div className="text-[9px] text-[var(--text3)] uppercase tracking-wider mb-1 font-mono">
                        local_prompt[1] — motion segment
                      </div>
                      <p className="text-[11px] text-[var(--amber)] leading-relaxed font-mono italic">
                        {shot.motion_prompt || (shot.camera && `camera ${shot.camera.movement || 'static'}`) || '—'}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {!hasFullData && (
            <div className="text-xs text-[var(--text3)]">
              <div className="mb-1">Intent: {shot.emotional_intent || '—'}</div>
              {shot.suggested_shot_type && <div>Tipo suggerito: {shot.suggested_shot_type}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── SequenceBlock ─────────────────────────────────────────────────────────────

function SequenceBlock({ seq, index, shotMap, projectId }) {
  const [open, setOpen] = useState(index === 0)

  const shotCount = seq.scenes?.reduce((acc, sc) => {
    const fullShots = shotMap
      ? Object.values(shotMap).filter(s => s.scene_id === sc.id)
      : []
    return acc + (fullShots.length || sc.shots?.length || 0)
  }, 0) || 0

  return (
    <div className="mb-4">
      <button
        className="w-full flex items-center gap-3 p-3 rounded-lg mb-2 text-left"
        style={{ background: 'var(--bg2)' }}
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown  size={14} className="text-[var(--gold)]" />
          : <ChevronRight size={14} className="text-[var(--gold)]" />}
        <span className="font-display text-sm text-[var(--gold)]">{seq.title}</span>
        <Badge label={seq.narrative_role} color="text3" />
        {seq.emotion_arc && (
          <span className="text-[11px] text-[var(--text3)] italic truncate max-w-xs">{seq.emotion_arc}</span>
        )}
        <span className="ml-auto text-xs text-[var(--text3)] font-mono shrink-0">{shotCount} shot</span>
      </button>

      {open && (
        <div className="ml-4">
          {seq.scenes?.map((sc, si) => {
            const fullShots = shotMap
              ? Object.values(shotMap)
                  .filter(s => s.scene_id === sc.id)
                  .sort((a, b) => (a.shot_id || '').localeCompare(b.shot_id || ''))
              : []
            const shots = fullShots.length > 0 ? fullShots : (sc.shots || [])

            return (
              <div key={sc.id || si} className="mb-4">
                <div className="flex items-center gap-2 mb-2 text-xs text-[var(--text2)]">
                  <span className="font-mono text-[var(--text3)]">
                    {sc.id || `scene_${String(si + 1).padStart(3, '0')}`}
                  </span>
                  <span>{sc.title}</span>
                  {sc.location && <span className="text-[var(--text3)]">— {sc.location}</span>}
                  {sc.mood && <Badge label={sc.mood} color="text3" />}
                </div>
                {shots.map((shot, shi) => (
                  <ShotRow key={shot.shot_id || shi} shot={shot} index={shi} projectId={projectId} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Accept Banner ─────────────────────────────────────────────────────────────

function AcceptBanner({ projectId, confirmed, onAccepted }) {
  const navigate  = useNavigate()
  const [loading, setLoading]  = useState(false)
  const [error,   setError]    = useState(null)
  const [done,    setDone]     = useState(confirmed)

  const accept = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`${API}/projects/${projectId}/storyboard/confirm`, { method: 'POST' })
      if (!r.ok) { const j = await r.json(); throw new Error(j.detail || 'Errore conferma') }
      setDone(true)
      onAccepted?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  if (done) {
    return (
      <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-lg border border-[var(--green)]/40 bg-[var(--green)]/8">
        <CheckCircle size={15} className="text-[var(--green)] shrink-0" />
        <div className="flex-1">
          <p className="text-xs text-[var(--green)] font-semibold">Storyboard confermato</p>
          <p className="text-[11px] text-[var(--text3)]">Puoi ora avviare la pipeline di produzione.</p>
        </div>
        <button
          onClick={() => navigate(`/projects/${projectId}/pipeline`)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-mono shrink-0"
          style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
        >
          <Play size={11} /> Avvia Pipeline
        </button>
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-xl border-2 border-[var(--gold)]/50 overflow-hidden">
      {/* Top accent bar */}
      <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, var(--gold), transparent)' }} />

      <div className="px-4 py-4 flex items-start gap-4" style={{ background: 'var(--bg2)' }}>
        <AlertTriangle size={18} className="text-[var(--amber)] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--text)] mb-1">Storyboard generato — in attesa di conferma</p>
          <p className="text-[11px] text-[var(--text3)] leading-relaxed">
            Rivedi le sequenze, gli shot e le anteprime dei frame qui sotto.
            Quando sei soddisfatto, accetta lo storyboard per avviare la produzione.
          </p>
          {error && (
            <p className="text-xs text-[var(--red)] mt-2">{error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => navigate(`/projects/${projectId}/pipeline`)}
            className="px-3 py-2 text-xs rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)] font-mono"
          >
            Pipeline
          </button>
          <button
            onClick={accept}
            disabled={loading}
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded font-mono disabled:opacity-50"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            {loading
              ? <><Loader2 size={12} className="animate-spin" /> Conferma…</>
              : <><CheckCircle size={12} /> Accetta Storyboard</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function StoryboardScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentProject, currentStoryboard, loadProject, loading } = useProjectStore()

  useEffect(() => { if (id) loadProject(id) }, [id])

  const [storyboardState, setStoryboardState] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  // Use store storyboard or locally refreshed one
  const storyboard = storyboardState ?? currentStoryboard

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const r = await fetch(`${API}/projects/${id}/storyboard`)
      if (r.ok) setStoryboardState(await r.json())
    } catch {}
    setRefreshing(false)
  }, [id])

  if (loading) return (
    <div className="h-full flex items-center justify-center bg-[#0a0a0f]">
      <ElegantLoader messages={[
        'Caricamento dello storyboard cinematografico...',
        'Lettura delle sequenze e delle inquadrature...',
        'Verifica dei frame generati txt2img...',
        'Preparazione del report di continuità visiva...'
      ]} />
    </div>
  )

  const shotMap = storyboard?.shot_list?.length
    ? Object.fromEntries(storyboard.shot_list.map(s => [s.shot_id, s]))
    : null

  const shotCount = storyboard?.shot_list?.length
    || storyboard?.story_arc?.sequences?.flatMap(s => s.scenes || []).flatMap(sc => sc.shots || []).length
    || storyboard?.sequences?.flatMap(s => s.scenes || []).flatMap(sc => sc.shots || []).length
    || 0

  const lyricsCount  = storyboard?.shot_list?.filter(s => s.lyrics_segment)?.length || 0
  const framesCount  = storyboard?.shot_list?.filter(s => s.first_frame?.image_path)?.length || 0
  const isConfirmed  = storyboard?._confirmed !== false  // true if confirmed or from DB

  return (
    <div className="p-6 h-full flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Clapperboard size={18} className="text-[var(--gold)]" />
          <div>
            <h1 className="font-display text-xl text-[var(--text)]">
              {currentProject?.title || 'Storyboard'}
            </h1>
            {storyboard && (
              <p className="text-xs text-[var(--text3)] mt-0.5 font-mono">
                {storyboard.story_arc?.sequences?.length || storyboard.sequences?.length || 0} sequenze
                · {shotCount} shot
                {lyricsCount > 0 && ` · ${lyricsCount} con liriche`}
                {framesCount > 0 && (
                  <span className="text-[var(--green)] ml-1">· {framesCount} frame generati</span>
                )}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={refreshing}
            title="Aggiorna storyboard"
            className="p-2 rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)] disabled:opacity-40"
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => navigate(`/projects/${id}/pipeline`)}
            className="flex items-center gap-2 px-4 py-2 text-xs rounded font-mono"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            <Play size={12} />
            {isConfirmed ? 'Pipeline' : 'Vai Pipeline'}
          </button>
        </div>
      </div>

      {/* Accept / status banner */}
      {storyboard && (
        <AcceptBanner
          projectId={id}
          confirmed={isConfirmed}
          onAccepted={refresh}
        />
      )}

      {/* Continuity report */}
      {storyboard?.continuity_report?.total_errors > 0 && (
        <div className="border border-[var(--border)] rounded-lg p-4 mb-5"
             style={{ background: 'var(--bg2)', borderColor: storyboard.continuity_report.approved ? 'var(--green)' : 'var(--amber)' }}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} className={storyboard.continuity_report.approved ? 'text-[var(--green)]' : 'text-[var(--amber)]'} />
            <span className="text-sm font-display" style={{ color: storyboard.continuity_report.approved ? 'var(--green)' : 'var(--amber)' }}>
              Continuità: {storyboard.continuity_report.approved ? 'Approvata' : `${storyboard.continuity_report.critical_count} errori critici`}
            </span>
            <span className="text-xs text-[var(--text3)] font-mono ml-auto">
              {storyboard.continuity_report.total_errors} segnalazioni
            </span>
          </div>
          {storyboard.continuity_report.analysis_summary && (
            <p className="text-[11px] text-[var(--text3)] leading-relaxed">
              {storyboard.continuity_report.analysis_summary.slice(0, 300)}…
            </p>
          )}
        </div>
      )}

      {/* Story analysis */}
      {storyboard?.story_analysis && (
        <div className="border border-[var(--border)] rounded-lg p-4 mb-5" style={{ background: 'var(--bg2)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Zap size={14} className="text-[var(--gold)]" />
            <span className="text-sm font-display text-[var(--gold)]">Analisi Narrativa</span>
          </div>
          <p className="text-xs text-[var(--text2)] mb-2 leading-relaxed">
            {storyboard.story_analysis.narrative_summary}
          </p>
          <div className="flex gap-2 flex-wrap">
            {storyboard.story_analysis.themes?.map(t => <Badge key={t} label={t} />)}
          </div>
        </div>
      )}

      {/* Storyboard content */}
      <div className="flex-1 overflow-y-auto">
        {!storyboard ? (
          <div className="text-center py-16 text-[var(--text3)]">
            <Clapperboard size={48} className="mx-auto mb-4 opacity-20" />
            <p>Nessuno storyboard generato</p>
            <p className="text-xs mt-2">Avvia la pipeline per generarlo</p>
          </div>
        ) : (
          <div>
            {(storyboard.story_arc?.sequences || storyboard.sequences || []).map((seq, i) => (
              <SequenceBlock key={seq.id || i} seq={seq} index={i} shotMap={shotMap} projectId={id} />
            ))}

            {/* Fallback: flat shot list */}
            {!storyboard.story_arc?.sequences && !storyboard.sequences && storyboard.shot_list?.map((shot, i) => (
              <ShotRow key={shot.shot_id || i} shot={shot} index={i} projectId={id} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
