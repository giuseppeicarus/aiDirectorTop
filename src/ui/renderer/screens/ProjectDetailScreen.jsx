import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Film, Play, Clapperboard, ArrowLeft, Trash2, Clock,
  Layers, Camera, MapPin, Calendar, Loader2, CheckCircle2,
  XCircle, AlertCircle, Video, BookOpen, PenLine, ClipboardCheck,
  ChevronDown, ChevronUp, ChevronRight, Lock, Aperture, Zap,
} from 'lucide-react'
import { useProjectStore } from '../stores'
import clsx from 'clsx'

const API = 'http://localhost:8765/api'

// ── Status / labels ───────────────────────────────────────────────────────────

const STATUS_CFG = {
  draft:       { label: 'Bozza',       color: 'text-[var(--text3)]', bg: 'bg-[var(--bg3)]',    icon: Film },
  storyboard:  { label: 'Storyboard',  color: 'text-blue-400',       bg: 'bg-blue-400/10',      icon: Clapperboard },
  generating:  { label: 'Generazione', color: 'text-[var(--gold)]',  bg: 'bg-[var(--gold)]/10', icon: Loader2 },
  done:        { label: 'Completato',  color: 'text-green-400',      bg: 'bg-green-400/10',     icon: CheckCircle2 },
  error:       { label: 'Errore',      color: 'text-red-400',        bg: 'bg-red-400/10',       icon: XCircle },
}

const STAGE_META = [
  { key: 'story_analysis',    label: 'Analisi Narrativa',      sub: 'LLM 1 — brief · emozioni · temi',          Icon: BookOpen },
  { key: 'narrative_arc',     label: 'Arco Narrativo',         sub: 'LLM 2 — struttura gerarchica sequenze',    Icon: Clapperboard },
  { key: 'shot_list',         label: 'Shot List',              sub: 'LLM 3 — camera · luce · transizioni',      Icon: Camera },
  { key: 'prompt_generation', label: 'Prompt Visivi',          sub: 'LLM 4 — prompt immagine e video',          Icon: PenLine },
  { key: 'continuity_check',  label: 'Verifica Continuità',    sub: 'LLM 5 — coerenza tra clip',               Icon: ClipboardCheck },
  { key: 'frame_gen',         label: 'Generazione Frame',      sub: 'ComfyUI txt2img',                          Icon: Aperture },
  { key: 'video_gen',         label: 'Generazione Video',      sub: 'ComfyUI img2video',                        Icon: Film },
  { key: 'assembly',          label: 'Assemblaggio',           sub: 'FFmpeg · output finale',                   Icon: Zap },
]

// ── Shared primitives ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.draft
  const Icon = cfg.icon
  return (
    <span className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', cfg.color, cfg.bg)}>
      <Icon size={11} className={status === 'generating' ? 'animate-spin' : ''} />
      {cfg.label}
    </span>
  )
}

function InfoRow({ label, value }) {
  if (!value) return null
  return (
    <div className="flex gap-3 py-2 border-b border-[var(--border)] last:border-0">
      <span className="w-32 text-xs text-[var(--text3)] shrink-0 pt-0.5">{label}</span>
      <span className="text-xs text-[var(--text)] flex-1 leading-relaxed">{value}</span>
    </div>
  )
}

function Tag({ children }) {
  return (
    <span className="inline-block text-[10px] px-2 py-0.5 rounded font-mono text-[var(--text2)] bg-[var(--bg3)] border border-[var(--border)]">
      {children}
    </span>
  )
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="text-center py-2 rounded bg-[var(--bg3)]">
      <Icon size={13} className="text-[var(--text3)] mx-auto mb-1" />
      <div className="text-sm font-mono text-[var(--gold)]">{value}</div>
      <div className="text-[10px] text-[var(--text3)]">{label}</div>
    </div>
  )
}

// ── Pipeline output: stage accordion wrapper ──────────────────────────────────

