import { useEffect, useRef, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Play, RotateCcw, CheckCircle, XCircle, Loader2, Film,
  ChevronDown, ChevronUp, Cpu, BookOpen, Clapperboard, Camera,
  PenLine, ClipboardCheck, ArrowRight, Sparkles, AlertTriangle,
  Zap, ListVideo, Eye, EyeOff, Palette, Hash, Clock,
  Users, ArrowUpRight, Square, Pause,
} from 'lucide-react'
import { usePipelineStore, useProjectStore } from '../stores/index'
import clsx from 'clsx'
import { BACKEND_ORIGIN, pipelineFrameUrl } from '../utils/mediaUrl'
import { useMediaReconcile } from '../hooks/useMediaReconcile'

// ── Stage metadata ────────────────────────────────────────────────────────────

const STAGE_META = [
  { key: 'story_analysis',    label: 'Analisi narrativa',    Icon: BookOpen,       color: '#a78bfa' },
  { key: 'narrative_arc',     label: 'Arco narrativo',        Icon: Clapperboard,   color: '#60a5fa' },
  { key: 'shot_list',         label: 'Shot list',             Icon: Camera,         color: '#34d399' },
  { key: 'prompt_generation', label: 'Prompt visivi',         Icon: PenLine,        color: '#f59e0b' },
  { key: 'continuity_check',  label: 'Continuità',            Icon: ClipboardCheck, color: '#f87171' },
  { key: 'frame_gen',         label: 'Frame generation',      Icon: Sparkles,       color: '#c9a84c' },
  { key: 'video_gen',         label: 'Video generation',      Icon: Film,           color: '#c9a84c' },
  { key: 'assembly',          label: 'Assemblaggio FFmpeg',   Icon: Zap,            color: '#c9a84c' },
]

const STAGES = STAGE_META.map(s => s.key)

const ROLE_ICONS = {
  story_analyst:      BookOpen,
  narrative_director: Clapperboard,
  cinematographer:    Camera,
  prompt_engineer:    PenLine,
  continuity_checker: ClipboardCheck,
}

// ── Left panel: stage list ────────────────────────────────────────────────────

function StageList({ currentStage, completedStages }) {
  const currentIdx = STAGES.indexOf(currentStage)
  const isDone = currentStage === 'done'

  return (
    <div className="space-y-0.5">
      {STAGE_META.map((meta, idx) => {
        const fromState = completedStages.includes(meta.key)
        const done   = fromState || (!isDone && currentIdx > idx)
        const active = meta.key === currentStage
        const { Icon } = meta

        return (
          <div key={meta.key} className={clsx(
            'flex items-center gap-2.5 px-2 py-1.5 rounded text-xs transition-colors',
            done   ? 'text-[var(--text2)]' :
            active ? 'text-[var(--gold)] bg-[var(--gold)]/5' :
                     'text-[var(--text3)]'
          )}>
            <div className="w-4 h-4 flex items-center justify-center shrink-0">
              {done   ? <CheckCircle size={13} className="text-[var(--green)]" /> :
               active ? <Loader2 size={13} className="animate-spin" style={{ color: meta.color }} /> :
                        <Icon size={12} className="opacity-40" />}
            </div>
            <span className={active ? 'font-medium' : ''}>{meta.label}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Event cards (Feed tab) ────────────────────────────────────────────────────

function LlmPromptCard({ evt }) {
  const [expanded, setExpanded] = useState(false)
  const { extra } = evt
  const Icon = ROLE_ICONS[extra.role] || Cpu

  return (
    <div className="rounded-lg border border-[var(--gold)]/30 bg-[var(--gold)]/5 overflow-hidden">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5"
             style={{ background: 'rgba(201,168,76,0.15)' }}>
          <Icon size={14} className="text-[var(--gold)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-[var(--gold)]">{extra.label || 'LLM'}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-[var(--bg3)] text-[var(--text3)]">
              {extra.provider}/{extra.model}
            </span>
            <span className="text-[10px] text-[var(--text3)] ml-auto">{evt.time}</span>
          </div>
          {extra.description && (
            <p className="text-[11px] text-[var(--text2)] mt-0.5 leading-snug">{extra.description}</p>
          )}
          {extra.input_themes?.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {extra.input_themes.map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--text3)] font-mono">{t}</span>
              ))}
            </div>
          )}
        </div>
        {extra.prompt_preview && (
          <button onClick={() => setExpanded(v => !v)} className="text-[var(--text3)] hover:text-[var(--gold)] shrink-0 mt-0.5">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>
      {expanded && extra.prompt_preview && (
        <div className="px-3 pb-3 border-t border-[var(--gold)]/10">
          <p className="text-[10px] text-[var(--text3)] mb-1 mt-2">Prompt inviato:</p>
          <pre className="text-[10px] text-[var(--text2)] font-mono leading-relaxed whitespace-pre-wrap break-all bg-[var(--bg0)] rounded p-2 max-h-40 overflow-y-auto">
            {extra.prompt_preview}
          </pre>
        </div>
      )}
    </div>
  )
}

function LlmThinkingCard({ evt }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg2)]">
      <div className="flex gap-0.5 shrink-0">
        {[0, 1, 2].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--gold)]"
               style={{ animation: `dotPulse 1.2s ease-in-out ${i * 0.2}s infinite` }} />
        ))}
      </div>
      <span className="text-xs text-[var(--text2)] flex-1">{evt.message}</span>
      <span className="text-[10px] text-[var(--text3)] font-mono shrink-0">{evt.time}</span>
    </div>
  )
}

