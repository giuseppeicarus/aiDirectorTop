import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Settings, RefreshCw, Eye, EyeOff,
  Server, Plus, Trash2, Check, X,
  Wifi, WifiOff, Loader2, Edit2, ChevronDown, ChevronUp,
  Cpu, Activity, BookOpen, Clapperboard, Camera, PenLine,
  ClipboardCheck, ChevronRight, Save, RotateCcw, Globe, Star,
  HardDrive, FolderOpen, ExternalLink,
  AlertTriangle, Film, Package, Database, Library, ShieldCheck, Sparkles,
  Download, Terminal,
} from 'lucide-react'
import clsx from 'clsx'
import { apiGet, waitForBackend, API_BASE } from '../utils/apiClient'
import RoleStudioPanel from '../components/RoleStudioPanel'

// ── Language data ─────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: 'it', label: 'Italiano',   llmName: 'Italian'    },
  { code: 'en', label: 'English',    llmName: 'English'    },
  { code: 'fr', label: 'Français',   llmName: 'French'     },
  { code: 'es', label: 'Español',    llmName: 'Spanish'    },
  { code: 'de', label: 'Deutsch',    llmName: 'German'     },
  { code: 'pt', label: 'Português',  llmName: 'Portuguese' },
  { code: 'ja', label: '日本語',      llmName: 'Japanese'   },
  { code: 'zh', label: '中文',        llmName: 'Chinese'    },
  { code: 'ko', label: '한국어',      llmName: 'Korean'     },
  { code: 'ru', label: 'Русский',    llmName: 'Russian'    },
  { code: 'ar', label: 'العربية',    llmName: 'Arabic'     },
]

const API = API_BASE

// ── Shared primitives ─────────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-[var(--border)] rounded-lg mb-4 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-[var(--bg2)] transition-colors"
      >
        <h3 className="font-display text-sm text-[var(--gold)] tracking-wider uppercase">{title}</h3>
        {open ? <ChevronUp size={14} className="text-[var(--text3)]" /> : <ChevronDown size={14} className="text-[var(--text3)]" />}
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="flex items-start gap-4 mb-3">
      <label className="w-36 text-[var(--text2)] text-xs pt-2 shrink-0">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  )
}

const inp = "w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none font-mono"
const sel = "w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"

// ── Language Section ──────────────────────────────────────────────────────────