function StageSection({ meta, done, open, onToggle, children }) {
  const { Icon, label, sub } = meta
  return (
    <div className={clsx(
      'rounded-lg border transition-colors overflow-hidden',
      done ? 'border-[var(--border)]' : 'border-[var(--border)] opacity-40',
    )}>
      <button
        onClick={done ? onToggle : undefined}
        className={clsx(
          'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors',
          done ? 'hover:bg-white/[0.02] cursor-pointer' : 'cursor-default',
        )}
      >
        <div className={clsx(
          'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
          done ? 'bg-[var(--gold)]/15' : 'bg-[var(--bg3)]',
        )}>
          {done
            ? <Icon size={14} className="text-[var(--gold)]" />
            : <Lock size={12} className="text-[var(--text3)]" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={clsx('text-sm font-medium', done ? 'text-[var(--text)]' : 'text-[var(--text3)]')}>
              {label}
            </span>
            {done && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 font-mono">
                completato
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--text3)] mt-0.5">{sub}</p>
        </div>

        {done && (
          open
            ? <ChevronUp size={13} className="text-[var(--text3)] shrink-0" />
            : <ChevronDown size={13} className="text-[var(--text3)] shrink-0" />
        )}
      </button>

      {done && open && (
        <div className="border-t border-[var(--border)] px-4 py-4 bg-[var(--bg1)]">
          {children}
        </div>
      )}
    </div>
  )
}

// ── Stage output: LLM 1 — Story Analysis ─────────────────────────────────────

