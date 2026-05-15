import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Clapperboard, Play, ChevronDown, ChevronRight, Camera, Clock, Zap } from 'lucide-react'
import { useProjectStore } from '../stores/index'

function Badge({ label, color = 'text3' }) {
  return <span className={`text-xs px-2 py-0.5 rounded font-mono text-[var(--${color})]`} style={{ background: 'var(--bg3)' }}>{label}</span>
}

function FrameBox({ label, prompt }) {
  return (
    <div className="flex-1 border border-[var(--border)] rounded p-3" style={{ background: 'var(--bg0)' }}>
      <div className="text-xs text-[var(--text3)] mb-1 uppercase tracking-wider">{label}</div>
      {prompt
        ? <p className="text-xs text-[var(--text2)] leading-relaxed line-clamp-4">{prompt}</p>
        : <div className="h-16 flex items-center justify-center text-[var(--text3)] text-xs">Non generato</div>}
    </div>
  )
}

function ShotRow({ shot, index }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-[var(--border)] rounded-lg mb-2 overflow-hidden">
      <button className="w-full flex items-center gap-3 p-3 text-left hover:bg-[var(--bg3)] transition-colors"
              onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} className="text-[var(--text3)] shrink-0" /> : <ChevronRight size={14} className="text-[var(--text3)] shrink-0" />}
        <span className="text-xs font-mono text-[var(--gold)] w-16 shrink-0">{shot.shot_id || `shot_${String(index+1).padStart(3,'0')}`}</span>
        <span className="flex-1 text-xs text-[var(--text)] truncate">{shot.scene_description || shot.description || '—'}</span>
        <div className="flex items-center gap-2 shrink-0">
          <Badge label={shot.camera?.shot_type || shot.shot_type || '—'} />
          <Badge label={shot.camera?.movement || shot.camera_movement || '—'} />
          <span className="text-xs text-[var(--text3)] font-mono">{shot.duration_sec}s</span>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-[var(--border)]" style={{ background: 'var(--bg1)' }}>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="text-xs">
              <div className="text-[var(--text3)] mb-1">Camera</div>
              <div className="text-[var(--text2)] font-mono">{shot.camera?.shot_type} • f{shot.camera?.lens_mm}mm</div>
              <div className="text-[var(--text2)] font-mono">{shot.camera?.movement}</div>
            </div>
            <div className="text-xs">
              <div className="text-[var(--text3)] mb-1">Luce</div>
              <div className="text-[var(--text2)] font-mono">{shot.lighting?.time_of_day}</div>
              <div className="text-[var(--text2)] font-mono">{shot.lighting?.mood}</div>
            </div>
            <div className="text-xs">
              <div className="text-[var(--text3)] mb-1">Transizione</div>
              <div className="text-[var(--text2)] font-mono">IN: {shot.transition_in}</div>
              <div className="text-[var(--text2)] font-mono">OUT: {shot.transition_out}</div>
            </div>
          </div>
          {shot.motion_prompt && (
            <div className="text-xs mb-3">
              <div className="text-[var(--text3)] mb-1">Motion prompt</div>
              <div className="text-[var(--text2)] italic">"{shot.motion_prompt}"</div>
            </div>
          )}
          <div className="flex gap-3">
            <FrameBox label="First Frame" prompt={shot.first_frame?.prompt} />
            <FrameBox label="Last Frame"  prompt={shot.last_frame?.prompt} />
          </div>
        </div>
      )}
    </div>
  )
}

function SequenceBlock({ seq, index }) {
  const [open, setOpen] = useState(index === 0)
  const allShots = seq.scenes?.flatMap(sc => sc.shots || []) || []

  return (
    <div className="mb-4">
      <button className="w-full flex items-center gap-3 p-3 rounded-lg mb-2 text-left"
              style={{ background: 'var(--bg2)' }} onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={14} className="text-[var(--gold)]" /> : <ChevronRight size={14} className="text-[var(--gold)]" />}
        <span className="font-display text-sm text-[var(--gold)]">{seq.title}</span>
        <Badge label={seq.narrative_role} color="text3" />
        <span className="ml-auto text-xs text-[var(--text3)] font-mono">{allShots.length} shot</span>
      </button>
      {open && (
        <div className="ml-4">
          {seq.scenes?.map((sc, si) => (
            <div key={sc.id || si} className="mb-4">
              <div className="flex items-center gap-2 mb-2 text-xs text-[var(--text2)]">
                <span className="font-mono text-[var(--text3)]">{sc.id || `scene_${String(si+1).padStart(3,'0')}`}</span>
                <span>{sc.title}</span>
                {sc.location && <span className="text-[var(--text3)]">— {sc.location}</span>}
              </div>
              {sc.shots?.map((shot, shi) => <ShotRow key={shot.shot_id || shi} shot={shot} index={shi} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StoryboardScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentProject, currentStoryboard, loadProject, loading } = useProjectStore()

  useEffect(() => { if (id) loadProject(id) }, [id])

  if (loading) return <div className="p-6 text-[var(--text3)] text-sm animate-pulse">Caricamento storyboard...</div>

  const storyboard = currentStoryboard
  const shotCount = storyboard?.shot_list?.length || storyboard?.sequences?.flatMap(s => s.scenes || []).flatMap(sc => sc.shots || []).length || 0

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Clapperboard size={18} className="text-[var(--gold)]" />
          <div>
            <h1 className="font-display text-xl text-[var(--text)]">{currentProject?.title || 'Storyboard'}</h1>
            {storyboard && (
              <p className="text-xs text-[var(--text3)] mt-0.5 font-mono">
                {storyboard.story_arc?.sequences?.length || 0} sequenze · {shotCount} shot
              </p>
            )}
          </div>
        </div>
        <button onClick={() => navigate(`/projects/${id}/pipeline`)}
                className="flex items-center gap-2 px-4 py-2 text-xs rounded font-mono"
                style={{ background: 'var(--gold)', color: 'var(--bg0)' }}>
          <Play size={12} />
          Avvia Pipeline
        </button>
      </div>

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
            {/* Story analysis summary */}
            {storyboard.story_analysis && (
              <div className="border border-[var(--border)] rounded-lg p-4 mb-5" style={{ background: 'var(--bg2)' }}>
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} className="text-[var(--gold)]" />
                  <span className="text-sm font-display text-[var(--gold)]">Analisi Narrativa</span>
                </div>
                <p className="text-xs text-[var(--text2)] mb-2 leading-relaxed">{storyboard.story_analysis.narrative_summary}</p>
                <div className="flex gap-2 flex-wrap">
                  {storyboard.story_analysis.themes?.map(t => <Badge key={t} label={t} />)}
                </div>
              </div>
            )}

            {/* Sequences */}
            {storyboard.story_arc?.sequences?.map((seq, i) => (
              <SequenceBlock key={seq.id || i} seq={seq} index={i} />
            ))}

            {/* Fallback: flat shot list */}
            {!storyboard.story_arc?.sequences && storyboard.shot_list?.map((shot, i) => (
              <ShotRow key={shot.shot_id || i} shot={shot} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
