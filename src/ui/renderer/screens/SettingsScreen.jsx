import { useState, useEffect, useCallback } from 'react'
import {
  Settings, RefreshCw, Eye, EyeOff,
  Server, Plus, Trash2, Check, X,
  Wifi, WifiOff, Loader2, Edit2, ChevronDown, ChevronUp,
  Cpu, Activity, BookOpen, Clapperboard, Camera, PenLine,
  ClipboardCheck, ChevronRight, Save, RotateCcw, Globe, Star,
  HardDrive, FolderOpen, ExternalLink,
} from 'lucide-react'
import clsx from 'clsx'
import { apiGet, waitForBackend, API_BASE } from '../utils/apiClient'

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
      <ComfyUINodesSection />

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
      const [health, discovered] = await Promise.all([
        fetch(`${API}/llm/health`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg),
        }).then(r => r.json()),
        fetchModels(cfg).catch(() => []),
      ])
      setStatus({
        ok: health.ok,
        msg: health.ok
          ? `✓ ${health.provider} — connesso`
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
          placeholder="http://localhost:1234/v1"
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

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await waitForBackend()
      try {
        const data = await apiGet('/llm/roles')
        if (cancelled) return
        const merged = {}
        for (const meta of ROLES_META) {
          merged[meta.key] = { ...ROLE_DEFAULTS(meta), ...(data[meta.key] || {}) }
        }
        setRoles(merged)
      } catch {
        if (cancelled) return
        const defaults = {}
        for (const meta of ROLES_META) defaults[meta.key] = ROLE_DEFAULTS(meta)
        setRoles(defaults)
      }
    })()
    return () => { cancelled = true }
  }, [])

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

      <div className="space-y-2">
        {ROLES_META.map(meta => {
          const cfg = roles[meta.key] || ROLE_DEFAULTS(meta)
          const isOpen = !!open[meta.key]
          const isCustom = cfg.custom
          const isTesting = !!testing[meta.key]
          const result = testResult[meta.key]
          const discoveredModels = roleModels[meta.key]

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
                            className={inp}
                            value={cfg.model}
                            onChange={e => patchRole(meta.key, { model: e.target.value })}
                            placeholder="gpt-4o, claude-sonnet-4-6…"
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
      setError(`Caricamento fallito: ${e.message}. Verifica che il backend sia avviato (porta 8765).`)
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
