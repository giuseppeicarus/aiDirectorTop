import { useState, useEffect, useCallback, useRef } from 'react'
import {
  ListChecks, RefreshCw, Trash2, RotateCcw, CheckCircle,
  XCircle, Loader2, Clock, AlertTriangle, StopCircle,
  Image as ImageIcon, X, ChevronDown, ChevronUp,
  Activity, Layers, Cpu, Film, Clapperboard, Square,
  Wifi, WifiOff, ServerCrash,
} from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

const API = API_BASE

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
  cancelling: { color: 'text-[var(--amber)]', bg: 'bg-[var(--amber)]/10', Icon: Loader2,      spin: true,  label: 'Annullando…' },
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

function KindIcon({ kind }) {
  if (kind === 'reel') return <Film size={14} className="text-[var(--gold)]" />
  if (kind === 'trailer') return <Clapperboard size={14} className="text-[var(--gold)]" />
  return <Layers size={14} className="text-[var(--text3)]" />
}

// ── Active run card ───────────────────────────────────────────────────────────

function ActiveRunCard({ run, onCancel }) {
  const pct = run.kind === 'cinematic'
    ? Math.round((run.progress || 0) * 100)
    : Math.round((run.progress || 0) * 100)

  const isCancellable = run.cancellable && run.status === 'running'

  return (
    <div className={clsx(
      'rounded-lg border p-4 transition-all',
      run.status === 'cancelling'
        ? 'border-[var(--amber)]/30 bg-[var(--amber)]/5'
        : 'border-[var(--gold)]/30 bg-[var(--gold)]/5'
    )}>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-[var(--gold)]/15 flex items-center justify-center shrink-0">
          <Loader2 size={16} className="text-[var(--gold)] animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <KindIcon kind={run.kind} />
            <span className="text-sm font-medium text-[var(--text)] truncate">
              {run.title || run.project_title || run.project_id}
            </span>
            <StatusBadge status={run.status} />
            <span className="text-[10px] text-[var(--text3)] font-mono ml-auto capitalize">{run.kind}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-[var(--text3)]">
            <span className="font-mono">Stage: <span className="text-[var(--gold)]">{run.stage}</span></span>
            <span>{pct}%</span>
            <span className="flex items-center gap-1"><Clock size={10} /> {fmtDuration(run.started_at)}</span>
            {run.message && (
              <span className="text-[var(--text2)] truncate max-w-[200px]">{run.message}</span>
            )}
          </div>
          <div className="mt-2 h-1 rounded-full bg-[var(--bg3)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--gold)] transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {isCancellable && (
          <button
            onClick={() => onCancel(run.job_id || run.run_id)}
            title="Ferma job"
            className="shrink-0 p-1.5 rounded border border-[var(--red)]/40 text-[var(--red)]/60 hover:border-[var(--red)] hover:text-[var(--red)] hover:bg-[var(--red)]/10 transition-colors"
          >
            <Square size={12} />
          </button>
        )}
      </div>
    </div>
  )
}

// ── ComfyUI node queue card ───────────────────────────────────────────────────