function LlmOutputCard({ evt }) {
  const [expanded, setExpanded] = useState(false)
  const { extra } = evt
  const isError = extra.approved === false

  const pills = []
  if (extra.themes?.length)              pills.push({ label: 'temi',       val: extra.themes.slice(0,4).join(', ') })
  if (extra.narrative_summary)           pills.push({ label: 'storia',     val: extra.narrative_summary.slice(0,160) })
  if (extra.sequences !== undefined)     pills.push({ label: 'sequenze',   val: extra.sequences })
  if (extra.total_scenes !== undefined)  pills.push({ label: 'scene',      val: extra.total_scenes })
  if (extra.planned_shots !== undefined) pills.push({ label: 'shot plan.', val: extra.planned_shots })
  if (extra.shot_count !== undefined)    pills.push({ label: 'shot',       val: extra.shot_count })
  if (extra.logline)                     pills.push({ label: 'logline',    val: extra.logline.slice(0,160) })
  if (extra.prompts_generated !== undefined) pills.push({ label: 'prompt', val: extra.prompts_generated })
  if (extra.errors !== undefined)        pills.push({ label: 'errori',     val: extra.errors })
  if (extra.critical !== undefined && extra.critical > 0) pills.push({ label: 'critici', val: extra.critical })

  return (
    <div className={clsx(
      'rounded-lg border overflow-hidden',
      isError ? 'border-amber-500/30 bg-amber-500/5' : 'border-[var(--green)]/30 bg-[var(--green)]/5'
    )}>
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className={clsx('shrink-0 mt-0.5', isError ? 'text-amber-400' : 'text-[var(--green)]')}>
          {isError ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx('text-xs font-semibold', isError ? 'text-amber-400' : 'text-[var(--green)]')}>
              {evt.message}
            </span>
            <span className="text-[10px] text-[var(--text3)] ml-auto">{evt.time}</span>
          </div>
          {pills.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {pills.slice(0, 4).map(p => (
                <div key={p.label} className="flex gap-1.5 items-start">
                  <span className="text-[10px] text-[var(--text3)] font-mono shrink-0 mt-0.5 w-16 truncate">{p.label}</span>
                  <span className="text-[11px] text-[var(--text2)] leading-snug">{String(p.val)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {Object.keys(extra).length > 2 && (
          <button onClick={() => setExpanded(v => !v)} className="text-[var(--text3)] hover:text-[var(--green)] shrink-0 mt-0.5">
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-[var(--green)]/10">
          <pre className="text-[10px] text-[var(--text2)] font-mono leading-relaxed whitespace-pre-wrap break-all bg-[var(--bg0)] rounded p-2 max-h-52 overflow-y-auto mt-2">
            {JSON.stringify(extra, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function StageCompleteCard({ evt }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <div className="flex-1 h-px bg-[var(--green)]/20" />
      <CheckCircle size={11} className="text-[var(--green)] shrink-0" />
      <span className="text-[10px] text-[var(--green)] font-mono">{evt.message}</span>
      <div className="flex-1 h-px bg-[var(--green)]/20" />
    </div>
  )
}

function ProgressCard({ evt }) {
  return (
    <div className="flex items-center gap-2 px-1 py-0.5">
      <span className="text-[10px] text-[var(--text3)] font-mono shrink-0 w-16">{evt.time}</span>
      <ArrowRight size={10} className="text-[var(--text3)] shrink-0" />
      <span className="text-[11px] text-[var(--text2)] leading-snug">{evt.message}</span>
    </div>
  )
}

function EventCard({ evt }) {
  switch (evt.event_type) {
    case 'llm_prompt':    return <LlmPromptCard evt={evt} />
    case 'llm_thinking':  return <LlmThinkingCard evt={evt} />
    case 'llm_output':    return <LlmOutputCard evt={evt} />
    case 'stage_complete': return <StageCompleteCard evt={evt} />
    default:              return <ProgressCard evt={evt} />
  }
}

function ActiveLLMBanner({ llm }) {
  if (!llm) return null
  const Icon = ROLE_ICONS[llm.role] || Cpu
  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-[var(--gold)]/40 bg-[var(--gold)]/8 mb-3">
      <div className="flex gap-0.5">
        {[0,1,2].map(i => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--gold)]"
               style={{ animation: `dotPulse 1.2s ${i*0.2}s infinite` }} />
        ))}
      </div>
      <Icon size={13} className="text-[var(--gold)] shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-xs text-[var(--gold)] font-medium">{llm.label}</span>
        <span className="text-[10px] text-[var(--text3)] ml-2 font-mono">{llm.provider}/{llm.model}</span>
      </div>
      <Loader2 size={12} className="animate-spin text-[var(--gold)] shrink-0" />
    </div>
  )
}

// ── Results tab: structured narrative data ────────────────────────────────────

function Tags({ items, color = 'text-[var(--text2)]' }) {
  if (!items?.length) return null
  return (
    <div className="flex gap-1 flex-wrap mt-1">
      {items.map((t, i) => (
        <span key={i} className={clsx('text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] border border-[var(--border)] font-mono', color)}>
          {String(t)}
        </span>
      ))}
    </div>
  )
}

function SectionCard({ title, icon: Icon, color, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-[var(--bg3)] transition-colors"
      >
        <Icon size={14} style={{ color }} />
        <span className="text-xs font-semibold text-[var(--text)] flex-1 text-left">{title}</span>
        {open ? <ChevronUp size={13} className="text-[var(--text3)]" /> : <ChevronDown size={13} className="text-[var(--text3)]" />}
      </button>
      {open && <div className="px-3 pb-3 border-t border-[var(--border)]">{children}</div>}
    </div>
  )
}

function StoryAnalysisResult({ data }) {
  if (!data) return null
  return (
    <SectionCard title="Analisi Narrativa" icon={BookOpen} color="#a78bfa">
      {data.narrative_summary && (
        <p className="text-[11px] text-[var(--text2)] leading-relaxed mt-2">{data.narrative_summary}</p>
      )}
      {data.themes?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Temi</span>
          <Tags items={data.themes} />
        </div>
      )}
      {data.visual_metaphors?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Metafore visive</span>
          <Tags items={data.visual_metaphors} color="text-purple-300" />
        </div>
      )}
      {data.emotion_progression?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Progressione emotiva</span>
          <div className="flex gap-1 mt-1 flex-wrap">
            {data.emotion_progression.map((e, i) => (
              <div key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-purple-900/30 border border-purple-500/20 text-purple-300 font-mono">
                {typeof e === 'object' ? (e.emotion || e.label || JSON.stringify(e)) : e}
              </div>
            ))}
          </div>
        </div>
      )}
      {data.color_mood && (
        <div className="mt-2 flex items-center gap-2">
          <Palette size={11} className="text-[var(--text3)]" />
          <span className="text-[11px] text-[var(--text2)]">{data.color_mood}</span>
        </div>
      )}
      {data.pacing_notes && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Pacing narrativo</span>
          <p className="text-[11px] text-[var(--text2)] leading-relaxed mt-1">{data.pacing_notes}</p>
        </div>
      )}
      {data.lyric_beats?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Analisi lirica ({data.lyric_beats.length} beat)</span>
          <div className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
            {data.lyric_beats.map((b, i) => (
              <div key={i} className="flex gap-2 text-[10px] px-2 py-1 rounded bg-[var(--bg3)]">
                <span className="text-purple-400 font-mono shrink-0">{b.time_sec != null ? `${b.time_sec}s` : ''}</span>
                <span className="text-[var(--text3)] shrink-0">{b.emotion}</span>
                <span className="text-[var(--text2)] italic truncate">"{b.lyric_line}"</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.audio_timing?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Timing audio ({data.audio_timing.length} sezioni)</span>
          <div className="mt-1 flex gap-1.5 flex-wrap">
            {data.audio_timing.map((a, i) => (
              <div key={i} className="text-[10px] px-2 py-1 rounded border border-[var(--border)] bg-[var(--bg3)] font-mono">
                <span className="text-[var(--gold)]">{a.section_start}s-{a.section_end}s</span>
                <span className="text-[var(--text3)] ml-1">{a.energy}</span>
                {a.suggested_shot_duration_sec && <span className="text-[var(--text2)] ml-1">~{a.suggested_shot_duration_sec}s/shot</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function NarrativeArcResult({ data }) {
  if (!data) return null
  return (
    <SectionCard title="Arco Narrativo" icon={Clapperboard} color="#60a5fa">
      {data.logline && (
        <p className="text-[11px] text-[var(--text2)] italic leading-relaxed mt-2 border-l-2 border-blue-400/40 pl-2">
          "{data.logline}"
        </p>
      )}
      {data.visual_motifs?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Motivi visivi</span>
          <Tags items={data.visual_motifs} color="text-blue-300" />
        </div>
      )}
      {data.color_palette?.length > 0 && (
        <div className="mt-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Palette</span>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            {data.color_palette.map((c, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 rounded-full border border-[var(--border)]"
                     style={{ background: c.startsWith('#') ? c : `var(--text3)` }} />
                <span className="text-[10px] font-mono text-[var(--text3)]">{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {data.sequences?.length > 0 && (
        <div className="mt-3 space-y-2">
          <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">{data.sequences.length} Sequenze</span>
          {data.sequences.map((seq, i) => (
            <SequenceRow key={i} seq={seq} idx={i} />
          ))}
        </div>
      )}
    </SectionCard>
  )
}

function SequenceRow({ seq, idx }) {
  const [open, setOpen] = useState(false)
  const sceneCount = seq.scenes?.length || 0
  const shotCount  = seq.scenes?.reduce((a, s) => a + (s.shots?.length || 0), 0) || 0
  return (
    <div className="rounded border border-[var(--border)] overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-2 bg-[var(--bg3)] hover:bg-[var(--bg3)]/80 text-left"
      >
        <span className="text-[10px] font-mono text-[var(--text3)] w-5 shrink-0">{idx + 1}</span>
        <span className="text-[11px] text-[var(--text)] flex-1 font-medium">{seq.title || seq.id}</span>
        {seq.narrative_role && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/30 text-blue-300 border border-blue-500/20 font-mono shrink-0">
            {seq.narrative_role}
          </span>
        )}
        <span className="text-[10px] text-[var(--text3)] font-mono ml-1 shrink-0">{sceneCount}sc / {shotCount}sh</span>
        {open ? <ChevronUp size={11} className="text-[var(--text3)]" /> : <ChevronDown size={11} className="text-[var(--text3)]" />}
      </button>
      {open && seq.scenes?.length > 0 && (
        <div className="divide-y divide-[var(--border)]">
          {seq.scenes.map((sc, j) => (
            <div key={j} className="px-3 py-2 text-[10px]">
              <div className="flex items-center gap-2">
                <span className="text-[var(--text3)] font-mono w-5">{j+1}</span>
                <span className="text-[var(--text)] font-medium">{sc.title || sc.id}</span>
                {sc.location && <span className="text-[var(--text3)] ml-1">· {sc.location}</span>}
                <span className="ml-auto text-[var(--text3)] font-mono">{sc.shots?.length || 0} shot</span>
              </div>
              {sc.mood && <p className="text-[var(--text3)] mt-0.5 ml-7">{sc.mood}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ShotListResult({ shots }) {
  const [showAll, setShowAll] = useState(false)
  if (!shots?.length) return null
  const visible = showAll ? shots : shots.slice(0, 12)

  return (
    <SectionCard title={`Shot List — ${shots.length} inquadrature`} icon={Camera} color="#34d399" defaultOpen={true}>
      <div className="mt-2 space-y-1">
        {visible.map((shot, i) => (
          <ShotRow key={i} shot={shot} idx={i} />
        ))}
        {shots.length > 12 && (
          <button
            onClick={() => setShowAll(v => !v)}
            className="w-full py-1.5 text-[10px] text-[var(--text3)] hover:text-[var(--text2)] transition-colors font-mono"
          >
            {showAll ? 'Mostra meno' : `Mostra tutti i ${shots.length} shot →`}
          </button>
        )}
      </div>
    </SectionCard>
  )
}

function ShotRow({ shot, idx }) {
  const [open, setOpen] = useState(false)
  const cam = shot.camera || {}

  return (
    <div className="rounded border border-[var(--border)] overflow-hidden text-[10px]">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[var(--bg3)] hover:bg-[var(--bg3)]/80 text-left"
      >
        <span className="font-mono text-[var(--text3)] w-5 shrink-0">{idx+1}</span>
        <span className="text-[var(--text)] flex-1 truncate">{shot.shot_id || shot.id}</span>
        {cam.shot_type && (
          <span className="px-1.5 py-0.5 rounded bg-green-900/30 text-green-300 border border-green-500/20 font-mono shrink-0">{cam.shot_type}</span>
        )}
        {cam.movement && (
          <span className="text-[var(--text3)] font-mono ml-1 shrink-0 hidden sm:block">{cam.movement}</span>
        )}
        {shot.duration_sec && (
          <span className="text-[var(--text3)] font-mono ml-1 shrink-0">{shot.duration_sec}s</span>
        )}
        {open ? <ChevronUp size={10} className="text-[var(--text3)]" /> : <ChevronDown size={10} className="text-[var(--text3)]" />}
      </button>
      {open && (
        <div className="px-2.5 py-2 border-t border-[var(--border)] space-y-1 bg-[var(--bg2)]">
          {shot.scene_description && (
            <p className="text-[var(--text2)] leading-snug">{shot.scene_description}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[var(--text3)] mt-1">
            {cam.lens_mm && <span>🔭 {cam.lens_mm}mm</span>}
            {cam.depth_of_field && <span>DoF: {cam.depth_of_field}</span>}
            {shot.transition_in && <span>→ {shot.transition_in}</span>}
            {shot.emotion && <span className="text-purple-300">❤ {shot.emotion}</span>}
          </div>
          {shot.first_frame_source === 'from_prev_last' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/30 border border-blue-500/20 text-blue-300 font-mono">
              ↩ usa last frame precedente
            </span>
          )}
          {shot.first_frame?.prompt && (
            <div className="mt-1">
              <span className="text-[var(--text3)]">Prompt: </span>
              <span className="text-[var(--text2)]">{shot.first_frame.prompt.slice(0, 200)}</span>
            </div>
          )}
          {shot.last_frame?.prompt && (
            <div className="mt-0.5">
              <span className="text-[var(--text3)]">Last frame: </span>
              <span className="text-[var(--text2)]">{shot.last_frame.prompt.slice(0, 150)}</span>
            </div>
          )}
          {shot.motion_prompt && (
            <div className="mt-0.5 italic text-purple-300 text-[10px]">↪ {shot.motion_prompt.slice(0, 100)}</div>
          )}
        </div>
      )}
    </div>
  )
}

function PromptSummaryResult({ shots }) {
  if (!shots?.length) return null
  const withPrompts = shots.filter(s => s.first_frame?.prompt)
  const withLastFrame = shots.filter(s => s.last_frame?.prompt)
  if (!withPrompts.length) return null
  return (
    <SectionCard title={`Prompt Visivi — ${withPrompts.length} first·frame · ${withLastFrame.length} last·frame`} icon={PenLine} color="#f59e0b" defaultOpen={true}>
      <div className="mt-2 space-y-1.5">
        {withPrompts.slice(0, 4).map((shot, i) => (
          <div key={i} className="px-2 py-1.5 rounded bg-[var(--bg3)] border border-[var(--border)]">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-mono text-amber-400">{shot.shot_id}</span>
              {shot.camera?.shot_type && (
                <span className="text-[10px] font-mono text-[var(--text3)]">{shot.camera.shot_type}</span>
              )}
            </div>
            <p className="text-[10px] text-[var(--text2)] leading-snug">{(shot.first_frame?.prompt || '').slice(0, 130)}…</p>
            {shot.motion_prompt && (
              <p className="text-[10px] text-[var(--text3)] italic mt-0.5">↪ {shot.motion_prompt.slice(0, 80)}</p>
            )}
          </div>
        ))}
        {withPrompts.length > 4 && (
          <p className="text-[10px] text-[var(--text3)] text-center font-mono">+ {withPrompts.length - 4} altri shot</p>
        )}
      </div>
    </SectionCard>
  )
}

function ContinuityResult({ data }) {
  if (!data) return null
  const [showAll, setShowAll] = useState(false)
  const errors = data.errors || []
  const visible = showAll ? errors : errors.slice(0, 5)

  return (
    <SectionCard title="Rapporto Continuità" icon={ClipboardCheck} color="#f87171" defaultOpen={true}>
      <div className="mt-2 space-y-3">
        {/* Status badge */}
        <div className={clsx(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
          data.approved
            ? 'bg-green-900/30 text-green-300 border border-green-500/20'
            : 'bg-red-900/30 text-red-300 border border-red-500/20'
        )}>
          {data.approved ? <CheckCircle size={11} /> : <XCircle size={11} />}
          {data.approved
            ? 'Approvata — nessun errore critico'
            : `${data.critical_count || 0} critici · ${data.warning_count || 0} warning`}
        </div>

        {/* Checks performed */}
        {data.checks_performed?.length > 0 && (
          <div>
            <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">Controlli eseguiti</span>
            <div className="flex gap-1 mt-1 flex-wrap">
              {data.checks_performed.map(c => (
                <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] border border-[var(--border)] text-[var(--text2)] font-mono">{c}</span>
              ))}
            </div>
          </div>
        )}

        {/* LLM analysis summary */}
        {data.analysis_summary && (
          <div className="px-2.5 py-2 rounded border border-[var(--border)] bg-[var(--bg3)]">
            <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider block mb-1">Ragionamento AI</span>
            <p className="text-[11px] text-[var(--text2)] leading-relaxed">{data.analysis_summary}</p>
          </div>
        )}

        {/* Errors */}
        {errors.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-[var(--text3)] uppercase tracking-wider">{errors.length} Problemi trovati</span>
            {visible.map((err, i) => (
              <div key={i} className={clsx(
                'px-2.5 py-2 rounded border text-[11px] space-y-1',
                err.severity === 'critical'
                  ? 'border-red-500/30 bg-red-900/10'
                  : err.severity === 'warning'
                  ? 'border-amber-500/30 bg-amber-900/10'
                  : 'border-[var(--border)] bg-[var(--bg3)]'
              )}>
                <div className="flex items-center gap-2">
                  <span className={clsx('font-mono text-[10px] uppercase', {
                    'text-red-400': err.severity === 'critical',
                    'text-amber-400': err.severity === 'warning',
                    'text-[var(--text3)]': err.severity === 'suggestion',
                  })}>
                    {err.severity}
                  </span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-[var(--bg0)] text-[var(--text3)] font-mono border border-[var(--border)]">
                    {err.error_type}
                  </span>
                  {err.shot_pair && (
                    <span className="text-[10px] text-[var(--text3)] font-mono ml-auto">{err.shot_pair}</span>
                  )}
                </div>
                {err.description && <p className="text-[var(--text2)]">{err.description}</p>}
                {err.reasoning && (
                  <p className="text-[10px] text-[var(--text3)] italic border-l-2 border-[var(--border)] pl-2">{err.reasoning}</p>
                )}
                {err.correction && (
                  <p className="text-[11px] text-green-400 flex items-start gap-1">
                    <span className="shrink-0">↳</span> {err.correction}
                  </p>
                )}
              </div>
            ))}
            {errors.length > 5 && (
              <button
                onClick={() => setShowAll(v => !v)}
                className="w-full py-1 text-[10px] text-[var(--text3)] hover:text-[var(--text2)] font-mono transition-colors"
              >
                {showAll ? 'Mostra meno' : `Mostra tutti i ${errors.length} problemi →`}
              </button>
            )}
          </div>
        )}
      </div>
    </SectionCard>
  )
}

function ResultsTab({ pipelineData }) {
  const data = pipelineData?.data || {}
  const completedStages = pipelineData?.completed_stages || []

  if (completedStages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center">
        <ListVideo size={36} className="text-[var(--text3)] opacity-20 mb-3" />
        <p className="text-sm text-[var(--text3)]">Nessun risultato ancora</p>
        <p className="text-xs text-[var(--text3)] mt-1 opacity-60">
          Avvia la pipeline per generare analisi narrativa, arco, shot list e prompt
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <StoryAnalysisResult data={data.story_analysis} />
      <NarrativeArcResult data={data.story_arc} />
      <ShotListResult shots={data.shot_list} />
      <PromptSummaryResult shots={data.shot_list} />
      <ContinuityResult data={data.continuity_report} />
    </div>
  )
}

// ── Storyboard review banner ──────────────────────────────────────────────────

function StoryboardReviewBanner({ mode, pipelineData, projectId, backendUrl, onStartProduction, onOpenCopilot, onRerunFrom }) {
  const [genThumbs, setGenThumbs] = useState(false)
  const [resolution, setResolution] = useState('512x288')
  const [thumbsLoading, setThumbsLoading] = useState(false)
  const [thumbsProgress, setThumbsProgress] = useState(0)
  const [thumbnails, setThumbnails] = useState([])
  const [thumbsError, setThumbsError] = useState(null)

  const shots = pipelineData?.data?.shot_list || []
  const scenes = (pipelineData?.data?.story_arc?.sequences || [])
    .reduce((a, seq) => a + (seq.scenes?.length || 0), 0)
  const promptCount = shots.filter(s => s.first_frame?.prompt).length
  const shotListEmpty = shots.length === 0

  const resolutionOptions = [
    { value: '320x180',  label: 'Rapida (320×180)' },
    { value: '512x288',  label: 'Standard (512×288)' },
    { value: '768x432',  label: 'Alta (768×432)' },
  ]

  async function handleGenThumbs() {
    if (promptCount === 0) {
      setThumbsError('Nessun prompt trovato nella shot list. Riesegui dal Cinematographer.')
      return
    }
    setThumbsLoading(true)
    setThumbsProgress(0)
    setThumbnails([])
    setThumbsError(null)
    const [w, h] = resolution.split('x').map(Number)
    const total = promptCount
    let done = 0

    const cleanup = window.studio.pipeline.onThumbnailProgress((data) => {
      if (data.done) {
        setThumbnails(data.thumbnails || [])
        setThumbsLoading(false)
        cleanup()
      } else if (data.error) {
        setThumbsError(data.error)
        setThumbsLoading(false)
        cleanup()
      } else if (data.artifact_path) {
        done++
        setThumbsProgress(total > 0 ? done / total : 1)
      }
    })

    try {
      await window.studio.pipeline.thumbnails({ project_id: projectId, width: w, height: h })
    } catch (e) {
      setThumbsError(e.message)
      setThumbsLoading(false)
      cleanup()
    }
  }

  return (
    <div className="rounded-xl border-2 border-[var(--gold)]/50 bg-[var(--gold)]/5 p-4 mb-3 shrink-0">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle size={15} className="text-[var(--gold)]" />
        <span className="text-sm font-semibold text-[var(--gold)]">Storyboard completato</span>
      </div>

      <div className="flex gap-2 mb-3 flex-wrap">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg3)] border border-[var(--border)] text-[var(--text2)] font-mono">
          {shots.length} shot
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg3)] border border-[var(--border)] text-[var(--text2)] font-mono">
          {scenes} scene
        </span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--bg3)] border border-[var(--border)] text-[var(--text2)] font-mono">
          {promptCount} prompt
        </span>
      </div>

      <div className="h-px bg-[var(--border)] mb-3" />

      {/* Warning: shot list empty — offer partial re-run */}
      {shotListEmpty && (
        <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded border border-[var(--red)]/40 bg-[var(--red)]/5">
          <AlertTriangle size={13} className="text-[var(--red)] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-[var(--red)] font-semibold">Shot list vuota</p>
            <p className="text-[10px] text-[var(--text3)] leading-snug mt-0.5">
              Il Cinematographer non ha generato shot (risposta LLM non parsabile). Riesegui da questo stage.
            </p>
          </div>
          {onRerunFrom && (
            <button
              onClick={() => onRerunFrom('shot_list')}
              className="shrink-0 text-[10px] px-2 py-1 rounded border border-[var(--red)]/40 text-[var(--red)] hover:bg-[var(--red)]/10 font-mono whitespace-nowrap"
            >
              Riesegui Cinematographer
            </button>
          )}
        </div>
      )}

      {!shotListEmpty && (
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={genThumbs}
            onChange={e => setGenThumbs(e.target.checked)}
            className="w-3.5 h-3.5 accent-[var(--gold)]"
          />
          <span className="text-xs text-[var(--text2)]">Genera anteprime first frame (ComfyUI)</span>
        </label>
      )}

      {!shotListEmpty && genThumbs && (
        <div className="mb-3 space-y-2">
          <div className="flex gap-1.5">
            {resolutionOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => setResolution(opt.value)}
                className={clsx(
                  'text-[10px] px-2 py-1 rounded border font-mono transition-colors',
                  resolution === opt.value
                    ? 'border-[var(--gold)] bg-[var(--gold)]/10 text-[var(--gold)]'
                    : 'border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)]'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {!thumbsLoading && thumbnails.length === 0 && (
            <button
              onClick={handleGenThumbs}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)] hover:border-[var(--gold)]/40 transition-colors"
            >
              <Sparkles size={11} />
              Genera Anteprime
            </button>
          )}

          {thumbsLoading && (
            <div className="space-y-1">
              <div className="h-1.5 rounded-full bg-[var(--bg3)] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${Math.round(thumbsProgress * 100)}%`, background: 'linear-gradient(90deg, var(--gold), var(--gold2))' }}
                />
              </div>
              <p className="text-[10px] text-[var(--text3)] font-mono">
                Generando... {Math.round(thumbsProgress * shots.filter(s => s.first_frame?.prompt).length)}/{shots.filter(s => s.first_frame?.prompt).length}
              </p>
            </div>
          )}

          {thumbsError && (
            <p className="text-[10px] text-[var(--red)] font-mono">{thumbsError}</p>
          )}

          {thumbnails.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {thumbnails.map((thumb, i) => (
                <img
                  key={i}
                  src={pipelineFrameUrl(projectId, thumb.filename)}
                  alt={thumb.shot_id}
                  className="w-24 h-16 object-cover rounded border border-[var(--border)] shrink-0"
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="h-px bg-[var(--border)] mb-3" />

      {!shotListEmpty && (mode === 'copilot' ? (
        <button
          onClick={onOpenCopilot}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
        >
          <Users size={13} />
          Apri Copilot Shot per Shot
          <ArrowUpRight size={12} />
        </button>
      ) : (
        <button
          onClick={onStartProduction}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
          style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
        >
          <Zap size={13} />
          Avvia Produzione Automatica
        </button>
      ))}
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PipelineScreen() {
  const { id } = useParams()
  const navigate = useNavigate()

  const { currentProject, loadProject } = useProjectStore()
  const {
    stage, paused, totalProgress, stageProgress, message,
    events, currentLLM,
    frames, clips, finalVideoPath, error,
    startPipeline, resetPipeline, resetPipelineFrom, stopPipeline, pausePipeline, resumePipeline,
  } = usePipelineStore()

  const cinematicAutoContinueRef = useRef(null)

  const [tab, setTab] = useState('feed')
  const [pipelineData, setPipelineData] = useState(null)
  const [loadingState, setLoadingState] = useState(true)
  const backendUrl = BACKEND_ORIGIN

  const feedRef = useRef(null)

  useEffect(() => {
    if (!currentProject || currentProject.id !== id) {
      loadProject(id)
    }
  }, [id])

  useEffect(() => {
    setLoadingState(true)
    window.studio.pipeline.state(id)
      .then(data => {
        setPipelineData(data)
        setLoadingState(false)
        if (data?.completed_stages?.length > 0 && stage === 'idle') {
          setTab('results')
        }
      })
      .catch(() => setLoadingState(false))
  }, [id])

  // Fix 1: also refresh pipelineData on stage === 'error'
  useEffect(() => {
    if (stage === 'done' || stage === 'error') {
      window.studio.pipeline.state(id)
        .then(data => { setPipelineData(data) })
        .catch(() => {})
      if (stage === 'done') setTab('results')
    }
  }, [stage, id])

  useEffect(() => {
    if (!['idle', 'done', 'error'].includes(stage)) {
      setTab('feed')
    }
  }, [stage])

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [events])

  function handleStart(phase = 'storyboard') {
    if (!currentProject || currentProject.id !== id) return

    let audioAnalysis = null
    if (currentProject.audio_analysis_json) {
      try { audioAnalysis = JSON.parse(currentProject.audio_analysis_json) } catch {}
    }

    let workflows = null
    if (currentProject.workflows_json) {
      try { workflows = JSON.parse(currentProject.workflows_json) } catch {}
    }

    startPipeline({
      project_id:         id,
      title:              currentProject.title,
      story_brief:        currentProject.user_prompt || currentProject.title,
      genre:              currentProject.genre || 'cinematic',
      style_references:   currentProject.style ? [currentProject.style] : [],
      aspect_ratio:       currentProject.aspect_ratio || '16:9',
      runtime_target_sec: currentProject.duration_sec || 60,
      lyrics:             currentProject.lyrics || null,
      audio_analysis:     audioAnalysis,
      audio_start_sec:    currentProject.audio_start_sec || 0,
      mode:               currentProject.mode || 'full_auto',
      workflows,
      phase,
    })
  }

  async function handleReset() {
    if (isRunning) await stopPipeline(id).catch(() => {})
    await resetPipeline(id)
    setPipelineData({ completed_stages: [], shot_states: {}, data: {} })
    setTab('feed')
  }

  const isRunning = !['idle', 'done', 'error'].includes(stage)
  const frameCount = Object.keys(frames).length
  const clipCount  = Object.keys(clips).length

  const completedStages = pipelineData?.completed_stages || []
  const storyboardDone  = completedStages.includes('continuity_check')
  const productionDone  = completedStages.includes('assembly')

  const cinematicStuckKey = useMemo(() => {
    const shots = pipelineData?.data?.shot_list || []
    return shots
      .filter(s => {
        const sid = s.shot_id
        const ss = pipelineData?.shot_states?.[sid] || {}
        const hasVideo = clips[sid] || (s.clip_path && String(s.clip_path).length > 0)
        const hasFirst = frames[sid]?.first || s.first_frame?.image_path
        const hasLast = frames[sid]?.last || s.last_frame?.image_path
        const wantsFrames = ss.frame_first !== 'done' || ss.frame_last !== 'done' || !hasFirst || !hasLast
        const wantsVideo = ss.video !== 'done' || !hasVideo
        return wantsFrames || wantsVideo
      })
      .map(s => s.shot_id)
      .sort()
      .join(',')
  }, [pipelineData, frames, clips])

  useMediaReconcile({
    enabled: Boolean(id),
    kind: 'cinematic',
    projectId: id,
    stuckKey: cinematicStuckKey,
    alwaysPoll: Boolean(
      pipelineData?.data?.shot_list?.length
      && completedStages.includes('continuity_check')
      && !completedStages.includes('assembly'),
    ),
    onResult: (data) => {
      if (!data.recovered?.length) return
      for (const ev of data.recovered) {
        if (ev.event === 'frame_done' && ev.shot_id) {
          const isFirst = ev.frame === 'first'
          usePipelineStore.setState(s => ({
            frames: {
              ...s.frames,
              [ev.shot_id]: {
                ...s.frames[ev.shot_id],
                [isFirst ? 'first' : 'last']: ev.path || ev.artifact_path,
              },
            },
          }))
        }
        if (ev.event === 'clip_done' && ev.shot_id) {
          usePipelineStore.setState(s => ({
            clips: { ...s.clips, [ev.shot_id]: ev.path || ev.artifact_path },
          }))
        }
      }
      window.studio.pipeline.state(id)
        .then(d => { if (d) setPipelineData(d) })
        .catch(() => {})
      const sbDone = (data.completed_stages || []).includes('continuity_check') || storyboardDone
      if (sbDone && data.all_shots_ready && stage === 'idle' && cinematicAutoContinueRef.current !== id) {
        cinematicAutoContinueRef.current = id
        handleStart('production')
      }
    },
  })

  const showReview      = storyboardDone && !productionDone && stage === 'idle'

  const projectReady = currentProject && currentProject.id === id
  const projectMode  = currentProject?.mode || 'full_auto'

  return (
    <div className="p-5 h-full flex gap-4 overflow-hidden">
      {/* ── Left: stages + controls ── */}
      <div className="w-52 shrink-0 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 mb-3">
          <Film size={16} className="text-[var(--gold)]" />
          <span className="font-display text-sm text-[var(--text)]">Pipeline</span>
        </div>

        {currentProject && (
          <div className="mb-3 px-2 py-2 rounded bg-[var(--bg3)] border border-[var(--border)]">
            <p className="text-[10px] text-[var(--text3)] truncate">{currentProject.genre}</p>
            <p className="text-xs text-[var(--text)] font-medium truncate">{currentProject.title}</p>
            <div className="flex gap-2 mt-1 text-[10px] text-[var(--text3)]">
              <span className="font-mono">{currentProject.aspect_ratio}</span>
              <span>·</span>
              <span className="font-mono">{currentProject.duration_sec}s</span>
              {currentProject.lyrics && <span>· lirica</span>}
            </div>
          </div>
        )}

        <div className="flex-1 mb-4 overflow-y-auto">
          <StageList currentStage={stage} completedStages={completedStages} />
        </div>

        <div className="mb-4">
          <div className="flex justify-between text-xs text-[var(--text3)] mb-1">
            <span>Avanzamento</span>
            <span className="font-mono text-[var(--gold)]">{Math.round(totalProgress * 100)}%</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden bg-[var(--bg3)]">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${Math.max(
                  totalProgress * 100,
                  completedStages.length / STAGES.length * 100
                )}%`,
                background: 'linear-gradient(90deg, var(--gold), var(--gold2))',
              }}
            />
          </div>
        </div>

        <div className="space-y-2">
          {/* Start button — only when idle and no storyboard yet */}
          {stage === 'idle' && !storyboardDone && (
            <button
              onClick={() => handleStart('storyboard')}
              disabled={!projectReady}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs rounded font-mono disabled:opacity-40"
              style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
            >
              <Play size={12} />
              Avvia Storyboard
            </button>
          )}

          {/* Stop button — always visible while running */}
          {isRunning && (
            <button
              onClick={() => stopPipeline(id)}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs rounded font-mono border border-[var(--red)]/60 text-[var(--red)] hover:bg-[var(--red)]/10"
            >
              <Square size={12} /> Stop
            </button>
          )}

          {/* Pause / Resume button */}
          {isRunning && (
            <button
              onClick={() => paused ? resumePipeline(id) : pausePipeline(id)}
              className="w-full flex items-center justify-center gap-2 py-2 text-xs rounded font-mono border border-[var(--border)] text-[var(--text2)] hover:text-[var(--gold)]"
            >
              {paused
                ? <><Play size={12} /> Riprendi</>
                : <><Pause size={12} /> Pausa</>}
            </button>
          )}

          {/* Paused indicator */}
          {paused && isRunning && (
            <div className="text-center text-[10px] text-[var(--amber)] py-0.5 font-mono animate-pulse">
              In pausa — premi Riprendi
            </div>
          )}

          {/* Reset — always visible when not running */}
          {!isRunning && (
            <button
              onClick={handleReset}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2 text-xs rounded font-mono border',
                stage === 'error'
                  ? 'border-[var(--red)] text-[var(--red)]'
                  : 'border-[var(--border)] text-[var(--text3)] hover:text-[var(--text2)]'
              )}
            >
              <RotateCcw size={12} /> {stage === 'error' ? 'Reset' : 'Ricomincia'}
            </button>
          )}

          {stage === 'done' && !productionDone && (
            <div className="text-center text-[10px] text-[var(--green)] py-1 font-mono">
              Storyboard pronto — revisiona
            </div>
          )}
        </div>

        {(frameCount > 0 || clipCount > 0) && (
          <div className="mt-3 pt-3 border-t border-[var(--border)] grid grid-cols-2 gap-2 text-center">
            <div>
              <div className="text-base font-mono text-[var(--gold)]">{frameCount}</div>
              <div className="text-[10px] text-[var(--text3)]">Frame</div>
            </div>
            <div>
              <div className="text-base font-mono text-[var(--gold)]">{clipCount}</div>
              <div className="text-[10px] text-[var(--text3)]">Clip</div>
            </div>
          </div>
        )}

        {finalVideoPath && (
          <div className="mt-2 px-2 py-1.5 rounded border border-[var(--green)]/30 bg-[var(--green)]/5">
            <div className="flex items-center gap-1.5 text-[var(--green)] mb-0.5">
              <Film size={11} />
              <span className="text-[10px] font-semibold">Video pronto</span>
            </div>
            <p className="text-[9px] text-[var(--text3)] font-mono break-all leading-snug">{finalVideoPath}</p>
          </div>
        )}
      </div>

      {/* ── Right: tabs + content ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex items-center gap-3 mb-3 shrink-0">
          <div className="flex rounded-md border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setTab('feed')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors',
                tab === 'feed'
                  ? 'bg-[var(--bg3)] text-[var(--text)]'
                  : 'text-[var(--text3)] hover:text-[var(--text2)]'
              )}
            >
              <Eye size={12} />
              Feed live
              {events.length > 0 && (
                <span className="text-[10px] font-mono text-[var(--text3)]">({events.length})</span>
              )}
              {isRunning && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--gold)] animate-pulse ml-0.5" />
              )}
            </button>
            <button
              onClick={() => setTab('results')}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors border-l border-[var(--border)]',
                tab === 'results'
                  ? 'bg-[var(--bg3)] text-[var(--text)]'
                  : 'text-[var(--text3)] hover:text-[var(--text2)]'
              )}
            >
              <ListVideo size={12} />
              Risultati
              {completedStages.length > 0 && (
                <span className="text-[10px] font-mono text-[var(--green)] ml-0.5">({completedStages.length})</span>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-[var(--border)] bg-[var(--bg2)] flex-1 min-w-0">
            {stage === 'error'   ? <XCircle size={13} className="text-[var(--red)] shrink-0" />
             : stage === 'done'  ? <CheckCircle size={13} className="text-[var(--green)] shrink-0" />
             : isRunning         ? <Loader2 size={13} className="animate-spin text-[var(--gold)] shrink-0" />
             : <Film size={13} className="text-[var(--text3)] shrink-0" />}
            <span className={clsx('text-xs flex-1 truncate', {
              'text-[var(--red)]':    stage === 'error',
              'text-[var(--green)]':  stage === 'done',
              'text-[var(--text2)]':  !['error','done'].includes(stage),
            })}>
              {error || (stage === 'done' ? 'Pipeline completata!' : message || 'In attesa...')}
            </span>
          </div>
        </div>

        {showReview && (
          <StoryboardReviewBanner
            mode={projectMode}
            pipelineData={pipelineData}
            projectId={id}
            backendUrl={backendUrl}
            onStartProduction={() => { handleStart('production'); setTab('feed') }}
            onOpenCopilot={() => navigate(`/projects/${id}/copilot`)}
            onRerunFrom={async (stage) => {
              await resetPipelineFrom(id, stage)
              const data = await window.studio.pipeline.state(id)
              setPipelineData(data)
              setTab('feed')
              handleStart('storyboard')
            }}
          />
        )}

        {tab === 'feed' ? (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <ActiveLLMBanner llm={currentLLM} />
            <div
              ref={feedRef}
              className="flex-1 overflow-y-auto space-y-1.5 pr-1"
              style={{ scrollBehavior: 'smooth' }}
            >
              {events.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <Film size={36} className="text-[var(--text3)] opacity-20 mb-3" />
                  <p className="text-sm text-[var(--text3)]">Avvia la pipeline per vedere il flusso in tempo reale</p>
                  <p className="text-xs text-[var(--text3)] mt-1 opacity-60">
                    Ogni fase LLM mostrerà prompt, elaborazione e risultati
                  </p>
                </div>
              ) : (
                events.map(evt => <EventCard key={evt.id} evt={evt} />)
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-2 pr-1">
            {loadingState ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 size={20} className="animate-spin text-[var(--text3)]" />
              </div>
            ) : (
              <ResultsTab pipelineData={pipelineData} />
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes dotPulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  )
}