function LanguageSection() {
  const [cfg, setCfg]             = useState({ ui_language: 'it', llm_language: 'Italian' })
  const [saving, setSaving]       = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForBackend()
      try {
        const d = await apiGet('/llm/language')
        if (!cancelled) setCfg(c => ({ ...c, ...d }))
      } catch {
        /* backend offline */
      }
    })()
    return () => { cancelled = true }
  }, [])

  function selectUiLanguage(lang) {
    setCfg(c => ({ ...c, ui_language: lang.code, llm_language: lang.llmName }))
  }

  function selectLlmLanguage(llmName) {
    setCfg(c => ({ ...c, llm_language: llmName }))
  }

  async function save() {
    setSaving(true)
    setSaveStatus(null)
    try {
      await fetch(`${API}/llm/language`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      })
      setSaveStatus({ ok: true, msg: 'Salvato — effettivo dalla prossima chiamata LLM' })
    } catch (e) {
      setSaveStatus({ ok: false, msg: `Errore: ${e.message}` })
    } finally {
      setSaving(false)
      setTimeout(() => setSaveStatus(null), 4000)
    }
  }

  const activeLang   = LANGUAGES.find(l => l.code === cfg.ui_language)   ?? LANGUAGES[0]
  const activeLlmLang = LANGUAGES.find(l => l.llmName === cfg.llm_language) ?? LANGUAGES[0]

  return (
    <Section title="Lingua">
      {/* UI language */}
      <Field label="Lingua app">
        <div className="flex flex-wrap gap-1.5">
          {LANGUAGES.map(lang => (
            <button
              key={lang.code}
              onClick={() => selectUiLanguage(lang)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-mono border transition-colors',
                cfg.ui_language === lang.code
                  ? 'border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]'
                  : 'border-[var(--border)] text-[var(--text3)] hover:border-[var(--border2)] hover:text-[var(--text2)]'
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text3)] mt-2">
          La lingua dell'interfaccia richiederà un riavvio per essere applicata completamente.
          Selezionando una lingua qui si imposta anche la lingua di risposta LLM.
        </p>
      </Field>

      {/* LLM response language — fine-grained override */}
      <Field label="Lingua risposte LLM">
        <div className="flex flex-wrap gap-1.5 mb-2">
          {LANGUAGES.map(lang => (
            <button
              key={lang.llmName}
              onClick={() => selectLlmLanguage(lang.llmName)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-xs font-mono border transition-colors',
                cfg.llm_language === lang.llmName
                  ? 'border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]'
                  : 'border-[var(--border)] text-[var(--text3)] hover:border-[var(--border2)] hover:text-[var(--text2)]'
              )}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <div className="rounded-lg bg-[var(--bg2)] border border-[var(--border)] px-3 py-2.5 mt-1">
          <p className="text-[10px] text-[var(--text3)] leading-relaxed">
            <span className="text-[var(--gold)] font-mono">Effetto immediato</span> — viene iniettato come direttiva in ogni prompt sistema inviato all'LLM.<br />
            Le descrizioni narrative, le emozioni, i titoli e le note di continuità verranno scritte in <span className="text-[var(--text)] font-mono">{cfg.llm_language}</span>.<br />
            <span className="text-[var(--text3)]">I prompt di generazione immagine/video rimangono in inglese per garantire la massima qualità dei modelli AI.</span>
          </p>
        </div>
      </Field>

      <div className="flex items-center justify-between pt-4 border-t border-[var(--border)]">
        <div className="flex items-center gap-2 text-[11px] text-[var(--text3)]">
          <Globe size={12} />
          UI: <span className="text-[var(--text2)] font-mono">{activeLang.label}</span>
          <span className="mx-1 opacity-40">·</span>
          LLM: <span className="text-[var(--text2)] font-mono">{cfg.llm_language}</span>
        </div>
        <div className="flex items-center gap-3">
          {saveStatus && (
            <span className={`text-xs ${saveStatus.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {saveStatus.msg}
            </span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-xs rounded bg-[var(--gold)]/15 hover:bg-[var(--gold)]/25 text-[var(--gold)] disabled:opacity-50 transition-colors"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Salvataggio...' : 'Salva'}
          </button>
        </div>
      </div>
    </Section>
  )
}

// ── Storage / cartelle progetto ───────────────────────────────────────────────

function StorageSection() {
  const [info, setInfo] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      await waitForBackend()
      const d = await apiGet('/services/storage')
      setInfo(d)
    } catch (e) {
      setErr(e.message || 'Errore caricamento storage')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openPath(p) {
    if (!p) return
    window.studio?.shell?.openPath?.(p)
  }

  return (
    <Section title="Archiviazione progetti">
      {loading && (
        <div className="flex items-center gap-2 text-xs text-[var(--text3)]">
          <Loader2 size={12} className="animate-spin" /> Caricamento percorsi…
        </div>
      )}
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      {info && (
        <>
          <Field label="Cartella dati">
            <code className="text-[10px] text-[var(--gold)] break-all block mb-2">
              {info.data_dir}
            </code>
            {info.free_gb != null && (
              <p className="text-[10px] text-[var(--text3)] mb-2">
                Spazio libero: {info.free_gb} GB / {info.total_gb} GB
              </p>
            )}
            <button
              type="button"
              onClick={() => openPath(info.data_dir)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)]
                         text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors"
            >
              <FolderOpen size={12} /> Apri cartella dati
            </button>
          </Field>

          <Field label="Progetti">
            <code className="text-[10px] text-[var(--gold)] break-all block mb-2">
              {info.projects_dir}
            </code>
            <p className="text-[10px] text-[var(--text3)] mb-2">
              {info.project_count ?? 0} cartelle — ogni progetto ha un file{' '}
              <span className="text-[var(--text2)]">project.json</span> con titolo e id.
            </p>
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={() => openPath(info.projects_dir)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)]
                           text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] transition-colors"
              >
                <HardDrive size={12} /> Apri cartella progetti
              </button>
              <button
                type="button"
                onClick={load}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded text-[var(--text3)]
                           hover:text-[var(--text2)] transition-colors"
              >
                <RefreshCw size={12} /> Aggiorna
              </button>
            </div>
            {info.projects?.length > 0 && (
              <ul className="max-h-36 overflow-y-auto border border-[var(--border)] rounded divide-y divide-[var(--border)]">
                {info.projects.slice(0, 12).map(p => (
                  <li key={p.id} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px]">
                    <span className="text-[var(--text2)] truncate" title={p.path}>
                      <span className="text-[var(--gold)] font-mono">{p.title}</span>
                      <span className="text-[var(--text3)] ml-1">({p.id.slice(0, 8)}…)</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => openPath(p.path)}
                      className="shrink-0 text-[var(--text3)] hover:text-[var(--gold)]"
                      title="Apri cartella"
                    >
                      <ExternalLink size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </>
      )}
    </Section>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

// ── Data Management Section ───────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// Modal asking about media fate before purge
function PurgeConfirmModal({ scope, stats, onConfirm, onCancel }) {
  const [keepMedia, setKeepMedia] = useState(true)
  const [busy, setBusy] = useState(false)

  const SCOPE_META = {
    projects: { label: 'tutti i Progetti',  icon: Package,     color: '#ef4444' },
    reels:    { label: 'tutti i Reel',       icon: Film,        color: '#f59e0b' },
    trailers: { label: 'tutti i Trailer',    icon: Clapperboard,color: '#f59e0b' },
    all:      { label: 'TUTTI i dati',       icon: Database,    color: '#ef4444' },
  }
  const meta = SCOPE_META[scope] || SCOPE_META.all
  const Icon = meta.icon
  const s = stats?.[scope] || (scope === 'all'
    ? { count: (stats?.projects?.count||0)+(stats?.reels?.count||0)+(stats?.trailers?.count||0),
        bytes: (stats?.projects?.bytes||0)+(stats?.reels?.bytes||0)+(stats?.trailers?.bytes||0) }
    : {})

  async function handleConfirm() {
    setBusy(true)
    await onConfirm(keepMedia)
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-[#0f0f18] border border-[#252533] rounded-xl w-full max-w-md shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#252533]">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: meta.color + '20' }}>
            <Icon size={16} style={{ color: meta.color }} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#e8e4dd]">Elimina {meta.label}</h3>
            {s.count > 0 && (
              <p className="text-[10px] font-mono text-[#9090a8] mt-0.5">
                {s.count} element{s.count !== 1 ? 'i' : 'o'} · {fmtBytes(s.bytes)} su disco
              </p>
            )}
          </div>
        </div>

        {/* Media choice */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-[#9090a8]">Cosa fare con i <strong className="text-[#e8e4dd]">file media generati</strong> (immagini e video)?</p>

          <label className={clsx(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            keepMedia ? 'border-[#c9a84c]/50 bg-[#c9a84c]/5' : 'border-[#252533] hover:border-[#32324a]'
          )}>
            <input type="radio" className="mt-0.5 accent-[#c9a84c]" checked={keepMedia} onChange={() => setKeepMedia(true)} />
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-[#e8e4dd] mb-0.5">
                <Library size={12} className="text-[#c9a84c]" /> Sposta nella Media Library
              </div>
              <p className="text-[10px] text-[#9090a8]">
                Le immagini e i video generati vengono copiati nella libreria generica prima di eliminare il progetto.
              </p>
            </div>
          </label>

          <label className={clsx(
            'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
            !keepMedia ? 'border-[#ef4444]/50 bg-[#ef4444]/5' : 'border-[#252533] hover:border-[#32324a]'
          )}>
            <input type="radio" className="mt-0.5 accent-[#ef4444]" checked={!keepMedia} onChange={() => setKeepMedia(false)} />
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-[#e8e4dd] mb-0.5">
                <Trash2 size={12} className="text-[#ef4444]" /> Elimina tutto definitivamente
              </div>
              <p className="text-[10px] text-[#9090a8]">
                Tutti i file vengono eliminati permanentemente dal disco. Operazione irreversibile.
              </p>
            </div>
          </label>

          {!keepMedia && (
            <div className="flex items-center gap-2 px-3 py-2 rounded border border-[#ef4444]/30 bg-[#ef4444]/8 text-[#ef4444] text-[10px]">
              <AlertTriangle size={11} className="shrink-0" />
              I file eliminati non potranno essere recuperati.
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#252533]">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-1.5 text-xs font-mono rounded border border-[#252533] text-[#9090a8] hover:text-[#e8e4dd] disabled:opacity-40"
          >
            Annulla
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-1.5 text-xs font-mono rounded transition-colors disabled:opacity-40',
              keepMedia
                ? 'bg-[#c9a84c] text-[#0a0a0f] hover:bg-[#e6c46a]'
                : 'bg-[#ef4444] text-white hover:bg-[#dc2626]'
            )}
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
            {busy ? 'Eliminazione…' : keepMedia ? 'Sposta e elimina' : 'Elimina tutto'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DataManagementSection() {
  const [stats, setStats] = useState(null)
  const [loadingStats, setLoadingStats] = useState(false)
  const [modal, setModal] = useState(null)   // scope being confirmed
  const [result, setResult] = useState(null) // last purge result
  const [error, setError] = useState(null)

  async function loadStats() {
    setLoadingStats(true)
    setError(null)
    try {
      const res = await fetch(`${API}/admin/stats`)
      if (!res.ok) throw new Error(await res.text())
      setStats(await res.json())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingStats(false)
    }
  }

  useEffect(() => { loadStats() }, [])

  async function handlePurge(keepMedia) {
    setError(null)
    try {
      const res = await fetch(`${API}/admin/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: modal, keep_media: keepMedia }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setResult({ scope: modal, ...data })
      setModal(null)
      await loadStats()
    } catch (e) {
      setError(e.message)
      setModal(null)
    }
  }

  const ROWS = [
    {
      scope: 'projects',
      label: 'Progetti',
      desc: 'Progetti standard con storyboard, pipeline e media associati.',
      icon: Package,
      color: '#3b82f6',
      count: stats?.projects?.count,
      bytes: stats?.projects?.bytes,
    },
    {
      scope: 'reels',
      label: 'Reel (CreateReel)',
      desc: 'Tutti i job CreateReel con clip, storyboard e file generati.',
      icon: Film,
      color: '#c9a84c',
      count: stats?.reels?.count,
      bytes: stats?.reels?.bytes,
      extra: stats?.reels?.job_count != null ? `${stats.reels.job_count} job` : null,
    },
    {
      scope: 'trailers',
      label: 'Trailer',
      desc: 'Tutti i job Trailer con frame, clip e video finali.',
      icon: Clapperboard,
      color: '#c9a84c',
      count: stats?.trailers?.count,
      bytes: stats?.trailers?.bytes,
      extra: stats?.trailers?.job_count != null ? `${stats.trailers.job_count} job` : null,
    },
    {
      scope: 'all',
      label: 'Tutto',
      desc: 'Elimina tutti i progetti, reel e trailer in una sola operazione.',
      icon: Database,
      color: '#ef4444',
      count: stats
        ? (stats.projects.count + stats.reels.count + stats.trailers.count)
        : undefined,
      bytes: stats
        ? (stats.projects.bytes + stats.reels.bytes + stats.trailers.bytes)
        : undefined,
    },
  ]

  return (
    <Section title="Gestione Dati & Reset" defaultOpen={false}>
      <p className="text-xs text-[var(--text3)] mb-4 leading-relaxed">
        Elimina definitivamente progetti, reel e trailer dal database e dal disco.
        Puoi scegliere di spostare i file media nella libreria prima di eliminare.
      </p>

      {error && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded border border-red-500/30 bg-red-500/8 text-xs text-red-400">
          <AlertTriangle size={11} className="shrink-0" />
          {error}
        </div>
      )}

      {result && (
        <div className="mb-4 px-3 py-3 rounded-lg border border-[#22c55e]/30 bg-[#22c55e]/5 text-xs font-mono">
          <div className="flex items-center gap-1.5 text-[#22c55e] font-semibold mb-1.5">
            <ShieldCheck size={12} /> Eliminazione completata
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[#9090a8]">
            {result.deleted_projects > 0 && <span>Progetti eliminati: <strong className="text-[#e8e4dd]">{result.deleted_projects}</strong></span>}
            {result.deleted_reels > 0 && <span>Reel eliminati: <strong className="text-[#e8e4dd]">{result.deleted_reels}</strong></span>}
            {result.deleted_trailers > 0 && <span>Trailer eliminati: <strong className="text-[#e8e4dd]">{result.deleted_trailers}</strong></span>}
            {result.media_moved > 0 && <span>Media spostati: <strong className="text-[#c9a84c]">{result.media_moved}</strong></span>}
            {result.media_deleted > 0 && <span>Media eliminati: <strong className="text-[#ef4444]">{result.media_deleted}</strong></span>}
            {result.bytes_freed > 0 && <span>Spazio liberato: <strong className="text-[#e8e4dd]">{fmtBytes(result.bytes_freed)}</strong></span>}
          </div>
        </div>
      )}

      {/* Refresh stats */}
      <div className="flex items-center justify-end mb-3">
        <button
          onClick={loadStats}
          disabled={loadingStats}
          className="flex items-center gap-1.5 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--text2)] disabled:opacity-40"
        >
          {loadingStats ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          Aggiorna statistiche
        </button>
      </div>

      <div className="space-y-2">
        {ROWS.map(row => {
          const Icon = row.icon
          const isEmpty = row.count === 0
          const isAll = row.scope === 'all'
          return (
            <div
              key={row.scope}
              className={clsx(
                'flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors',
                isAll ? 'border-[#ef4444]/20 bg-[#ef4444]/4' : 'border-[#252533] bg-[#16161f]',
              )}
            >
              <div
                className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                style={{ background: row.color + '18' }}
              >
                <Icon size={14} style={{ color: row.color }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[#e8e4dd]">{row.label}</span>
                  {loadingStats && <Loader2 size={9} className="animate-spin text-[#555568]" />}
                  {!loadingStats && row.count != null && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#1e1e2a] text-[#9090a8]">
                      {row.count} {isAll ? 'totali' : row.scope === 'projects' ? 'progett' + (row.count !== 1 ? 'i' : 'o') : 'director'}
                      {row.extra && ` · ${row.extra}`}
                      {row.bytes > 0 && ` · ${fmtBytes(row.bytes)}`}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[#555568] mt-0.5 truncate">{row.desc}</p>
              </div>
              <button
                onClick={() => { setResult(null); setModal(row.scope) }}
                disabled={isEmpty || loadingStats}
                className={clsx(
                  'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded text-[10px] font-mono transition-colors disabled:opacity-30',
                  isAll
                    ? 'border border-[#ef4444]/40 text-[#ef4444] hover:bg-[#ef4444]/10'
                    : 'border border-[#252533] text-[#9090a8] hover:border-[#ef4444]/40 hover:text-[#ef4444]'
                )}
              >
                <Trash2 size={10} />
                Elimina
              </button>
            </div>
          )
        })}
      </div>

      {modal && (
        <PurgeConfirmModal
          scope={modal}
          stats={stats}
          onConfirm={handlePurge}
          onCancel={() => setModal(null)}
        />
      )}
    </Section>
  )
}

export default function SettingsScreen() {
  return (
    <div className="p-6 max-w-2xl mx-auto overflow-y-auto h-full">
      <div className="flex items-center gap-3 mb-6">
        <Settings size={18} className="text-[var(--gold)]" />
        <h1 className="font-display text-xl text-[var(--text)]">Impostazioni</h1>
      </div>

      <LanguageSection />
      <StorageSection />
      <LlmSection />
      <LlmAgentsSection />
      <LlmModelRegistrySection />
      <ComfyUINodesSection />
      <ComfyUIModelScriptsSection />
      <DataManagementSection />

      <Section title="Informazioni" defaultOpen={false}>
        <p className="text-[var(--text3)] text-xs leading-relaxed">
          La configurazione viene salvata in{' '}
          <code className="text-[var(--gold)]">~/.cinematic-studio/config.yaml</code>.<br />
          Le API key non vengono mai inviate a server esterni.
        </p>
      </Section>
    </div>
  )
}

// ── Shared: model picker (tags rilevati, cliccabili) ─────────────────────────

function ModelTags({ models, onSelect }) {
  if (!models?.length) return null
  return (
    <div className="mt-2">
      <p className="text-[10px] text-[var(--text3)] mb-1.5">Modelli rilevati — clicca per selezionare</p>
      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pr-1">
        {models.map(m => (
          <button
            key={m}
            onClick={() => onSelect(m)}
            className="text-[10px] px-2 py-0.5 rounded font-mono border border-[var(--border)] text-[var(--text2)]
                       hover:border-[var(--gold)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/5
                       transition-colors truncate max-w-[200px]"
            title={m}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  )
}

function StudioModelSuggestButton({ suggestedModel, matches, onApply }) {
  if (!suggestedModel) return null
  return (
    <button
      type="button"
      onClick={onApply}
      title={
        matches
          ? 'Il modello coincide con il consiglio dello Studio Regia AI'
          : 'Imposta nel campo Modello il consiglio dello Studio Regia AI'
      }
      className={clsx(
        'mt-1.5 w-full flex items-center gap-1.5 text-left text-[10px] font-mono px-2 py-1.5 rounded border transition-colors min-w-0',
        matches
          ? 'border-[var(--green)]/45 bg-[var(--green)]/12 text-[var(--green)]'
          : 'border-[var(--amber)]/45 bg-[var(--amber)]/10 text-[var(--amber)] hover:bg-[var(--amber)]/18 hover:border-[var(--amber)]/65',
      )}
    >
      <Sparkles size={10} className="shrink-0 opacity-80" />
      <span className="truncate flex-1">
        {matches ? 'Consiglio studio' : 'Applica consiglio studio'}: {suggestedModel}
      </span>
      {matches && <Check size={10} className="shrink-0" />}
    </button>
  )
}

async function fetchModels(cfg) {
  const res = await fetch(`${API}/llm/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).then(r => r.json())
  return res.ok ? res.models : []
}

// ── LLM Section ───────────────────────────────────────────────────────────────

function LlmSection() {
  const [cfg, setCfg] = useState({ provider: 'lmstudio', model: '', api_key: '', base_url: '', temperature: 0.7, max_tokens: 4096 })
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus]   = useState(null)   // { ok, msg }
  const [models, setModels]   = useState(null)   // string[] | null
  const [testing, setTesting] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForBackend()
      try {
        const d = await apiGet('/llm/config')
        if (!cancelled) setCfg(c => ({ ...c, ...d }))
      } catch {
        /* backend offline */
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function testAndDiscover() {
    setTesting(true)
    setStatus(null)
    setModels(null)
    try {
      const ready = await waitForBackend()
      if (!ready) {
        setStatus({ ok: false, msg: '✗ Backend non avviato (avvia npm run dev)' })
        return
      }
      const payload = {
        ...cfg,
        base_url: (cfg.base_url || '').trim() || null,
        api_key: (cfg.api_key || '').trim() || null,
      }
      const [health, discovered] = await Promise.all([
        fetch(`${API}/llm/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json()),
        fetchModels(payload).catch(() => []),
      ])
      setStatus({
        ok: health.ok,
        msg: health.ok
          ? `✓ ${health.provider} — connesso${health.base_url ? ` (${health.base_url})` : ''}`
          : `✗ ${health.error || 'Non raggiungibile'}`,
      })
      if (discovered.length) setModels(discovered)
    } catch (e) {
      setStatus({ ok: false, msg: `✗ ${e.message}` })
    } finally {
      setTesting(false)
    }
  }

  async function saveLLM() {
    setSaving(true)
    setSaveStatus(null)
    try {
      const res = await fetch(`${API}/llm/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).then(r => r.json())
      setSaveStatus(res.ok
        ? { ok: true,  msg: 'Configurazione salvata' }
        : { ok: false, msg: `Errore: ${res.error || 'sconosciuto'}` })
    } catch (e) {
      setSaveStatus({ ok: false, msg: `Errore: ${e.message}` })
    } finally {
      setSaving(false)
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }

  return (
    <Section title="Provider LLM Globale">
      <Field label="Provider">
        <select className={sel} value={cfg.provider}
          onChange={e => { setCfg(c => ({ ...c, provider: e.target.value })); setModels(null) }}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="ollama">Ollama (locale)</option>
          <option value="lmstudio">LM Studio (locale)</option>
          <option value="groq">Groq</option>
        </select>
      </Field>

      <Field label="Modello">
        <input
          className={inp}
          value={cfg.model}
          onChange={e => setCfg(c => ({ ...c, model: e.target.value }))}
          placeholder="gpt-4o · claude-sonnet-4-6 · llama3..."
        />
        <ModelTags models={models} onSelect={m => setCfg(c => ({ ...c, model: m }))} />
      </Field>

      <Field label="API Key">
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            className={inp + ' pr-9'}
            value={cfg.api_key || ''}
            onChange={e => setCfg(c => ({ ...c, api_key: e.target.value }))}
            placeholder="sk-..."
          />
          <button className="absolute right-2 top-2 text-[var(--text3)] hover:text-[var(--text2)]"
            onClick={() => setShowKey(v => !v)}>
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </Field>

      <Field label="Base URL">
        <input
          className={inp}
          value={cfg.base_url || ''}
          onChange={e => setCfg(c => ({ ...c, base_url: e.target.value }))}
          placeholder="http://192.168.1.2:8083/v1"
        />
      </Field>

      <Field label="Temperature">
        <div className="flex items-center gap-3">
          <input type="range" min="0" max="1" step="0.05" value={cfg.temperature}
            onChange={e => setCfg(c => ({ ...c, temperature: parseFloat(e.target.value) }))}
            className="flex-1 accent-[var(--gold)]" />
          <span className="text-[var(--gold)] w-8 text-right font-mono text-xs">{cfg.temperature}</span>
        </div>
      </Field>

      <div className="flex items-center justify-between mt-5 pt-4 border-t border-[var(--border)]">
        <div className="flex items-center gap-3">
          <button onClick={testAndDiscover} disabled={testing || saving}
            className="flex items-center gap-2 px-4 py-2 text-xs rounded border border-[var(--gold)] text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-50 transition-colors">
            <RefreshCw size={12} className={testing ? 'animate-spin' : ''} />
            {testing ? 'Connessione...' : 'Testa e rileva modelli'}
          </button>
          {status && (
            <span className={`text-xs ${status.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {status.msg}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {saveStatus && (
            <span className={`text-xs ${saveStatus.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {saveStatus.msg}
            </span>
          )}
          <button onClick={saveLLM} disabled={saving || testing}
            className="flex items-center gap-2 px-4 py-2 text-xs rounded bg-[var(--gold)]/15 hover:bg-[var(--gold)]/25 text-[var(--gold)] disabled:opacity-50 transition-colors">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? 'Salvataggio...' : 'Salva configurazione'}
          </button>
        </div>
      </div>
    </Section>
  )
}

// ── LLM Agents Section ────────────────────────────────────────────────────────

const ROLES_META = [
  {
    key: 'story_analyst',
    label: 'Analista Narrativo',
    subtitle: 'LLM 1 — Analizza brief, liriche e emozioni',
    Icon: BookOpen,
    defaultTemp: 0.85,
    defaultTokens: 2000,
  },
  {
    key: 'narrative_director',
    label: 'Regista Narrativo',
    subtitle: 'LLM 2 — Genera arco narrativo e struttura',
    Icon: Clapperboard,
    defaultTemp: 0.70,
    defaultTokens: 4000,
  },
  {
    key: 'cinematographer',
    label: 'Direttore della Fotografia',
    subtitle: 'LLM 3 — Assegna camera, luce e transizioni',
    Icon: Camera,
    defaultTemp: 0.55,
    defaultTokens: 6000,
  },
  {
    key: 'prompt_engineer',
    label: 'Prompt Engineer',
    subtitle: 'LLM 4 — Genera prompt immagine e video',
    Icon: PenLine,
    defaultTemp: 0.65,
    defaultTokens: 8000,
  },
  {
    key: 'continuity_checker',
    label: 'Supervisore Continuità',
    subtitle: 'LLM 5 — Verifica errori di continuità tra clip',
    Icon: ClipboardCheck,
    defaultTemp: 0.20,
    defaultTokens: 3000,
  },
]

const ROLE_DEFAULTS = (meta) => ({
  custom: false,
  provider: 'lmstudio',
  model: '',
  api_key: '',
  base_url: '',
  temperature: meta.defaultTemp,
  max_tokens: meta.defaultTokens,
})

function LlmAgentsSection() {
  const [roles, setRoles]         = useState({})         // { [key]: RoleConfig }
  const [open, setOpen]           = useState({})          // { [key]: bool }
  const [showKey, setShowKey]     = useState({})          // { [key]: bool }
  const [testing, setTesting]     = useState({})          // { [key]: bool }
  const [testResult, setTestResult] = useState({})       // { [key]: {ok,msg} }
  const [roleModels, setRoleModels] = useState({})       // { [key]: string[] }
  const [saving, setSaving]       = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [globalLlmOk, setGlobalLlmOk] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioLoading, setStudioLoading] = useState(false)
  const [studioError, setStudioError] = useState(null)
  const [studioSummary, setStudioSummary] = useState('')
  const [studioAssignments, setStudioAssignments] = useState([])
  const [studioProvider, setStudioProvider] = useState('')
  const [studioModelsCount, setStudioModelsCount] = useState(0)
  const [studioVerifyLoading, setStudioVerifyLoading] = useState(false)
  const [studioVerifyResults, setStudioVerifyResults] = useState({})
  const [studioVerifySummary, setStudioVerifySummary] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForBackend()
      try {
        const [data, health] = await Promise.all([
          apiGet('/llm/roles'),
          apiGet('/llm/health').catch(() => ({ ok: false })),
        ])
        if (cancelled) return
        setGlobalLlmOk(!!health?.ok)
        const merged = {}
        for (const meta of ROLES_META) {
          merged[meta.key] = { ...ROLE_DEFAULTS(meta), ...(data[meta.key] || {}) }
        }
        setRoles(merged)
      } catch {
        if (cancelled) return
        setGlobalLlmOk(false)
        const defaults = {}
        for (const meta of ROLES_META) defaults[meta.key] = ROLE_DEFAULTS(meta)
        setRoles(defaults)
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function runRoleStudio() {
    setStudioOpen(true)
    setStudioLoading(true)
    setStudioError(null)
    setStudioSummary('')
    setStudioAssignments([])
    setStudioVerifyResults({})
    setStudioVerifySummary(null)
    try {
      const res = await fetch(`${API}/llm/roles/studio`, { method: 'POST' }).then(r => r.json())
      if (!res.ok) {
        setStudioError(res.error || 'Studio non disponibile')
        return
      }
      setStudioSummary(res.summary || '')
      setStudioAssignments(res.assignments || [])
      setStudioProvider(res.provider || '')
      setStudioModelsCount(res.models_count || 0)
    } catch (e) {
      setStudioError(e.message || 'Errore di connessione')
    } finally {
      setStudioLoading(false)
    }
  }

  async function verifyRoleStudioModels() {
    if (!studioAssignments.length) return
    setStudioVerifyLoading(true)
    setStudioVerifyResults({})
    setStudioVerifySummary({ passed: 0, total: studioAssignments.length, current_model: null })

    const pending = {}
    for (const a of studioAssignments) {
      pending[a.role] = { checking: false, ok: null, message: 'In coda…', pending: true }
    }
    setStudioVerifyResults(pending)

    const byModel = {}
    for (const a of studioAssignments) {
      if (!byModel[a.model]) byModel[a.model] = []
      byModel[a.model].push(a)
    }

    let passed = 0

    try {
      for (const [model, agents] of Object.entries(byModel)) {
        setStudioVerifySummary(s => ({ ...s, current_model: model }))

        setStudioVerifyResults(prev => {
          const next = { ...prev }
          for (const a of agents) {
            next[a.role] = { checking: true, ok: null, message: `Verifica ${model}…`, pending: false }
          }
          return next
        })

        const res = await fetch(`${API}/llm/roles/studio/verify-model`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            assignments: agents,
          }),
        }).then(r => r.json())

        let batchPassed = 0
        setStudioVerifyResults(prev => {
          const next = { ...prev }
          for (const a of agents) {
            const r = res.results?.find(x => x.role === a.role)
            if (r) {
              next[a.role] = { ...r, checking: false, pending: false }
              if (r.ok) batchPassed += 1
            } else {
              next[a.role] = {
                ok: false,
                message: res.error || res.message || 'Verifica fallita',
                checking: false,
                pending: false,
                model,
              }
            }
          }
          return next
        })
        passed += batchPassed

        setStudioVerifySummary({
          passed,
          total: studioAssignments.length,
          current_model: model,
        })
      }

      window.dispatchEvent(new CustomEvent('llm-registry-updated'))
    } catch (e) {
      const failed = {}
      for (const a of studioAssignments) {
        failed[a.role] = { ok: false, message: e.message, checking: false, pending: false }
      }
      setStudioVerifyResults(failed)
      setStudioVerifySummary({ passed: 0, total: studioAssignments.length, current_model: null })
    } finally {
      setStudioVerifyLoading(false)
      setStudioVerifySummary(s => (s ? { ...s, current_model: null } : s))
    }
  }

  const studioByRole = useMemo(() => {
    const map = {}
    for (const a of studioAssignments) {
      if (a?.role) map[a.role] = a.model
    }
    return map
  }, [studioAssignments])

  async function acceptRoleStudio() {
    try {
      const globalCfg = await apiGet('/llm/config')
      const next = { ...roles }
      for (const a of studioAssignments) {
        const meta = ROLES_META.find(m => m.key === a.role)
        if (!meta) continue
        next[a.role] = {
          custom: true,
          provider: globalCfg.provider || 'lmstudio',
          model: a.model,
          api_key: '',
          base_url: globalCfg.base_url || '',
          temperature: a.temperature ?? meta.defaultTemp,
          max_tokens: a.max_tokens ?? meta.defaultTokens,
        }
      }
      setRoles(next)
      setStudioOpen(false)
      setSaving(true)
      await fetch(`${API}/llm/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: next }),
      })
      setSaveStatus({ ok: true, msg: 'Regia AI configurata dallo studio' })
      setTimeout(() => setSaveStatus(null), 4000)
    } catch (e) {
      setSaveStatus({ ok: false, msg: `Errore: ${e.message}` })
    } finally {
      setSaving(false)
    }
  }

  function patchRole(key, patch) {
    setRoles(r => ({ ...r, [key]: { ...r[key], ...patch } }))
  }

  function toggleOpen(key) {
    setOpen(o => ({ ...o, [key]: !o[key] }))
  }

  async function testRole(meta) {
    const cfg = roles[meta.key]
    if (!cfg) return
    setTesting(t => ({ ...t, [meta.key]: true }))
    setTestResult(r => ({ ...r, [meta.key]: null }))
    setRoleModels(m => ({ ...m, [meta.key]: null }))

    const payload = {
      provider: cfg.provider,
      model: cfg.model,
      api_key: cfg.api_key || null,
      base_url: cfg.base_url || null,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
    }

    try {
      const [res, discovered] = await Promise.all([
        fetch(`${API}/llm/roles/${meta.key}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json()),
        fetchModels(payload).catch(() => []),
      ])
      setTestResult(r => ({
        ...r,
        [meta.key]: {
          ok: res.ok,
          msg: res.ok
            ? `✓ ${res.provider} — ${res.model}`
            : `✗ ${res.error || 'Non raggiungibile'}`,
        },
      }))
      if (discovered.length) setRoleModels(m => ({ ...m, [meta.key]: discovered }))
    } catch (e) {
      setTestResult(r => ({ ...r, [meta.key]: { ok: false, msg: `✗ ${e.message}` } }))
    } finally {
      setTesting(t => ({ ...t, [meta.key]: false }))
    }
  }

  async function saveAll() {
    setSaving(true)
    setSaveStatus(null)
    try {
      await fetch(`${API}/llm/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles }),
      })
      setSaveStatus({ ok: true, msg: 'Configurazione salvata' })
    } catch (e) {
      setSaveStatus({ ok: false, msg: `Errore: ${e.message}` })
    } finally {
      setSaving(false)
      setTimeout(() => setSaveStatus(null), 3000)
    }
  }

  const customCount = Object.values(roles).filter(r => r?.custom).length

  return (
    <Section title="Agenti Pipeline (Regia AI)">
      <p className="text-[var(--text3)] text-xs mb-4 leading-relaxed">
        Ogni fase della pipeline usa un agente LLM dedicato. Se non personalizzato, l'agente eredita il provider globale.
      </p>

      {globalLlmOk && (
        <div className="mb-4 p-3 rounded-lg border border-[var(--gold)]/25 bg-[var(--gold)]/6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-[var(--text)] font-medium">Studio Regia AI</p>
              <p className="text-[10px] text-[var(--text3)] mt-0.5 max-w-md">
                L&apos;LLM analizza i modelli disponibili sul provider globale e propone la configurazione ottimale per ogni agente.
              </p>
            </div>
            <button
              type="button"
              onClick={runRoleStudio}
              disabled={studioLoading}
              className="flex items-center gap-2 px-4 py-2 text-xs rounded border border-[var(--gold)] text-[var(--gold)] hover:bg-[var(--gold)]/12 disabled:opacity-50 transition-colors shrink-0"
            >
              <Sparkles size={14} className={studioLoading ? 'animate-pulse' : ''} />
              {studioLoading ? 'Studio in corso…' : 'Avvia studio modelli'}
            </button>
          </div>
        </div>
      )}

      {!globalLlmOk && (
        <p className="text-[11px] text-[var(--text3)] mb-4 italic">
          Configura e testa il provider LLM globale per abilitare lo Studio Regia AI.
        </p>
      )}

      <RoleStudioPanel
        open={studioOpen}
        loading={studioLoading}
        error={studioError}
        summary={studioSummary}
        assignments={studioAssignments}
        provider={studioProvider}
        modelsCount={studioModelsCount}
        verifyLoading={studioVerifyLoading}
        verifyResults={studioVerifyResults}
        verifySummary={studioVerifySummary}
        onClose={() => setStudioOpen(false)}
        onAccept={acceptRoleStudio}
        onVerifyModels={verifyRoleStudioModels}
      />

      <div className="space-y-2">
        {ROLES_META.map(meta => {
          const cfg = roles[meta.key] || ROLE_DEFAULTS(meta)
          const isOpen = !!open[meta.key]
          const isCustom = cfg.custom
          const isTesting = !!testing[meta.key]
          const result = testResult[meta.key]
          const discoveredModels = roleModels[meta.key]
          const suggestedModel = studioByRole[meta.key]
          const currentModel = (cfg.model || '').trim()
          const studioMatches = suggestedModel && currentModel === suggestedModel.trim()

          return (
            <div key={meta.key} className={clsx(
              'rounded-lg border transition-colors',
              isCustom
                ? 'border-[var(--gold)]/30 bg-[var(--bg1)]'
                : 'border-[var(--border)] bg-[var(--bg2)]'
            )}>
              {/* Header row */}
              <button
                onClick={() => toggleOpen(meta.key)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
              >
                <meta.Icon size={15} className={isCustom ? 'text-[var(--gold)]' : 'text-[var(--text3)]'} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--text)] font-medium">{meta.label}</span>
                    <span className={clsx(
                      'text-[10px] px-1.5 py-0.5 rounded font-mono',
                      isCustom
                        ? 'bg-[var(--gold)]/15 text-[var(--gold)]'
                        : 'bg-[var(--bg3)] text-[var(--text3)]'
                    )}>
                      {isCustom ? 'personalizzato' : 'globale'}
                    </span>
                    {isCustom && cfg.model && (
                      <span className="text-[10px] text-[var(--text3)] font-mono truncate hidden sm:block">
                        {cfg.provider} / {cfg.model}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-[var(--text3)] mt-0.5">{meta.subtitle}</p>
                </div>
                {isOpen
                  ? <ChevronUp size={13} className="text-[var(--text3)] shrink-0" />
                  : <ChevronDown size={13} className="text-[var(--text3)] shrink-0" />
                }
              </button>

              {/* Expanded config */}
              {isOpen && (
                <div className="px-4 pb-4 border-t border-[var(--border)] pt-4">
                  {/* Use custom toggle */}
                  <div className="flex items-center gap-3 mb-4">
                    <button
                      onClick={() => patchRole(meta.key, { custom: !isCustom })}
                      className={clsx(
                        'relative w-9 h-5 rounded-full transition-colors shrink-0',
                        isCustom ? 'bg-[var(--gold)]' : 'bg-[var(--bg3)]'
                      )}
                    >
                      <span className={clsx(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
                        isCustom ? 'translate-x-4' : 'translate-x-0.5'
                      )} />
                    </button>
                    <span className="text-xs text-[var(--text2)]">
                      {isCustom ? 'Usa configurazione personalizzata' : 'Usa provider globale'}
                    </span>
                    {!isCustom && (
                      <span className="text-[11px] text-[var(--text3)]">
                        — attiva per personalizzare questo agente
                      </span>
                    )}
                  </div>

                  {isCustom && (
                    <div className="space-y-3">
                      {/* Provider + Model */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[10px] text-[var(--text3)] mb-1">Provider</label>
                          <select
                            className={sel}
                            value={cfg.provider}
                            onChange={e => patchRole(meta.key, { provider: e.target.value })}
                          >
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="ollama">Ollama (locale)</option>
                            <option value="lmstudio">LM Studio (locale)</option>
                            <option value="groq">Groq</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] text-[var(--text3)] mb-1">Modello</label>
                          <input
                            className={clsx(
                              inp,
                              suggestedModel && studioMatches && 'border-[var(--green)]/50 focus:border-[var(--green)]',
                              suggestedModel && !studioMatches && 'border-[var(--amber)]/35',
                            )}
                            value={cfg.model}
                            onChange={e => patchRole(meta.key, { model: e.target.value })}
                            placeholder="gpt-4o, claude-sonnet-4-6…"
                          />
                          <StudioModelSuggestButton
                            suggestedModel={suggestedModel}
                            matches={!!studioMatches}
                            onApply={() => patchRole(meta.key, {
                              custom: true,
                              model: suggestedModel,
                            })}
                          />
                          <ModelTags
                            models={discoveredModels}
                            onSelect={m => patchRole(meta.key, { model: m })}
                          />
                        </div>
                      </div>

                      {/* API Key */}
                      <div>
                        <label className="block text-[10px] text-[var(--text3)] mb-1">
                          API Key <span className="text-[var(--text3)]">(lascia vuoto per ereditare dal globale)</span>
                        </label>
                        <div className="relative">
                          <input
                            type={showKey[meta.key] ? 'text' : 'password'}
                            className={inp + ' pr-9'}
                            value={cfg.api_key || ''}
                            onChange={e => patchRole(meta.key, { api_key: e.target.value })}
                            placeholder="sk-… (opzionale)"
                          />
                          <button
                            className="absolute right-2 top-2 text-[var(--text3)] hover:text-[var(--text2)]"
                            onClick={() => setShowKey(k => ({ ...k, [meta.key]: !k[meta.key] }))}
                          >
                            {showKey[meta.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>

                      {/* Base URL */}
                      <div>
                        <label className="block text-[10px] text-[var(--text3)] mb-1">
                          Base URL <span className="text-[var(--text3)]">(lascia vuoto per ereditare dal globale)</span>
                        </label>
                        <input
                          className={inp}
                          value={cfg.base_url || ''}
                          onChange={e => patchRole(meta.key, { base_url: e.target.value })}
                          placeholder="http://localhost:1234/v1 (opzionale)"
                        />
                      </div>

                      {/* Temperature + Max tokens */}
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[10px] text-[var(--text3)] mb-1">Temperature</label>
                          <div className="flex items-center gap-2">
                            <input
                              type="range" min="0" max="1" step="0.05"
                              value={cfg.temperature}
                              onChange={e => patchRole(meta.key, { temperature: parseFloat(e.target.value) })}
                              className="flex-1 accent-[var(--gold)]"
                            />
                            <span className="text-[var(--gold)] w-8 text-right font-mono text-xs">
                              {cfg.temperature.toFixed(2)}
                            </span>
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] text-[var(--text3)] mb-1">Max tokens</label>
                          <input
                            className={inp}
                            type="number" min="100" max="32000" step="100"
                            value={cfg.max_tokens}
                            onChange={e => patchRole(meta.key, { max_tokens: parseInt(e.target.value, 10) })}
                          />
                        </div>
                      </div>

                      {/* Test button + result */}
                      <div className="flex items-center gap-3 pt-1">
                        <button
                          onClick={() => testRole(meta)}
                          disabled={isTesting || !cfg.model}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
                        >
                          <RefreshCw size={11} className={isTesting ? 'animate-spin' : ''} />
                          {isTesting ? 'Connessione...' : 'Testa e rileva modelli'}
                        </button>
                        {result && (
                          <span className={`text-xs ${result.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                            {result.msg}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer — save all */}
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--border)]">
        <span className="text-[11px] text-[var(--text3)]">
          {customCount} di {ROLES_META.length} agenti personalizzati
        </span>
        <div className="flex items-center gap-3">
          {saveStatus && (
            <span className={`text-xs ${saveStatus.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {saveStatus.msg}
            </span>
          )}
          <button
            onClick={saveAll}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded bg-[var(--gold)]/15 hover:bg-[var(--gold)]/25 text-[var(--gold)] disabled:opacity-40 transition-colors"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            {saving ? 'Salvataggio...' : 'Salva configurazione agenti'}
          </button>
        </div>
      </div>
    </Section>
  )
}

// ── LLM Model registry (blacklist / verified) ─────────────────────────────────

function LlmModelRegistrySection() {
  const [data, setData] = useState({ blacklist: [], verified_ok: [] })
  const [loading, setLoading] = useState(true)
  const [removing, setRemoving] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      await waitForBackend()
      const d = await apiGet('/llm/models/registry')
      if (d.ok !== false) {
        setData({
          blacklist: d.blacklist || [],
          verified_ok: d.verified_ok || [],
        })
      }
    } catch {
      setData({ blacklist: [], verified_ok: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const onUpdate = () => load()
    window.addEventListener('llm-registry-updated', onUpdate)
    return () => window.removeEventListener('llm-registry-updated', onUpdate)
  }, [load])

  async function removeBlacklist(entry) {
    const key = `${entry.provider}:${entry.model_id}`
    setRemoving(key)
    try {
      const q = new URLSearchParams({
        provider: entry.provider,
        model: entry.model_id,
      })
      const res = await fetch(`${API}/llm/models/blacklist?${q}`, { method: 'DELETE' })
      const j = await res.json()
      if (j.ok) await load()
    } finally {
      setRemoving(null)
    }
  }

  return (
    <Section title="Registro modelli LLM" defaultOpen={false}>
      <p className="text-[var(--text3)] text-xs mb-4 leading-relaxed">
        Dopo la verifica nello Studio Regia AI, i modelli funzionanti sono registrati come OK;
        quelli falliti finiscono in blacklist e non vengono suggeriti né usati su quel provider.
      </p>

      {loading ? (
        <p className="text-xs text-[var(--text3)] animate-pulse">Caricamento registro…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-[var(--red)] mb-2 flex items-center gap-1.5">
              <AlertTriangle size={12} /> Blacklist ({data.blacklist.length})
            </h4>
            {data.blacklist.length === 0 ? (
              <p className="text-[11px] text-[var(--text3)]">Nessun modello bloccato.</p>
            ) : (
              <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                {data.blacklist.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-start gap-2 p-2 rounded border border-[var(--red)]/20 bg-[var(--red)]/5 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-[var(--text)] block truncate">{e.model_id}</span>
                      <span className="text-[10px] text-[var(--text3)]">{e.provider}</span>
                      {e.reason && (
                        <p className="text-[10px] text-[var(--text3)] mt-0.5 line-clamp-2">{e.reason}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      title="Rimuovi da blacklist"
                      disabled={removing === `${e.provider}:${e.model_id}`}
                      onClick={() => removeBlacklist(e)}
                      className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--red)] hover:bg-[var(--bg3)] shrink-0"
                    >
                      {removing === `${e.provider}:${e.model_id}`
                        ? <Loader2 size={12} className="animate-spin" />
                        : <Trash2 size={12} />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-[var(--green)] mb-2 flex items-center gap-1.5">
              <Check size={12} /> Verificati OK ({data.verified_ok.length})
            </h4>
            {data.verified_ok.length === 0 ? (
              <p className="text-[11px] text-[var(--text3)]">Nessuna verifica salvata — usa Studio Regia AI.</p>
            ) : (
              <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                {data.verified_ok.map((e) => (
                  <li
                    key={e.id}
                    className="p-2 rounded border border-[var(--green)]/20 bg-[var(--green)]/5 text-xs"
                  >
                    <span className="font-mono text-[var(--text)] block truncate">{e.model_id}</span>
                    <span className="text-[10px] text-[var(--text3)]">
                      {e.provider}
                      {e.verified_at && ` · ${new Date(e.verified_at).toLocaleString('it-IT')}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={load}
        className="mt-3 flex items-center gap-1.5 text-[10px] text-[var(--text3)] hover:text-[var(--gold)]"
      >
        <RefreshCw size={11} /> Aggiorna registro
      </button>
    </Section>
  )
}

// ── ComfyUI Nodes Section ─────────────────────────────────────────────────────

const EMPTY_NODE = {
  name: 'GPU Node',
  host: 'localhost',
  port: 8188,
  enabled: true,
  primary: false,
  auth_type: 'none',
  auth: '',
  token: '',
}

const AUTH_TYPE_OPTIONS = [
  { id: 'none', label: 'Nessuna', hint: 'Rete locale o ComfyUI senza credenziali' },
  { id: 'token', label: 'Token API', hint: 'RunPod / Vast — parametro ?token=' },
  { id: 'basic', label: 'Basic auth', hint: 'user:password' },
]

function inferNodeAuthType(node) {
  if (node?.auth_type && AUTH_TYPE_OPTIONS.some(o => o.id === node.auth_type)) {
    return node.auth_type
  }
  if (node?.token) return 'token'
  if (node?.auth) return 'basic'
  return 'none'
}

/** Parse pasted ComfyUI URL (only when user clicks Applica). */
function parseComfyUIUrl(raw) {
  const s = (raw || '').trim()
  if (!s) return null
  try {
    const url = new URL(s.includes('://') ? s : `http://${s}`)
    const token = url.searchParams.get('token') || ''
    return {
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : 8188,
      token,
      auth_type: token ? 'token' : undefined,
    }
  } catch {
    return null
  }
}

function nodePayloadFromForm(formData) {
  const auth_type = formData.auth_type || 'none'
  return {
    ...formData,
    port: parseInt(formData.port, 10),
    auth_type,
    token: auth_type === 'token' ? (formData.token || null) : null,
    auth: auth_type === 'basic' ? (formData.auth || null) : null,
  }
}

function ComfyUINodesSection() {
  const [nodes, setNodes]       = useState([])
  const [loading, setLoading]   = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editIdx, setEditIdx]   = useState(null)   // index being edited, or null
  const [formData, setFormData] = useState(EMPTY_NODE)
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)

  // Per-node health state: Map<index, {checking, result}>
  const [health, setHealth] = useState({})

  const loadNodes = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await waitForBackend()
      const d = await apiGet('/comfyui/nodes/config')
      setNodes(d.nodes || [])
    } catch (e) {
      setError(`Caricamento fallito: ${e.message}. Verifica che il backend sia avviato (porta 8123).`)
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { loadNodes() }, [loadNodes])

  // ── Health check ───────────────────────────────────────────────────────────

  async function checkHealth(index) {
    setHealth(h => ({ ...h, [index]: { checking: true, result: null } }))
    try {
      const d = await fetch(`${API}/comfyui/nodes/${index}/health`).then(r => r.json())
      setHealth(h => ({ ...h, [index]: { checking: false, result: d } }))
    } catch (e) {
      setHealth(h => ({ ...h, [index]: { checking: false, result: { online: false, error: e.message } } }))
    }
  }

  async function checkAllHealth() {
    await Promise.all(nodes.map((_, i) => checkHealth(i)))
  }

  // ── Test before save ───────────────────────────────────────────────────────

  async function testFormNode() {
    setSaving('testing')
    setError(null)
    try {
      const d = await fetch(`${API}/comfyui/nodes/config/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nodePayloadFromForm(formData)),
      }).then(r => r.json())
      return d
    } catch (e) {
      setError(`Test fallito: ${e.message}`)
      return null
    } finally { setSaving(null) }
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  async function saveNode() {
    setSaving('saving')
    setError(null)
    try {
      const payload = nodePayloadFromForm(formData)
      if (editIdx !== null) {
        await fetch(`${API}/comfyui/nodes/config/${editIdx}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        await fetch(`${API}/comfyui/nodes/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      await loadNodes()
      closeForm()
    } catch (e) {
      setError(`Salvataggio fallito: ${e.message}`)
    } finally { setSaving(null) }
  }

  async function deleteNode(index) {
    if (!confirm(`Eliminare il nodo "${nodes[index]?.name}"?`)) return
    try {
      await fetch(`${API}/comfyui/nodes/config/${index}`, { method: 'DELETE' })
      setHealth(h => { const n = { ...h }; delete n[index]; return n })
      await loadNodes()
    } catch (e) { setError(`Eliminazione fallita: ${e.message}`) }
  }

  async function toggleEnabled(index) {
    const node = nodes[index]
    try {
      await fetch(`${API}/comfyui/nodes/config/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...node, enabled: !node.enabled }),
      })
      await loadNodes()
    } catch (e) { setError(e.message) }
  }

  function openAdd() {
    setEditIdx(null)
    setFormData({
      ...EMPTY_NODE,
      primary: nodes.length === 0,
    })
    setShowForm(true)
  }

  async function setPrimaryNode(index) {
    const node = nodes[index]
    if (node.primary) return
    try {
      await fetch(`${API}/comfyui/nodes/config/${index}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...node, primary: true }),
      })
      await loadNodes()
    } catch (e) {
      setError(e.message)
    }
  }

  function openEdit(index) {
    setEditIdx(index)
    const n = nodes[index]
    const auth_type = inferNodeAuthType(n)
    setFormData({
      ...EMPTY_NODE,
      ...n,
      auth_type,
      auth: auth_type === 'basic' ? (n.auth || '') : '',
      token: auth_type === 'token' ? (n.token || '') : '',
    })
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditIdx(null)
    setFormData(EMPTY_NODE)
    setError(null)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Section title="Nodi ComfyUI">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-[var(--text3)]">
          {nodes.length} nodo{nodes.length !== 1 ? 'i' : ''} configurati
        </span>
        <div className="flex gap-2">
          <button
            onClick={checkAllHealth}
            disabled={loading || nodes.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
          >
            <Activity size={12} />
            Controlla tutti
          </button>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[var(--gold)]/10 hover:bg-[var(--gold)]/20 text-[var(--gold)] transition-colors"
          >
            <Plus size={12} />
            Aggiungi nodo
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
          <X size={12} />
          {error}
          <button className="ml-auto" onClick={() => setError(null)}><X size={10} /></button>
        </div>
      )}

      {/* Node list */}
      {loading && (
        <div className="flex items-center gap-2 py-4 text-xs text-[var(--text3)]">
          <Loader2 size={13} className="animate-spin" /> Caricamento...
        </div>
      )}

      {!loading && nodes.length === 0 && !showForm && (
        <div className="text-center py-8 text-[var(--text3)]">
          <Server size={32} className="mx-auto mb-2 opacity-30" />
          <p className="text-xs">Nessun nodo configurato. Clicca "Aggiungi nodo" per iniziare.</p>
        </div>
      )}

      <div className="space-y-2 mb-3">
        {nodes.map((node, i) => (
          <NodeRow
            key={`${node.host}:${node.port}`}
            node={node}
            index={i}
            health={health[i]}
            onCheckHealth={() => checkHealth(i)}
            onEdit={() => openEdit(i)}
            onDelete={() => deleteNode(i)}
            onToggle={() => toggleEnabled(i)}
            onSetPrimary={() => setPrimaryNode(i)}
          />
        ))}
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <NodeForm
          data={formData}
          isEdit={editIdx !== null}
          saving={saving}
          error={null}
          onChange={patch => setFormData(d => ({ ...d, ...patch }))}
          onTest={testFormNode}
          onSave={saveNode}
          onCancel={closeForm}
        />
      )}
    </Section>
  )
}

// ── Script download modelli ComfyUI ───────────────────────────────────────────

function ComfyUIModelScriptsSection() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [downloadingId, setDownloadingId] = useState(null)
  const [status, setStatus] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      await waitForBackend()
      const d = await apiGet('/services/comfyui-model-scripts')
      setData(d)
    } catch (e) {
      setData(null)
      setStatus({ ok: false, msg: e.message || 'Backend non disponibile' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleDownload(scriptId) {
    setDownloadingId(scriptId)
    setStatus(null)
    try {
      const native = window.studio?.settings?.downloadComfyModelScript
      if (native) {
        const res = await native(scriptId)
        if (res?.canceled) return
        if (res?.saved) {
          setStatus({ ok: true, msg: `Salvato: ${res.path}` })
        } else if (res?.error) {
          setStatus({ ok: false, msg: res.error })
        }
        return
      }
      const url = `${API}/services/comfyui-model-scripts/${encodeURIComponent(scriptId)}`
      const a = document.createElement('a')
      a.href = url
      a.download = data?.scripts?.find(s => s.id === scriptId)?.filename || 'script'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setStatus({ ok: true, msg: 'Download avviato dal browser' })
    } catch (e) {
      setStatus({ ok: false, msg: e.message })
    } finally {
      setDownloadingId(null)
      setTimeout(() => setStatus(null), 5000)
    }
  }

  const scripts = data?.scripts?.filter(s => s.available) ?? []

  return (
    <Section title="SCRIPT MODEL COMFYUI" defaultOpen>
      <div className="flex items-start gap-3 mb-4 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg2)]">
        <Terminal size={18} className="text-[var(--gold)] shrink-0 mt-0.5" />
        <div className="text-xs text-[var(--text2)] leading-relaxed space-y-1.5">
          <p>
            {data?.description || (
              'Script per scaricare in batch i modelli usati da CinematicAI (LTX, Qwen, Z-Image, Flux, upscaler).'
            )}
          </p>
          <p className="text-[var(--text3)]">
            1. Scarica lo script per il tuo sistema · 2. Copialo nella{' '}
            <strong className="text-[var(--text2)]">cartella root di ComfyUI</strong> · 3. Eseguilo:
            crea <code className="text-[var(--gold)]">{data?.models_base_dir || './models'}</code> con le
            sottocartelle corrette (checkpoints, loras, vae, …).
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[var(--text3)] text-xs py-4">
          <Loader2 size={14} className="animate-spin" />
          Caricamento script…
        </div>
      ) : scripts.length === 0 ? (
        <p className="text-xs text-[var(--red)] font-mono">
          Nessuno script trovato in scripts/user_tools — verifica installazione.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {scripts.map(s => (
            <div
              key={s.id}
              className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--border)] bg-[var(--bg2)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-mono text-[var(--text)]">{s.label}</span>
                <span className="text-[9px] text-[var(--text3)]">
                  {(s.size_bytes / 1024).toFixed(1)} KB
                </span>
              </div>
              <code className="text-[10px] text-[var(--gold)] truncate" title={s.filename}>
                {s.filename}
              </code>
              <p className="text-[9px] text-[var(--text3)] leading-snug">{s.hint}</p>
              <button
                type="button"
                disabled={downloadingId === s.id}
                onClick={() => handleDownload(s.id)}
                className="flex items-center justify-center gap-1.5 py-2 text-xs rounded border border-[var(--gold)]/35 bg-[var(--gold)]/10 text-[var(--gold)] hover:bg-[var(--gold)]/20 disabled:opacity-40 transition-colors"
              >
                {downloadingId === s.id
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Download size={12} />}
                Scarica
              </button>
            </div>
          ))}
        </div>
      )}

      {status && (
        <p className={clsx(
          'mt-3 text-xs font-mono',
          status.ok ? 'text-[var(--green)]' : 'text-[var(--red)]',
        )}>
          {status.msg}
        </p>
      )}

      <button
        type="button"
        onClick={load}
        className="mt-3 flex items-center gap-1.5 text-[10px] font-mono text-[var(--text3)] hover:text-[var(--gold)]"
      >
        <RefreshCw size={10} />
        Aggiorna elenco
      </button>
    </Section>
  )
}

// ── NodeRow ───────────────────────────────────────────────────────────────────

function NodeRow({ node, index, health, onCheckHealth, onEdit, onDelete, onToggle, onSetPrimary }) {
  const h = health
  const checking = h?.checking
  const res      = h?.result

  return (
    <div className={clsx(
      'rounded-lg border p-3 transition-colors',
      node.enabled ? 'border-[var(--border)] bg-[var(--bg2)]' : 'border-[var(--border)] bg-[var(--bg1)] opacity-60'
    )}>
      <div className="flex items-center gap-3">
        {/* Status indicator */}
        <div className="shrink-0">
          {checking ? (
            <Loader2 size={14} className="animate-spin text-[var(--gold)]" />
          ) : res ? (
            res.online
              ? <Wifi size={14} className="text-[var(--green)]" />
              : <WifiOff size={14} className="text-[var(--red)]" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full border border-[var(--border2)] bg-[var(--bg3)]" />
          )}
        </div>

        {/* Name + address */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text)] font-medium truncate">{node.name}</span>
            {node.primary && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gold)]/15 text-[var(--gold)] border border-[var(--gold)]/30">
                Principale
              </span>
            )}
            {!node.enabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--text3)]">disabilitato</span>
            )}
          </div>
          <span className="text-xs font-mono text-[var(--text3)]">
            {node.host}:{node.port}
            {node.auth_type && node.auth_type !== 'none' && (
              <span className="ml-1.5 text-[var(--text3)] opacity-80">
                · {node.auth_type === 'token' ? 'token' : 'basic'}
              </span>
            )}
          </span>
        </div>

        {/* Health result inline */}
        {res && res.online && (
          <div className="flex gap-3 shrink-0 text-right">
            <HealthStat label="Latency" value={res.latency_ms != null ? `${res.latency_ms}ms` : '—'} />
            <HealthStat label="Queue"   value={res.queue_depth != null ? String(res.queue_depth) : '—'} />
            {res.vram_free_mb != null && (
              <HealthStat
                label="VRAM libera"
                value={`${(res.vram_free_mb / 1024).toFixed(1)}GB`}
                highlight
              />
            )}
          </div>
        )}
        {res && !res.online && (
          <span className="text-xs text-[var(--red)] shrink-0 max-w-[140px] truncate" title={res.error}>
            {res.error || 'Offline'}
          </span>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onSetPrimary}
            disabled={node.primary}
            title={node.primary ? 'Nodo principale' : 'Imposta come principale'}
            className={clsx(
              'p-1.5 rounded transition-colors',
              node.primary
                ? 'text-[var(--gold)] bg-[var(--gold)]/10'
                : 'text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10'
            )}
          >
            <Star size={13} className={node.primary ? 'fill-current' : ''} />
          </button>
          <button
            onClick={onCheckHealth}
            disabled={checking}
            title="Health check"
            className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10 disabled:opacity-40 transition-colors"
          >
            <Activity size={13} />
          </button>
          <button
            onClick={onToggle}
            title={node.enabled ? 'Disabilita' : 'Abilita'}
            className={clsx(
              'p-1.5 rounded transition-colors',
              node.enabled
                ? 'text-[var(--green)] hover:text-[var(--text3)] hover:bg-[var(--bg3)]'
                : 'text-[var(--text3)] hover:text-[var(--green)] hover:bg-[var(--bg3)]'
            )}
          >
            <Check size={13} />
          </button>
          <button
            onClick={onEdit}
            title="Modifica"
            className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--text2)] hover:bg-[var(--bg3)] transition-colors"
          >
            <Edit2 size={13} />
          </button>
          <button
            onClick={onDelete}
            title="Elimina"
            className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--red)] hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* GPU info bar */}
      {res?.online && res.gpu_name && (
        <div className="mt-2 flex items-center gap-2 pt-2 border-t border-[var(--border)]">
          <Cpu size={11} className="text-[var(--text3)]" />
          <span className="text-[11px] text-[var(--text3)] truncate">{res.gpu_name}</span>
          {res.vram_total_mb && (
            <span className="text-[11px] text-[var(--text3)] ml-auto shrink-0">
              {(res.vram_total_mb / 1024).toFixed(0)} GB totali
            </span>
          )}
          {res.vram_free_mb != null && res.vram_total_mb != null && (
            <VramBar free={res.vram_free_mb} total={res.vram_total_mb} />
          )}
        </div>
      )}
    </div>
  )
}

function HealthStat({ label, value, highlight }) {
  return (
    <div className="text-right">
      <div className={clsx('text-xs font-mono font-medium', highlight ? 'text-[var(--gold)]' : 'text-[var(--text)]')}>
        {value}
      </div>
      <div className="text-[10px] text-[var(--text3)]">{label}</div>
    </div>
  )
}

function VramBar({ free, total }) {
  const usedPct = Math.round((1 - free / total) * 100)
  const color = usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-[var(--green)]'
  return (
    <div className="w-20 h-1.5 bg-[var(--bg3)] rounded-full overflow-hidden shrink-0">
      <div className={clsx('h-full rounded-full transition-all', color)} style={{ width: `${usedPct}%` }} />
    </div>
  )
}

// ── NodeForm ──────────────────────────────────────────────────────────────────

function NodeForm({ data, isEdit, saving, onChange, onTest, onSave, onCancel }) {
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [pasteUrl, setPasteUrl] = useState('')

  function applyPastedUrl() {
    const parsed = parseComfyUIUrl(pasteUrl)
    if (!parsed) return
    const patch = { host: parsed.host, port: parsed.port }
    if (parsed.auth_type === 'token' && parsed.token) {
      patch.auth_type = 'token'
      patch.token = parsed.token
      patch.auth = ''
    }
    onChange(patch)
    setPasteUrl('')
  }

  function setAuthType(auth_type) {
    onChange({
      auth_type,
      token: auth_type === 'token' ? (data.token || '') : '',
      auth: auth_type === 'basic' ? (data.auth || '') : '',
    })
  }

  const authMeta = AUTH_TYPE_OPTIONS.find(o => o.id === data.auth_type) || AUTH_TYPE_OPTIONS[0]

  async function handleTest() {
    setTesting(true)
    setTestResult(null)
    const res = await onTest()
    setTestResult(res)
    setTesting(false)
  }

  return (
    <div className="border border-[var(--gold)]/30 rounded-lg p-4 bg-[var(--bg1)] mt-2">
      <h4 className="text-xs text-[var(--gold)] uppercase tracking-wider mb-4">
        {isEdit ? 'Modifica nodo' : 'Nuovo nodo'}
      </h4>

      <div className="mb-4 p-3 rounded-lg border border-[var(--gold)]/25 bg-[var(--gold)]/5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-[var(--gold)] flex items-center gap-1.5">
              <Star size={12} className={data.primary ? 'fill-current' : ''} />
              Nodo principale
            </div>
            <p className="text-[10px] text-[var(--text3)] mt-0.5">
              Usato per tutta la pipeline. Se offline, si usa un nodo di fallback.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChange({ primary: !data.primary })}
            className={clsx(
              'relative w-9 h-5 rounded-full transition-colors shrink-0',
              data.primary ? 'bg-[var(--gold)]' : 'bg-[var(--bg3)]'
            )}
          >
            <span className={clsx(
              'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
              data.primary ? 'translate-x-4' : 'translate-x-0.5'
            )} />
          </button>
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[10px] text-[var(--text3)] mb-1">
          Incolla URL ComfyUI remoto (RunPod / Vast)
        </label>
        <div className="flex gap-2">
          <input
            className={inp}
            value={pasteUrl}
            onChange={e => setPasteUrl(e.target.value)}
            placeholder="http://IP:58539/?token=..."
          />
          <button
            type="button"
            onClick={applyPastedUrl}
            disabled={!pasteUrl.trim()}
            className="shrink-0 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] disabled:opacity-40"
          >
            Applica
          </button>
        </div>
        <p className="text-[10px] text-[var(--text3)] mt-1">
          Compila host e porta; se l&apos;URL contiene ?token=, verrà impostato il tipo Token API.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-[10px] text-[var(--text3)] mb-1">Nome</label>
          <input className={inp} value={data.name} onChange={e => onChange({ name: e.target.value })} placeholder="GPU Node" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className="block text-[10px] text-[var(--text3)] mb-1">Host (solo IP o hostname)</label>
            <input className={inp} value={data.host} onChange={e => onChange({ host: e.target.value })} placeholder="62.107.25.198" />
          </div>
          <div>
            <label className="block text-[10px] text-[var(--text3)] mb-1">Porta</label>
            <input className={inp} type="number" value={data.port} onChange={e => onChange({ port: e.target.value })} placeholder="8188" />
          </div>
        </div>
      </div>

      <div className="mb-3">
        <label className="block text-[10px] text-[var(--text3)] mb-2">Autenticazione</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {AUTH_TYPE_OPTIONS.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setAuthType(opt.id)}
              className={clsx(
                'px-3 py-1.5 text-xs rounded border transition-colors',
                data.auth_type === opt.id
                  ? 'border-[var(--gold)] bg-[var(--gold)]/15 text-[var(--gold)]'
                  : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--border2)]'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-[var(--text3)]">{authMeta.hint}</p>
      </div>

      {data.auth_type === 'token' && (
        <div className="mb-3">
          <label className="block text-[10px] text-[var(--text3)] mb-1">Token API</label>
          <input
            className={inp}
            type="password"
            value={data.token || ''}
            onChange={e => onChange({ token: e.target.value })}
            placeholder="valore del parametro ?token="
            autoComplete="off"
          />
        </div>
      )}

      {data.auth_type === 'basic' && (
        <div className="mb-3">
          <label className="block text-[10px] text-[var(--text3)] mb-1">Credenziali (user:password)</label>
          <input
            className={inp}
            type="password"
            value={data.auth || ''}
            onChange={e => onChange({ auth: e.target.value })}
            placeholder="user:password"
            autoComplete="off"
          />
        </div>
      )}

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => onChange({ enabled: !data.enabled })}
          className={clsx(
            'relative w-9 h-5 rounded-full transition-colors shrink-0',
            data.enabled ? 'bg-[var(--gold)]' : 'bg-[var(--bg3)]'
          )}
        >
          <span className={clsx(
            'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
            data.enabled ? 'translate-x-4' : 'translate-x-0.5'
          )} />
        </button>
        <span className="text-xs text-[var(--text2)]">Nodo abilitato</span>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={clsx(
          'mb-3 px-3 py-2.5 rounded border text-xs',
          testResult.online
            ? 'border-green-500/30 bg-green-500/5 text-[var(--green)]'
            : 'border-red-500/30 bg-red-500/5 text-[var(--red)]'
        )}>
          {testResult.online ? (
            <div className="space-y-0.5">
              <div className="font-medium flex items-center gap-1.5">
                <Wifi size={12} /> Connesso — {testResult.latency_ms}ms
              </div>
              {testResult.gpu_name && (
                <div className="text-[var(--text2)] font-mono">{testResult.gpu_name}</div>
              )}
              {testResult.vram_free_mb != null && (
                <div>VRAM libera: {(testResult.vram_free_mb / 1024).toFixed(1)} GB / {(testResult.vram_total_mb / 1024).toFixed(0)} GB</div>
              )}
              <div>Coda: {testResult.queue_depth} job</div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <WifiOff size={12} /> {testResult.error || 'Nodo non raggiungibile'}
            </div>
          )}
        </div>
      )}

      {/* Buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleTest}
          disabled={testing || saving === 'saving'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)] disabled:opacity-40 transition-colors"
        >
          {testing ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
          {testing ? 'Testing...' : 'Testa connessione'}
        </button>
        <button
          onClick={onSave}
          disabled={saving === 'saving' || testing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-[var(--gold)]/20 hover:bg-[var(--gold)]/30 text-[var(--gold)] disabled:opacity-40 transition-colors"
        >
          {saving === 'saving' ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          {saving === 'saving' ? 'Salvataggio...' : isEdit ? 'Aggiorna' : 'Aggiungi'}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded text-[var(--text3)] hover:text-[var(--text2)] transition-colors"
        >
          <X size={11} /> Annulla
        </button>
      </div>
    </div>
  )
}