function ComfyNodeCard({ node, onInterrupt, onClearQueue }) {
  const [expanded, setExpanded] = useState(false)
  const running = node.queue_running || []
  const pending = node.queue_pending || []
  const total = running.length + pending.length

  return (
    <div className={clsx(
      'rounded-lg border p-3',
      !node.online
        ? 'border-[var(--red)]/20 bg-[var(--red)]/5'
        : total > 0
          ? 'border-[var(--gold)]/30 bg-[var(--gold)]/5'
          : 'border-[var(--border)] bg-[var(--bg2)]'
    )}>
      <div className="flex items-center gap-2">
        <div className={clsx(
          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0',
          node.online ? 'bg-[var(--green)]/10' : 'bg-[var(--red)]/10'
        )}>
          {node.online
            ? <Cpu size={13} className="text-[var(--green)]" />
            : <ServerCrash size={13} className="text-[var(--red)]" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text)] truncate">{node.name}</span>
            {node.primary && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--gold)]/20 text-[var(--gold)] font-mono">PRIMARY</span>
            )}
            {!node.online && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-[var(--red)]/20 text-[var(--red)] font-mono">OFFLINE</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--text3)] font-mono">
            <span>{node.host}:{node.port}</span>
            {node.online && (
              <>
                <span className={clsx('text-[var(--gold)]', running.length > 0 && 'font-bold')}>
                  {running.length} running
                </span>
                <span>{pending.length} pending</span>
              </>
            )}
            {node.error && <span className="text-[var(--red)] truncate max-w-[200px]">{node.error}</span>}
          </div>
        </div>
        {node.online && total > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onInterrupt(node.index)}
              title="Interrompi job corrente"
              className="p-1.5 rounded border border-[var(--amber)]/40 text-[var(--amber)]/60 hover:border-[var(--amber)] hover:text-[var(--amber)] hover:bg-[var(--amber)]/10 transition-colors"
            >
              <StopCircle size={12} />
            </button>
            {pending.length > 0 && (
              <button
                onClick={() => onClearQueue(node.index)}
                title="Svuota coda pending"
                className="p-1.5 rounded border border-[var(--red)]/40 text-[var(--red)]/60 hover:border-[var(--red)] hover:text-[var(--red)] hover:bg-[var(--red)]/10 transition-colors"
              >
                <Trash2 size={12} />
              </button>
            )}
            <button
              onClick={() => setExpanded(v => !v)}
              className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-colors"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </div>
        )}
      </div>

      {expanded && (running.length > 0 || pending.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-[var(--border)] pt-3">
          {running.map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="px-1 py-0.5 rounded bg-[var(--gold)]/20 text-[var(--gold)] font-mono shrink-0">RUN</span>
              <span className="text-[var(--text2)] font-mono truncate">
                {Array.isArray(item) ? item[1] : JSON.stringify(item).slice(0, 60)}
              </span>
            </div>
          ))}
          {pending.map((item, i) => (
            <div key={i} className="flex items-center gap-2 text-[10px]">
              <span className="px-1 py-0.5 rounded bg-[var(--bg3)] text-[var(--text3)] font-mono shrink-0">#{i+1}</span>
              <span className="text-[var(--text3)] font-mono truncate">
                {Array.isArray(item) ? item[1] : JSON.stringify(item).slice(0, 60)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Audit log entry row ───────────────────────────────────────────────────────

function AuditRow({ entry, onReset, onClearFrames }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <tr className="border-b border-[var(--border)] hover:bg-[var(--bg2)] transition-colors">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <KindIcon kind={entry.kind || 'cinematic'} />
            <span className="text-xs text-[var(--text)] font-medium truncate max-w-[180px]">
              {entry.title || entry.project_title || entry.project_id}
            </span>
          </div>
          <div className="text-[10px] text-[var(--text3)] font-mono mt-0.5">
            {entry.job_id || entry.project_id}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <StatusBadge status={entry.status} />
        </td>
        <td className="px-3 py-2.5 text-[11px] text-[var(--text2)] font-mono">{fmtTime(entry.started_at)}</td>
        <td className="px-3 py-2.5 text-[11px] text-[var(--text2)] font-mono">
          {fmtDuration(entry.started_at, entry.ended_at)}
        </td>
        <td className="px-3 py-2.5">
          <button
            onClick={() => setExpanded(v => !v)}
            className="p-1 rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-[var(--border)] bg-[var(--bg1)]">
          <td colSpan={5} className="px-4 py-3">
            <div className="text-[11px] space-y-1">
              {entry.error && (
                <p className="text-[var(--red)] font-mono break-all">{entry.error}</p>
              )}
              {entry.kind === 'cinematic' && (
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
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Project state rows (cinematic legacy) ─────────────────────────────────────

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
                proj.completed_stages.includes(s) ? 'bg-[var(--green)]' : 'bg-[var(--bg3)]'
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
  const [runs,     setRuns]     = useState([])   // unified active
  const [comfyui,  setComfyui]  = useState([])   // node queue data
  const [audit,    setAudit]    = useState([])
  const [projects, setProjects] = useState([])
  const [loading,  setLoading]  = useState(false)
  const [comfyLoading, setComfyLoading] = useState(false)
  const [toast,    setToast]    = useState(null)
  const pollRef = useRef(null)

  const showToast = (msg, ok = true) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch(`${API}/queue/all`).then(r => r.json())
      setRuns(r.runs || [])
    } catch {}
  }, [])

  const loadComfyui = useCallback(async () => {
    setComfyLoading(true)
    try {
      const r = await fetch(`${API}/queue/comfyui`).then(r => r.json())
      setComfyui(r.nodes || [])
    } catch {}
    finally { setComfyLoading(false) }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, c] = await Promise.all([
        fetch(`${API}/queue/audit?limit=100`).then(r => r.json()),
        fetch(`${API}/queue/projects`).then(r => r.json()),
      ])
      setAudit(b.entries || [])
      setProjects(c.projects || [])
    } catch (e) {
      showToast(`Errore caricamento: ${e.message}`, false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRuns()
    load()
    loadComfyui()
  }, [loadRuns, load, loadComfyui])

  // Fast poll every 3s for live run state
  useEffect(() => {
    pollRef.current = setInterval(loadRuns, 3000)
    return () => clearInterval(pollRef.current)
  }, [loadRuns])

  // Refresh ComfyUI queue every 5s
  useEffect(() => {
    const t = setInterval(loadComfyui, 5000)
    return () => clearInterval(t)
  }, [loadComfyui])

  async function cancelJob(jobId) {
    try {
      const r = await fetch(`${API}/queue/cancel/${jobId}`, { method: 'POST' }).then(r => r.json())
      if (r.ok) {
        showToast('Job annullato')
        loadRuns()
      } else {
        showToast(r.detail || 'Errore annullamento', false)
      }
    } catch (e) { showToast(e.message, false) }
  }

  async function interruptComfyui(nodeIndex) {
    try {
      await fetch(`${API}/queue/comfyui/interrupt?node_index=${nodeIndex}`, { method: 'POST' })
      showToast(`Interrupt inviato al nodo ${nodeIndex}`)
      setTimeout(loadComfyui, 1000)
    } catch (e) { showToast(e.message, false) }
  }

  async function clearComfyuiQueue(nodeIndex) {
    if (!confirm('Svuotare la coda pending del nodo?')) return
    try {
      await fetch(`${API}/queue/comfyui/queue?node_index=${nodeIndex}`, { method: 'DELETE' })
      showToast('Coda svuotata')
      setTimeout(loadComfyui, 1000)
    } catch (e) { showToast(e.message, false) }
  }

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

  const comfyTotal = comfyui.reduce((s, n) => s + (n.queue_running?.length || 0) + (n.queue_pending?.length || 0), 0)

  return (
    <div className="p-6 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ListChecks size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Code & Monitor</h1>
        </div>
        <button
          onClick={() => { loadRuns(); load(); loadComfyui() }}
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

      {/* ── Active runs ───────────────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={14} className="text-[var(--gold)]" />
          <h2 className="text-sm font-medium text-[var(--text)]">Run attivi</h2>
          {runs.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gold)]/20 text-[var(--gold)] font-mono">
              {runs.length}
            </span>
          )}
          <span className="text-[10px] text-[var(--text3)] font-mono ml-1">aggiornato ogni 3s</span>
        </div>
        {runs.length === 0 ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-4 py-6 text-center">
            <p className="text-sm text-[var(--text3)]">Nessun run in corso</p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map(run => (
              <ActiveRunCard
                key={run.job_id || run.run_id || run.project_id}
                run={run}
                onCancel={cancelJob}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── ComfyUI queue ─────────────────────────────────────────────────── */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Cpu size={14} className="text-[var(--text2)]" />
          <h2 className="text-sm font-medium text-[var(--text)]">Coda ComfyUI</h2>
          {comfyTotal > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gold)]/20 text-[var(--gold)] font-mono">
              {comfyTotal} job
            </span>
          )}
          {comfyLoading && <Loader2 size={11} className="text-[var(--text3)] animate-spin" />}
        </div>
        {comfyui.length === 0 ? (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-4 py-6 text-center">
            <p className="text-sm text-[var(--text3)]">Nessun nodo ComfyUI configurato</p>
          </div>
        ) : (
          <div className="space-y-2">
            {comfyui.map(node => (
              <ComfyNodeCard
                key={node.index}
                node={node}
                onInterrupt={interruptComfyui}
                onClearQueue={clearComfyuiQueue}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Pipeline state by project (cinematic legacy) ─────────────────── */}
      {projects.length > 0 && (
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Layers size={14} className="text-[var(--text2)]" />
            <h2 className="text-sm font-medium text-[var(--text)]">Stato progetti (cinematic)</h2>
            <span className="text-[10px] text-[var(--text3)] font-mono">{projects.length} progetti</span>
          </div>
          <div className="space-y-1.5">
            {projects.map(p => (
              <ProjectStateRow key={p.project_id} proj={p} onReset={resetState} />
            ))}
          </div>
        </section>
      )}

      {/* ── Audit log ─────────────────────────────────────────────────────── */}
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
            <p className="text-sm text-[var(--text3)]">Log vuoto</p>
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--border)] overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg2)]">
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Job</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Stato</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Avvio</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium">Durata</th>
                  <th className="px-3 py-2 text-left text-[var(--text3)] font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {audit.map((entry, i) => (
                  <AuditRow
                    key={`${entry.run_id || entry.job_id}-${i}`}
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