function StoryAnalysisOutput({ sa }) {
  if (!sa) return <p className="text-xs text-[var(--text3)]">Nessun dato disponibile.</p>

  const emotions = sa.emotion_progression || []

  return (
    <div className="space-y-4">
      {sa.narrative_summary && (
        <div>
          <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1.5">Riassunto narrativo</div>
          <p className="text-sm text-[var(--text)] leading-relaxed italic bg-[var(--bg2)] rounded p-3 border border-[var(--border)]">
            "{sa.narrative_summary}"
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {sa.themes?.length > 0 && (
          <div>
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Temi</div>
            <div className="flex flex-wrap gap-1">
              {sa.themes.map((t, i) => <Tag key={i}>{t}</Tag>)}
            </div>
          </div>
        )}
        {sa.visual_metaphors?.length > 0 && (
          <div>
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Metafore visive</div>
            <div className="flex flex-wrap gap-1">
              {sa.visual_metaphors.map((m, i) => <Tag key={i}>{m}</Tag>)}
            </div>
          </div>
        )}
        {sa.suggested_motifs?.length > 0 && (
          <div>
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Motivi suggeriti</div>
            <div className="flex flex-wrap gap-1">
              {sa.suggested_motifs.map((m, i) => <Tag key={i}>{m}</Tag>)}
            </div>
          </div>
        )}
      </div>

      {emotions.length > 0 && (
        <div>
          <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Progressione emotiva</div>
          <div className="flex items-end gap-1 h-12">
            {emotions.map((e, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                <div
                  className="w-full rounded-sm bg-[var(--gold)] opacity-70 transition-all"
                  style={{ height: `${Math.round((e.intensity || 0.5) * 40)}px` }}
                />
                <span className="text-[9px] text-[var(--text3)] truncate w-full text-center leading-none">{e.emotion}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[9px] text-[var(--text3)] mt-1">
            <span>{emotions[0]?.time_sec ?? 0}s</span>
            <span>{emotions[emotions.length - 1]?.time_sec ?? '?'}s</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sa.color_mood && (
          <div className="rounded p-3 bg-[var(--bg2)] border border-[var(--border)]">
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Mood colore</div>
            <p className="text-xs text-[var(--text2)] leading-relaxed">{sa.color_mood}</p>
          </div>
        )}
        {sa.pacing_notes && (
          <div className="rounded p-3 bg-[var(--bg2)] border border-[var(--border)]">
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Pacing</div>
            <p className="text-xs text-[var(--text2)] leading-relaxed">{sa.pacing_notes}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Stage output: LLM 2 — Narrative Arc ──────────────────────────────────────

function NarrativeArcOutput({ arc }) {
  const [openSeq, setOpenSeq] = useState(null)
  if (!arc) return <p className="text-xs text-[var(--text3)]">Nessun dato disponibile.</p>

  const sequences = arc.sequences || []
  const totalScenes = sequences.flatMap(s => s.scenes || []).length
  const totalShots = sequences.flatMap(s => s.scenes || []).flatMap(sc => sc.shots || []).length

  const ROLE_COLOR = {
    intro: 'text-blue-400', buildup: 'text-amber-400', verse: 'text-purple-400',
    chorus: 'text-[var(--gold)]', bridge: 'text-cyan-400', climax: 'text-red-400',
    resolution: 'text-green-400', outro: 'text-[var(--text3)]',
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded p-4 bg-[var(--bg2)] border border-[var(--border)]">
        {arc.title && (
          <h3 className="font-display text-base text-[var(--text)] mb-1">{arc.title}</h3>
        )}
        {arc.logline && (
          <p className="text-sm text-[var(--text2)] italic leading-relaxed">"{arc.logline}"</p>
        )}

        <div className="flex gap-5 mt-3 pt-3 border-t border-[var(--border)]">
          <div className="text-center">
            <div className="text-xl font-mono text-[var(--gold)]">{sequences.length}</div>
            <div className="text-[10px] text-[var(--text3)]">sequenze</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-mono text-[var(--gold)]">{totalScenes}</div>
            <div className="text-[10px] text-[var(--text3)]">scene</div>
          </div>
          <div className="text-center">
            <div className="text-xl font-mono text-[var(--gold)]">{totalShots}</div>
            <div className="text-[10px] text-[var(--text3)]">shot</div>
          </div>
        </div>
      </div>

      {/* Palette + motifs */}
      <div className="flex flex-wrap gap-4 items-start">
        {arc.color_palette?.length > 0 && (
          <div>
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1.5">Palette colori</div>
            <div className="flex gap-2">
              {arc.color_palette.slice(0, 8).map((c, i) => (
                <div key={i} title={c} className="w-7 h-7 rounded border border-[var(--border2)]"
                  style={{ background: c.startsWith('#') ? c : 'var(--bg3)' }} />
              ))}
            </div>
          </div>
        )}
        {arc.visual_motifs?.length > 0 && (
          <div>
            <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1.5">Motivi visivi</div>
            <div className="flex flex-wrap gap-1">
              {arc.visual_motifs.map((m, i) => <Tag key={i}>{m}</Tag>)}
            </div>
          </div>
        )}
      </div>

      {/* Sequence tree */}
      {sequences.length > 0 && (
        <div>
          <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Struttura narrativa</div>
          <div className="space-y-1">
            {sequences.map((seq, si) => {
              const isOpen = openSeq === seq.id
              const scenes = seq.scenes || []
              return (
                <div key={seq.id || si} className="rounded border border-[var(--border)] overflow-hidden">
                  <button
                    onClick={() => setOpenSeq(isOpen ? null : seq.id)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
                  >
                    <ChevronRight size={12} className={clsx('text-[var(--text3)] transition-transform shrink-0', isOpen && 'rotate-90')} />
                    <span className="text-xs text-[var(--text)] font-medium flex-1 truncate">{seq.title}</span>
                    <span className={clsx('text-[10px] font-mono shrink-0', ROLE_COLOR[seq.narrative_role] || 'text-[var(--text3)]')}>
                      {seq.narrative_role}
                    </span>
                    <span className="text-[10px] text-[var(--text3)] shrink-0 ml-2">{scenes.length} scene</span>
                  </button>

                  {isOpen && (
                    <div className="border-t border-[var(--border)] bg-[var(--bg0)] px-3 py-2 space-y-2">
                      {seq.emotion_arc && (
                        <p className="text-[11px] text-[var(--text3)] italic">{seq.emotion_arc}</p>
                      )}
                      {scenes.map((scene, sci) => (
                        <div key={scene.id || sci} className="ml-3 border-l-2 border-[var(--border2)] pl-3">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[11px] text-[var(--text2)] font-medium">{scene.title}</span>
                            <span className="text-[10px] text-[var(--text3)] font-mono">{scene.location}</span>
                            <span className="text-[10px] text-[var(--text3)] ml-auto">{scene.time_of_day}</span>
                          </div>
                          {scene.trigger && (
                            <span className="text-[9px] text-[var(--gold)] font-mono">trigger: {scene.trigger}</span>
                          )}
                          <div className="mt-1.5 space-y-0.5">
                            {(scene.shots || []).map((sh, shi) => (
                              <div key={sh.shot_id || shi} className="flex items-center gap-2 text-[10px] text-[var(--text3)]">
                                <span className="font-mono text-[var(--text2)]">{sh.shot_id}</span>
                                <span>{sh.duration_sec}s</span>
                                <span className="text-[var(--text3)]">·</span>
                                <span className="text-[var(--text2)]">{sh.emotional_intent}</span>
                                <span className="ml-auto font-mono">{sh.suggested_shot_type}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Stage output: LLM 3 — Shot List ──────────────────────────────────────────

const SHOT_TYPE_COLOR = {
  wide: 'text-blue-400', medium: 'text-cyan-400', close_up: 'text-amber-400',
  extreme_close: 'text-red-400', drone: 'text-purple-400', pov: 'text-green-400',
  over_shoulder: 'text-[var(--text2)]',
}

function ShotListOutput({ shots }) {
  const [expanded, setExpanded] = useState(null)
  if (!shots?.length) return <p className="text-xs text-[var(--text3)]">Nessun dato disponibile.</p>

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[11px] text-[var(--text3)]">
        <span>{shots.length} inquadrature cinematografiche</span>
        <span>·</span>
        <span>{shots.reduce((s, sh) => s + (sh.duration_sec || 0), 0).toFixed(0)}s totali</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {shots.map((sh, i) => {
          const cam = sh.camera || {}
          const isOpen = expanded === i
          return (
            <div key={sh.shot_id || i}
              className="rounded border border-[var(--border)] bg-[var(--bg2)] overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : i)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
              >
                <span className="font-mono text-[10px] text-[var(--gold)] shrink-0 w-16">{sh.shot_id}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={clsx('text-[10px] font-mono', SHOT_TYPE_COLOR[cam.shot_type] || 'text-[var(--text2)]')}>
                      {cam.shot_type || '—'}
                    </span>
                    <span className="text-[10px] text-[var(--text3)]">{cam.movement}</span>
                    {cam.lens_mm && <span className="text-[10px] text-[var(--text3)] ml-auto">{cam.lens_mm}mm</span>}
                  </div>
                  <p className="text-[11px] text-[var(--text2)] truncate mt-0.5">{sh.emotion || sh.scene_description}</p>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono text-[var(--text)]">{sh.duration_sec}s</div>
                  {isOpen
                    ? <ChevronUp size={11} className="text-[var(--text3)] ml-auto mt-0.5" />
                    : <ChevronDown size={11} className="text-[var(--text3)] ml-auto mt-0.5" />}
                </div>
              </button>

              {isOpen && (
                <div className="border-t border-[var(--border)] px-3 py-3 space-y-2.5 bg-[var(--bg1)]">
                  {sh.scene_description && (
                    <p className="text-xs text-[var(--text2)] leading-relaxed">{sh.scene_description}</p>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div>
                      <span className="text-[var(--text3)] block mb-0.5">Location</span>
                      <span className="text-[var(--text)]">{sh.location || '—'}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text3)] block mb-0.5">Profondità campo</span>
                      <span className="text-[var(--text)]">{cam.depth_of_field || '—'}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text3)] block mb-0.5">Transizione in</span>
                      <span className="text-[var(--gold)] font-mono">{sh.transition_in || '—'}</span>
                    </div>
                    <div>
                      <span className="text-[var(--text3)] block mb-0.5">Transizione out</span>
                      <span className="text-[var(--gold)] font-mono">{sh.transition_out || '—'}</span>
                    </div>
                  </div>

                  {sh.lighting && (
                    <div className="text-[10px]">
                      <span className="text-[var(--text3)] block mb-0.5">Illuminazione</span>
                      <span className="text-[var(--text)]">
                        {sh.lighting.time_of_day} · {sh.lighting.mood}
                        {sh.lighting.sources?.length > 0 && ` · ${sh.lighting.sources.join(', ')}`}
                      </span>
                    </div>
                  )}

                  {sh.continuity_notes?.length > 0 && (
                    <div className="text-[10px]">
                      <span className="text-[var(--text3)] block mb-1">Note continuità</span>
                      <ul className="space-y-0.5">
                        {sh.continuity_notes.map((n, ni) => (
                          <li key={ni} className="flex items-start gap-1.5 text-[var(--text2)]">
                            <span className="text-[var(--gold)] mt-0.5 shrink-0">·</span> {n}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Stage output: LLM 4 — Prompt Generation ──────────────────────────────────

function PromptEngOutput({ shots }) {
  const [expanded, setExpanded] = useState(null)
  const withPrompts = (shots || []).filter(sh => sh.first_frame?.prompt || sh.motion_prompt)
  if (!withPrompts.length) return <p className="text-xs text-[var(--text3)]">Nessun dato disponibile.</p>

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[var(--text3)]">{withPrompts.length} shot con prompt generati</p>
      {withPrompts.map((sh, i) => {
        const isOpen = expanded === i
        return (
          <div key={sh.shot_id || i} className="rounded border border-[var(--border)] overflow-hidden">
            <button
              onClick={() => setExpanded(isOpen ? null : i)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/[0.02] transition-colors"
            >
              <span className="font-mono text-[10px] text-[var(--gold)] w-16 shrink-0">{sh.shot_id}</span>
              <span className="text-[11px] text-[var(--text2)] flex-1 truncate">
                {sh.first_frame?.prompt?.slice(0, 80) || sh.motion_prompt?.slice(0, 80) || '—'}
              </span>
              {isOpen
                ? <ChevronUp size={11} className="text-[var(--text3)] shrink-0" />
                : <ChevronDown size={11} className="text-[var(--text3)] shrink-0" />}
            </button>

            {isOpen && (
              <div className="border-t border-[var(--border)] px-3 py-3 space-y-3 bg-[var(--bg1)]">
                {sh.first_frame?.prompt && (
                  <div>
                    <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Primo frame</div>
                    <p className="text-[11px] text-[var(--text)] font-mono leading-relaxed bg-[var(--bg2)] p-2 rounded border border-[var(--border)]">
                      {sh.first_frame.prompt}
                    </p>
                  </div>
                )}
                {sh.last_frame?.prompt && (
                  <div>
                    <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Ultimo frame</div>
                    <p className="text-[11px] text-[var(--text)] font-mono leading-relaxed bg-[var(--bg2)] p-2 rounded border border-[var(--border)]">
                      {sh.last_frame.prompt}
                    </p>
                  </div>
                )}
                {sh.motion_prompt && (
                  <div>
                    <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Motion prompt (img2video)</div>
                    <p className="text-[11px] text-[var(--gold)] font-mono leading-relaxed bg-[var(--gold)]/5 p-2 rounded border border-[var(--gold)]/20">
                      {sh.motion_prompt}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Stage output: LLM 5 — Continuity Check ───────────────────────────────────

function ContinuityOutput({ report }) {
  if (!report) return <p className="text-xs text-[var(--text3)]">Nessun dato disponibile.</p>
  const errors = report.errors || []
  const corrections = report.corrections || []

  return (
    <div className="space-y-3">
      <div className={clsx(
        'flex items-center gap-3 px-4 py-3 rounded border',
        report.approved
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-red-500/30 bg-red-500/5',
      )}>
        {report.approved
          ? <CheckCircle2 size={16} className="text-green-400 shrink-0" />
          : <AlertCircle size={16} className="text-red-400 shrink-0" />}
        <div>
          <div className={clsx('text-sm font-medium', report.approved ? 'text-green-400' : 'text-red-400')}>
            {report.approved ? 'Continuità approvata' : `Continuità: ${report.critical_count || errors.length} errori critici`}
          </div>
          {report.overall_notes && (
            <p className="text-[11px] text-[var(--text3)] mt-0.5">{report.overall_notes}</p>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div>
          <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Errori rilevati</div>
          <div className="space-y-1.5">
            {errors.map((e, i) => (
              <div key={i} className="rounded border border-red-500/20 bg-red-500/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-[var(--gold)]">{e.shot_id || '—'}</span>
                  <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded',
                    e.severity === 'critical' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400')}>
                    {e.severity}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text2)] mt-1">{e.description || e.message}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {corrections.length > 0 && (
        <div>
          <div className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-2">Correzioni suggerite</div>
          <div className="space-y-1">
            {corrections.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px] text-[var(--text2)]">
                <span className="text-green-400 mt-0.5 shrink-0">→</span>
                <span>{typeof c === 'string' ? c : c.suggestion || JSON.stringify(c)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Frame / Video / Assembly output ──────────────────────────────────────────

function GenStageOutput({ shots, stateKey, label }) {
  const items = (shots || []).filter(sh => sh.shot_states?.[stateKey] === 'done' || sh[stateKey === 'frame_first' ? 'first_frame' : 'clip_path'])
  return (
    <div className="text-xs text-[var(--text2)] space-y-1">
      <p>{label} — {items.length} / {(shots || []).length} completati</p>
    </div>
  )
}

// ── Main Pipeline Output Panel ────────────────────────────────────────────────

function PipelineOutputPanel({ projectId }) {
  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [openStage, setOpenStage] = useState(null)

  useEffect(() => {
    fetch(`${API}/pipeline/${projectId}/state`)
      .then(r => r.json())
      .then(d => {
        setState(d)
        const done = d.completed_stages || []
        if (done.length > 0) setOpenStage(done[done.length - 1])
      })
      .catch(() => setState(null))
      .finally(() => setLoading(false))
  }, [projectId])

  if (loading) return (
    <div className="mt-6 flex items-center gap-2 text-xs text-[var(--text3)]">
      <Loader2 size={12} className="animate-spin" /> Caricamento output pipeline...
    </div>
  )
  if (!state || !state.completed_stages?.length) return null

  const done = state.completed_stages || []
  const data = state.data || {}
  const shots = data.shot_list || []

  function toggle(key) {
    setOpenStage(o => o === key ? null : key)
  }

  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-xs text-[var(--text3)] uppercase tracking-wider">Output ragionamento pipeline</h2>
        <div className="flex-1 h-px bg-[var(--border)]" />
        <span className="text-[11px] text-[var(--gold)] font-mono">{done.length}/{STAGE_META.length} stage</span>
      </div>

      <div className="space-y-2">
        {STAGE_META.map(meta => (
          <StageSection
            key={meta.key}
            meta={meta}
            done={done.includes(meta.key)}
            open={openStage === meta.key}
            onToggle={() => toggle(meta.key)}
          >
            {meta.key === 'story_analysis' && (
              <StoryAnalysisOutput sa={data.story_analysis} />
            )}
            {meta.key === 'narrative_arc' && (
              <NarrativeArcOutput arc={data.story_arc} />
            )}
            {meta.key === 'shot_list' && (
              <ShotListOutput shots={shots} />
            )}
            {meta.key === 'prompt_generation' && (
              <PromptEngOutput shots={shots} />
            )}
            {meta.key === 'continuity_check' && (
              <ContinuityOutput report={data.continuity_report} />
            )}
            {(meta.key === 'frame_gen' || meta.key === 'video_gen') && (
              <p className="text-xs text-[var(--text3)]">
                {shots.length} shot processati — vedi Media Library per i file generati.
              </p>
            )}
            {meta.key === 'assembly' && (
              <p className="text-xs text-[var(--text2)]">
                Video finale assemblato. Usa il pulsante "Apri Video Finale" per riprodurlo.
              </p>
            )}
          </StageSection>
        ))}
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ProjectDetailScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { currentProject, currentStoryboard, loadProject, deleteProject, loading } = useProjectStore()
  const [deleting, setDeleting] = useState(false)

  useEffect(() => { if (id) loadProject(id) }, [id])

  async function handleDelete() {
    if (!confirm(`Eliminare il progetto "${currentProject?.title}"? L'azione è irreversibile.`)) return
    setDeleting(true)
    await deleteProject(id)
    navigate('/projects')
  }

  if (loading) return (
    <div className="flex items-center justify-center h-full gap-2 text-[var(--text3)] text-sm">
      <Loader2 size={16} className="animate-spin" /> Caricamento...
    </div>
  )

  if (!currentProject) return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text3)]">
      <AlertCircle size={32} className="opacity-40" />
      <p className="text-sm">Progetto non trovato</p>
      <button onClick={() => navigate('/projects')}
        className="text-xs text-[var(--gold)] hover:underline flex items-center gap-1">
        <ArrowLeft size={12} /> Torna ai progetti
      </button>
    </div>
  )

  const p = currentProject
  const createdAt = new Date(p.created_at).toLocaleDateString('it-IT', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const shotCount = currentStoryboard?.shot_list?.length
    || currentStoryboard?.story_arc?.sequences?.flatMap(s => s.scenes || []).flatMap(sc => sc.shots || []).length
    || '—'
  const sceneCount = currentStoryboard?.story_arc?.sequences?.flatMap(s => s.scenes || []).length || '—'

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6">

        {/* Back + delete */}
        <div className="flex items-center justify-between mb-6">
          <button onClick={() => navigate('/projects')}
            className="flex items-center gap-1.5 text-xs text-[var(--text3)] hover:text-[var(--text2)] transition-colors">
            <ArrowLeft size={13} /> Tutti i progetti
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded text-[var(--text3)] hover:text-red-400 hover:bg-red-400/10 disabled:opacity-40 transition-colors">
            {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Elimina
          </button>
        </div>

        {/* Title + status */}
        <div className="mb-6">
          <div className="flex items-start gap-3 mb-2">
            <Film size={22} className="text-[var(--gold)] mt-1 shrink-0" />
            <div className="flex-1">
              <h1 className="font-display text-2xl text-[var(--text)] leading-tight">{p.title}</h1>
              <div className="flex items-center gap-3 mt-2">
                <StatusBadge status={p.status} />
                <span className="text-[11px] text-[var(--text3)] flex items-center gap-1">
                  <Calendar size={10} /> {createdAt}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 3-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* Left: brief + metadata */}
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg2)]">
              <h3 className="text-xs text-[var(--text3)] uppercase tracking-wider mb-3">Brief narrativo</h3>
              <p className="text-sm text-[var(--text)] leading-relaxed whitespace-pre-wrap">{p.user_prompt}</p>
            </div>

            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg2)]">
              <h3 className="text-xs text-[var(--text3)] uppercase tracking-wider mb-2">Dettagli tecnici</h3>
              <InfoRow label="Genere" value={p.genre} />
              <InfoRow label="Stile visivo" value={p.style} />
              <InfoRow label="Aspect ratio" value={p.aspect_ratio} />
              <InfoRow label="Durata target"
                value={`${p.duration_sec}s (~${Math.floor(p.duration_sec / 60)}:${String(p.duration_sec % 60).padStart(2, '0')} min)`} />
              {p.final_video_path && <InfoRow label="Video finale" value={p.final_video_path} />}
            </div>
          </div>

          {/* Right: actions + stats */}
          <div className="space-y-4">
            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg2)] space-y-2">
              <h3 className="text-xs text-[var(--text3)] uppercase tracking-wider mb-3">Azioni</h3>
              <button
                onClick={() => navigate(`/projects/${id}/pipeline`)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm font-medium transition-colors bg-[var(--gold)] text-[var(--bg0)] hover:brightness-110"
              >
                <Play size={14} /> Avvia Pipeline
              </button>
              <button
                onClick={() => navigate(`/projects/${id}/storyboard`)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)]/40 hover:text-[var(--text)] transition-colors"
              >
                <Clapperboard size={14} /> Visualizza Storyboard
              </button>
              {p.final_video_path && (
                <button
                  onClick={() => window.studio?.shell?.openPath(p.final_video_path)}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded text-sm border border-green-400/30 text-green-400 hover:bg-green-400/10 transition-colors"
                >
                  <Video size={14} /> Apri Video Finale
                </button>
              )}
            </div>

            <div className="rounded-lg border border-[var(--border)] p-4 bg-[var(--bg2)]">
              <h3 className="text-xs text-[var(--text3)] uppercase tracking-wider mb-3">Statistiche</h3>
              <div className="grid grid-cols-2 gap-3">
                <Stat icon={Clock}   label="Durata"  value={`${p.duration_sec}s`} />
                <Stat icon={Layers}  label="Ratio"   value={p.aspect_ratio} />
                <Stat icon={Camera}  label="Shot"    value={shotCount} />
                <Stat icon={MapPin}  label="Scene"   value={sceneCount} />
              </div>
            </div>
          </div>
        </div>

        {/* Full-width pipeline output */}
        <PipelineOutputPanel projectId={id} />

      </div>
    </div>
  )
}
