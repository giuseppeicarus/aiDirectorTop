import { useState, useEffect, useCallback } from 'react'
import {
  ListChecks, RefreshCw, Trash2, RotateCcw, CheckCircle,
  XCircle, Loader2, Clock, AlertTriangle, Play,
  Image as ImageIcon, X, ChevronDown, ChevronUp,
  Activity, Layers,
} from 'lucide-react'
import clsx from 'clsx'

const API = 'http://localhost:8765/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDuration(startedAt, endedAt) {
  const s = new Date(startedAt)
  const e = endedAt ? new Date(endedAt) : new Date()
  const secs = Math.round((e - s) / 1000)
  if (secs < 60)  return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs/60)}m ${secs%60}s`
  return `${Math.floor(secs/3600)}h ${Math.floor((secs%3600)/60)}m`
}

function fmtTime(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}

const STATUS_STYLE = {
  running:    { color: 'text-[var(--gold)]',  bg: 'bg-[var(--gold)]/10',  Icon: Loader2,      spin: true,  label: 'In esecuzione' },
  completed:  { color: 'text-[var(--green)]', bg: 'bg-[var(--green)]/10', Icon: CheckCircle,  spin: false, label: 'Completata' },
  failed:     { color: 'text-[var(--red)]',   bg: 'bg-[var(--red)]/10',   Icon: XCircle,      spin: false, label: 'Fallita' },
  incomplete: { color: 'text-[var(--amber)]', bg: 'bg-[var(--amber)]/10', Icon: AlertTriangle,spin: false, label: 'Incompleta' },
  cancelled:  { color: 'text-[var(--text3)]', bg: 'bg-[var(--bg3)]',      Icon: X,            spin: false, label: 'Annullata' },
}

function StatusBadge({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.incomplete
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono', s.color, s.bg)}>
      <s.Icon size={10} className={s.spin ? 'animate-spin' : ''} />
      {s.label}
    </span>
  )
}

// ── Active pipeline cards ─────────────────────────────────────────────────────

function ActiveCard({ run }) {
  return (
    <div className="rounded-lg border border-[var(--gold)]/30 bg-[var(--gold)]/5 p-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-[var(--gold)]/15 flex items-center justify-center shrink-0">
          <Loader2 size={16} className="text-[var(--gold)] animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)] truncate">{run.project_title || run.project_id}</span>
            <StatusBadge status="running" />
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--text3)]">
            <span className="font-mono">Stage: <span className="text-[var(--gold)]">{run.stage}</span></span>
            <span>{Math.round((run.progress || 0) * 100)}%</span>
            <span className="flex items-center gap-1"><Clock size={10} /> {fmtDuration(run.started_at)}</span>
          </div>
          {/* Progress bar */}
          <div className="mt-2 h-1 rounded-full bg-[var(--bg3)] overflow-hidden">
            <div className="h-full rounded-full bg-[var(--gold)] transition-all duration-500"
                 style={{ width: `${Math.round((run.progress || 0) * 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Audit log entry row ───────────────────────────────────────────────────────

function AuditRow({ entry, onReset, onClearFrames }) {
  const [expanded, setExpanded] = useState(false)
  const stagesRatio = `${entry.stages_done || 0}/8`

  return (
    <>
      <tr className="border-b border-[var(--border)] hover:bg-[var(--bg2)] transition-colors">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text)] font-medium truncate max-w-[180px]">
              {entry.project_title || entry.project_id}
            </span>
          </div>
          <div className="text-[10px] text-[var(--text3)] font-mono mt-0.5">{entry.project_id}</div>
        </td>
        <td className="px-3 py-2.5">
          <StatusBadge status={entry.status} />
        </td>
        <td className="px-3 py-2.5 text-[11px] text-[var(--text2)] font-mono">{fmtTime(entry.started_at)}</td>
        <td className="px-3 py-2.5 text-[11px] text-[var(--text2)] font-mono">
          {fmtDuration(entry.started_at, entry.ended_at)}
        </td>
        <td className="px-3 py-2.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--text2)] font-mono">
            {stagesRatio}
          </span>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpanded(v => !v)}
              className="p-1 rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-colors"
              title="Dettagli"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--border)] bg-[var(--bg1)]">
          <td colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4 text-[11px]">
              <div>
                <p className="text-[var(--text3)] mb-1">Stage completati:</p>
                <div className="flex flex-wrap gap-1">
                  {(entry.stages_done > 0
                    ? Array.from({length: entry.stages_done}, (_, i) => ['story_analysis','narrative_arc','shot_list','prompt_generation','continuity_check','frame_gen','video_gen','assembly'][i])
                    : []
                  ).map(s => (
                    <span key={s} className="px-1.5 py-0.5 rounded bg-[var(--green)]/10 text-[var(--green)] font-mono text-[10px]">{s}</span>
                  ))}
                </div>
                {entry.error && (
                  <div className="mt-2">
                    <p className="text-[var(--text3)] mb-1">Errore:</p>
                    <p className="text-[var(--red)] font-mono text-[10px] break-all">{entry.error}</p>
                  </div>
                )}
              </div>
              <div>
                <p className="text-[var(--text3)] mb-1">Azioni:</p>
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => onReset(entry.project_id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors w-fit"
                  >
                    <RotateCcw size={10} /> Reset stato pipeline
                  </button>
                  <button
                    onClick={() => onClearFrames(entry.project_id)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[10px] border border-[var(--border)] text-[var(--text2)] hover:border-[var(--red)] hover:text-[var(--red)] transition-colors w-fit"
                  >
                    <Trash2 size={10} /> Elimina frame generati
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Project state rows ────────────────────────────────────────────────────────

const ALL_STAGES = ['story_analysis','narrative_arc','shot_list','prompt_generation','continuity_check','frame_gen','video_gen','assembly']

function ProjectStateRow({ proj, onReset }) {
  const pct = Math.round((proj.completed_stages.length / proj.total_stages) * 100)

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg2)]">
      <div className="w-8 h-8 rounded-lg bg-[var(--bg3)] flex items-center justify-center shrink-0">
        <Layers size={14} className="text-[var(--text3)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-[var(--text)] font-mono truncate">{proj.project_id}</span>
          <StatusBadge status={proj.status} />
          <span className="text-[10px] text-[var(--text3)] font-mono ml-auto">{pct}%</span>
        </div>
        <div className="flex gap-0.5">
          {ALL_STAGES.map(s => (
            <div
              key={s}
              title={s}
              className={clsx(
                'h-1.5 flex-1 rounded-sm',
                proj.completed_stages.includes(s)
                  ? 'bg-[var(--green)]'
                  : 'bg-[var(--bg3)]'
              )}
            />
          ))}
        </div>
      </div>
      <button
        onClick={() => onReset(proj.project_id)}
        title="Reset stato pipeline"
        className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10 transition-colors shrink-0"
      >
        <RotateCcw size={13} />
      </button>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function QueueScreen() {
  const [active,   setActive]   = useState([])
  const [audit,    setAudit]    = useState([])
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(false)
  const [toast,    setToast]    = useState(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3000)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [a, b, c] = await Promise.all([
        fetch(`${API}/queue/active`).then(r => r.json()),
        fetch(`${API}/queue/audit?limit=100`).then(r => r.json()),
        fetch(`${API}/queue/projects`).then(r => r.json()),
      ])
      setActive(a.active || [])
      setAudit(b.entries || [])
      setProjects(c.projects || [])
    } catch (e) {
      showToast(`Errore caricamento: ${e.message}`, false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 10s when there are active runs
  useEffect(() => {
    if (!active.length) return
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [active.length, load])

  async function resetState(projectId) {
    try {
      const r = await fetch(`${API}/queue/projects/${projectId}/state`, { method: 'DELETE' }).then(r => r.json())
      showToast(r.ok ? 'Stato pipeline resettato' : r.message, r.ok)
      load()
    } catch (e) { showToast(e.message, false) }
  }

  async function clearFrames(projectId) {
    if (!confirm(`Eliminare tutti i frame del progetto "${projectId}"?`)) return
    try {
      const r = await fetch(`${API}/queue/projects/${projectId}/frames`, { method: 'DELETE' }).then(r => r.json())
      showToast(`${r.deleted} frame eliminati`, true)
    } catch (e) { showToast(e.message, false) }
  }

  async function clearAudit() {
    if (!confirm('Cancellare tutto il log di audit?')) return
    try {
      await fetch(`${API}/queue/audit`, { method: 'DELETE' })
      setAudit([])
      showToast('Log di audit cancellato')
    } catch (e) { showToast(e.message, false) }
  }

  return (
    <div className="p-6 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ListChecks size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Code & Monitor</h1>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Aggiorna
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className={clsx(
          'fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm border shadow-xl',
          toast.ok
            ? 'bg-[var(--green)]/10 border-[var(--green)]/30 text-[var(--green)]'
            : 'bg-[var(--red)]/10 border-[var(--red)]/30 text-[var(--red)]'
        )}>
          {toast.msg}
        </div>
      )}

      {/* Active pipelines */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={14} className="text-[var(--gold)]" />
          <h2 className="text-sm font-medium text-[var(--text)]">Pipeline attive</h2>
          {active.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gold)]/20 text-[var(--gold)] font-mono">
              {active.length}
            </span>
          )}
        </div>
        {active.length === 0 ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-4 py-6 text-center">
            <p className="text-sm text-[var(--text3)]">Nessuna pipeline in esecuzione</p>
          </div>
        ) : (
          <div className="space-y-2">
            {active.map(run => <ActiveCard key={run.project_id} run={run} />)}
          </div>
        )}
      </section>

      {/* Pipeline state by project */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Layers size={14} className="text-[var(--text2)]" />
          <h2 className="text-sm font-medium text-[var(--text)]">Stato progetti</h2>
          <span className="text-[10px] text-[var(--text3)] font-mono">{projects.length} progetti con stato salvato</span>
        </div>
        {projects.length === 0 ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-4 py-6 text-center">
            <p className="text-sm text-[var(--text3)]">Nessun progetto con stato pipeline salvato</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {projects.map(p => (
              <ProjectStateRow key={p.project_id} proj={p} onReset={resetState} />
            ))}
          </div>
        )}
      </section>

      {/* Audit log */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-[var(--text2)]" />
            <h2 className="text-sm font-medium text-[var(--text)]">Audit log</h2>
            <span className="text-[10px] text-[var(--text3)] font-mono">{audit.length} esecuzioni</span>
          </div>
          {audit.length > 0 && (
            <button
              onClick={clearAudit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--red)]/30 text-[var(--red)]/70 hover:border-[var(--red)] hover:text-[var(--red)] transition-colors"
            >
              <Trash2 size={11} /> Cancella log
            </button>
          )}
        </div>

        {audit.length === 0 ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-4 py-6 text-center">
            <p className="text-sm text-[var(--text3)]">Log vuoto — avvia una pipeline per registrare la prima esecuzione</p>
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg2)]">
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Progetto</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Stato</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Avvio</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Durata</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Stage</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry, i) => (
                  <AuditRow
                    key={`${entry.run_id}-${i}`}
                    entry={entry}
                    onReset={resetState}
                    onClearFrames={clearFrames}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
