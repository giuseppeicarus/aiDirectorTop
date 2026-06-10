import { useState, useEffect, useCallback } from 'react'
import {
  Package,
  Download,
  CheckCircle2,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Play,
  Cpu,
  Database,
  ExternalLink,
  Loader2,
  XCircle,
  MonitorDot,
  Edit2,
  Check,
  X as XIcon,
  AlertTriangle,
  Copy,
} from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

// ---------------------------------------------------------------------------
// Category color map (shared with provisioning)
// ---------------------------------------------------------------------------

const CAT_COLOR = {
  gold:  'bg-[#c9a84c]/15 text-[#c9a84c] border-[#c9a84c]/30',
  blue:  'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/30',
  green: 'bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30',
  amber: 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30',
  text2: 'bg-[#9090a8]/15 text-[#9090a8] border-[#9090a8]/30',
}

function CatBadge({ color, label }) {
  return (
    <span className={clsx('text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase tracking-wider', CAT_COLOR[color] || CAT_COLOR.text2)}>
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Inline URL editor
// ---------------------------------------------------------------------------

function UrlEditor({ model, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(model.url || '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await fetch(`${API_BASE}/provisioning/models/url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: model.filename, url: val.trim() || null }),
      })
      onSaved?.()
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        {model.has_url ? (
          <span className="text-[10px] text-[#22c55e] font-mono truncate max-w-[260px]" title={model.url}>
            {model.url}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-[#f59e0b]">
            <AlertTriangle size={10} /> URL mancante
          </span>
        )}
        <button
          onClick={() => { setVal(model.url || ''); setEditing(true) }}
          className="shrink-0 text-[#555568] hover:text-[#c9a84c] transition-colors"
          title="Modifica URL"
        >
          <Edit2 size={11} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1 mt-1">
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder="https://huggingface.co/..."
        autoFocus
        className="flex-1 min-w-0 bg-[#0f0f18] border border-[#c9a84c]/40 rounded px-2 py-1
                   text-[11px] text-[#e8e4dd] font-mono outline-none focus:border-[#c9a84c]"
      />
      <button
        onClick={save}
        disabled={saving}
        className="shrink-0 text-[#22c55e] hover:opacity-80 disabled:opacity-40"
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
      </button>
      <button onClick={() => setEditing(false)} className="shrink-0 text-[#555568] hover:text-[#ef4444]">
        <XIcon size={12} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single model row
// ---------------------------------------------------------------------------

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    }).catch(() => {})
  }
  return (
    <button
      onClick={copy}
      title="Copia nome file"
      className="shrink-0 text-[#555568] hover:text-[#c9a84c] transition-colors"
    >
      {copied ? <Check size={11} className="text-[#22c55e]" /> : <Copy size={11} />}
    </button>
  )
}

function ComfyModelRow({ model, categories, onRefresh }) {
  const cat = categories[model.category] || {}
  const isHuggingFace = (model.url || '').includes('huggingface.co')
  const isGithub = (model.url || '').includes('github.com')

  return (
    <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4 hover:border-[#32324a] transition-colors">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          {/* Name + filename */}
          <p className="text-sm font-medium text-[#e8e4dd] truncate">{model.name}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="font-mono text-[10px] text-[#555568] truncate">{model.filename}</p>
            <CopyBtn text={model.filename} />
          </div>
          <p className="font-mono text-[10px] text-[#32324a] mt-0.5">-&gt; {model.target_dir}/</p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <CatBadge color={cat.color} label={cat.label || model.category} />
          {model.size_gb && (
            <span className="text-[10px] text-[#c9a84c] font-mono">
              {model.size_gb < 1 ? `${Math.round(model.size_gb * 1024)} MB` : `${model.size_gb.toFixed(1)} GB`}
            </span>
          )}
        </div>
      </div>

      {/* Workflows */}
      <div className="flex flex-wrap gap-1 mb-3">
        {model.workflows.map(wf => (
          <span key={wf} className="text-[9px] px-1.5 py-0.5 rounded bg-[#c9a84c]/10 text-[#c9a84c] border border-[#c9a84c]/20 font-mono">
            {wf.replace('.json', '')}
          </span>
        ))}
      </div>

      {/* URL editor */}
      <div onClick={e => e.stopPropagation()}>
        <UrlEditor model={model} onSaved={onRefresh} />
      </div>

      {/* Download button */}
      {model.has_url && (
        <button
          onClick={() => window.open(model.url, '_blank', 'noopener,noreferrer')}
          className="mt-3 w-full flex items-center justify-center gap-1.5 text-[11px] py-1.5 rounded
                     bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 text-[#c9a84c]
                     border border-[#c9a84c]/25 hover:border-[#c9a84c]/50 transition-colors"
        >
          <Download size={11} />
          {isHuggingFace ? 'HuggingFace' : isGithub ? 'GitHub' : 'Download'}
          <ExternalLink size={10} className="opacity-60" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1: ComfyUI Models — DYNAMIC (scansione workflow live)
// ---------------------------------------------------------------------------

function ComfyUIModelsTab() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openCats, setOpenCats] = useState({})

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${API_BASE}/provisioning/models`)
      .then(r => r.json())
      .then(d => {
        setData(d)
        // Apri tutte le categorie di default
        const cats = {}
        for (const m of d.models || []) cats[m.category] = true
        setOpenCats(cats)
        setError(null)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return (
    <div className="flex items-center gap-2 py-12 justify-center text-[#9090a8]">
      <Loader2 size={16} className="animate-spin" />
      Scansione workflow...
    </div>
  )

  if (error) return (
    <div className="flex items-center gap-2 py-8 text-[#ef4444] text-sm">
      <AlertCircle size={14} />
      Errore: {error}
    </div>
  )

  const models = data?.models || []
  const categories = data?.categories || {}
  const noUrlCount = models.filter(m => !m.has_url).length

  // Raggruppa per categoria
  const byCategory = {}
  for (const m of models) {
    if (!byCategory[m.category]) byCategory[m.category] = []
    byCategory[m.category].push(m)
  }

  return (
    <div className="space-y-4">
      {/* Header info */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-[#9090a8]">
            <span className="text-[#e8e4dd] font-medium">{models.length}</span> modelli rilevati dai workflow installati
          </span>
          {noUrlCount > 0 && (
            <span className="flex items-center gap-1 text-[11px] text-[#f59e0b]">
              <AlertTriangle size={11} />
              {noUrlCount} senza URL
            </span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#252533]
                     text-xs text-[#9090a8] hover:text-[#e8e4dd] hover:border-[#c9a84c]/40 transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Riscansiona
        </button>
      </div>

      {/* Info box */}
      <div className="flex items-start gap-3 rounded-lg border border-[#c9a84c]/25 bg-[#c9a84c]/5 px-4 py-3">
        <Info size={14} className="text-[#c9a84c] shrink-0 mt-0.5" />
        <p className="text-xs text-[#9090a8] leading-relaxed">
          Lista generata automaticamente dalla scansione dei workflow installati.
          Clicca <Edit2 size={10} className="inline" /> per aggiungere o modificare l'URL di download di un modello.
          Le modifiche vengono salvate in <code className="text-[#e8e4dd]">config/model_url_catalog.json</code>.
        </p>
      </div>

      {/* Per-category groups */}
      {Object.entries(byCategory).map(([cat, catModels]) => {
        const catInfo = categories[cat] || {}
        const open = openCats[cat] !== false
        return (
          <div key={cat} className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
            <button
              onClick={() => setOpenCats(p => ({ ...p, [cat]: !open }))}
              className="w-full flex items-center gap-3 px-5 py-4 hover:bg-[#16161f] transition-colors text-left"
            >
              {open ? <ChevronDown size={14} className="text-[#9090a8] shrink-0" /> : <ChevronRight size={14} className="text-[#9090a8] shrink-0" />}
              <CatBadge color={catInfo.color} label={catInfo.label || cat} />
              <span className="text-[10px] text-[#555568] font-mono">{catModels.length} file</span>
              <span className="ml-auto text-[10px] text-[#555568]">
                {catModels.filter(m => m.has_url).length}/{catModels.length} con URL
              </span>
            </button>
            {open && (
              <div className="px-5 pb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {catModels.map(m => (
                  <ComfyModelRow key={m.id} model={m} categories={categories} onRefresh={load} />
                ))}
              </div>
            )}
          </div>
        )
      })}

      {models.length === 0 && (
        <div className="text-center py-12 text-[#555568]">
          <Package size={40} className="mx-auto mb-3 opacity-30" />
          <p>Nessun modello rilevato</p>
          <p className="text-xs mt-1">Aggiungi workflow in config/workflows/ per popolare questa lista</p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider classification
// ---------------------------------------------------------------------------

const LLM_ROLES = [
  { key: 'story_analyst',      label: 'Story Analyst' },
  { key: 'narrative_director', label: 'Narrative Director' },
  { key: 'cinematographer',    label: 'Cinematographer' },
  { key: 'prompt_engineer',    label: 'Prompt Engineer' },
  { key: 'continuity_checker', label: 'Continuity Checker' },
]

const OLLAMA_QUICK = ['gemma3:4b', 'gemma3:12b', 'llama3.2:3b', 'mistral:7b', 'qwen2.5:7b', 'deepseek-r1:7b']

// Provider che NON gestiscono modelli locali via questa app
const CLOUD_PROVIDERS = new Set(['openai', 'anthropic', 'groq', 'mistral', 'openrouter',
  'together', 'fireworks', 'cohere', 'azure', 'gemini', 'claude'])
const LM_STUDIO_PROVIDERS = new Set(['lmstudio', 'lm_studio', 'lm-studio', 'lm studio'])
const OLLAMA_PROVIDERS = new Set(['ollama'])

function providerType(p) {
  const key = (p || '').toLowerCase().replace(/[\s_-]/g, '')
  if (OLLAMA_PROVIDERS.has(p?.toLowerCase())) return 'ollama'
  if (['lmstudio','lm_studio','lm-studio'].includes(p?.toLowerCase())) return 'lmstudio'
  if (CLOUD_PROVIDERS.has(p?.toLowerCase())) return 'cloud'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// LLM config section (sempre visibile)
// ---------------------------------------------------------------------------

function RoleRow({ label, cfg }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-[#252533] last:border-b-0">
      <div className="w-36 shrink-0"><p className="text-xs text-[#e8e4dd]">{label}</p></div>
      {cfg ? (
        <>
          <span className="text-[10px] px-2 py-0.5 rounded border font-mono bg-[#3b82f6]/10 text-[#3b82f6] border-[#3b82f6]/25">{cfg.provider ?? '—'}</span>
          <span className="font-mono text-[11px] text-[#9090a8] truncate flex-1">{cfg.model ?? '—'}</span>
          {cfg.temperature != null && <span className="text-[10px] text-[#555568] font-mono shrink-0">temp {cfg.temperature}</span>}
        </>
      ) : (
        <span className="text-[11px] text-[#555568] font-mono">non configurato</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cloud provider notice
// ---------------------------------------------------------------------------

function CloudProviderNotice({ provider }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#252533] bg-[#0f0f18] px-5 py-5">
      <Info size={16} className="text-[#9090a8] shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium text-[#e8e4dd] mb-1">
          {provider} non supporta download modelli locali
        </p>
        <p className="text-xs text-[#9090a8] leading-relaxed">
          I provider cloud come <span className="text-[#e8e4dd]">{provider}</span> gestiscono
          i modelli sui loro server — non c&apos;è nulla da scaricare localmente.
          Per usare modelli locali, configura <span className="text-[#c9a84c]">Ollama</span> o{' '}
          <span className="text-[#c9a84c]">LM Studio</span> in Servizi &rarr; LLM.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ollama pull — streaming live
// ---------------------------------------------------------------------------

function OllamaPullPanel({ onDone }) {
  const [pullModel, setPullModel] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullStatus, setPullStatus] = useState(null)  // {status, pct, done, error}
  const readerRef = useRef(null)

  const startPull = (name) => {
    const model = (name || pullModel).trim()
    if (!model || pulling) return
    setPulling(true)
    setPullStatus({ status: 'Connessione a Ollama...', pct: 0, done: false })

    const url = `${API_BASE}/llm/ollama/pull-stream?model=${encodeURIComponent(model)}`
    const es = new EventSource(url)

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        if (ev.error) {
          setPullStatus({ status: ev.error, pct: 0, done: true, error: true })
          es.close(); setPulling(false); return
        }
        setPullStatus({ status: ev.status, pct: ev.pct || 0, done: ev.done || false })
        if (ev.done) {
          es.close()
          setPulling(false)
          onDone?.()
        }
      } catch {}
    }
    es.onerror = () => {
      setPullStatus(s => ({ ...s, status: 'Connessione persa', done: true, error: true }))
      es.close(); setPulling(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Quick buttons */}
      <div>
        <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-2">Download rapido</p>
        <div className="flex flex-wrap gap-2">
          {OLLAMA_QUICK.map(m => (
            <button key={m} disabled={pulling} onClick={() => { setPullModel(m); startPull(m) }}
              className="font-mono text-[11px] px-2.5 py-1 rounded border bg-[#1e1e2a] border-[#32324a] text-[#9090a8] hover:border-[#c9a84c]/50 hover:text-[#c9a84c] disabled:opacity-40 transition-colors">
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Custom input */}
      <div>
        <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-2">Modello personalizzato</p>
        <div className="flex gap-2">
          <input value={pullModel} onChange={e => setPullModel(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && startPull()}
            placeholder="es. qwen2.5:14b"
            className="flex-1 font-mono text-xs px-3 py-2 rounded border bg-[#1e1e2a] border-[#252533] text-[#e8e4dd] placeholder:text-[#555568] focus:outline-none focus:border-[#c9a84c]/50 transition-colors" />
          <button onClick={() => startPull()} disabled={pulling || !pullModel.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded border bg-[#c9a84c]/10 border-[#c9a84c]/25 text-[#c9a84c] hover:bg-[#c9a84c]/20 hover:border-[#c9a84c]/50 disabled:opacity-40 text-xs transition-colors">
            {pulling ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            Pull
          </button>
        </div>
      </div>

      {/* Live progress */}
      {pullStatus && (
        <div className={clsx('rounded-lg border px-4 py-3 space-y-2',
          pullStatus.error ? 'bg-[#ef4444]/5 border-[#ef4444]/25' : 'bg-[#0f0f18] border-[#252533]')}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {pulling && !pullStatus.done
                ? <Loader2 size={12} className="text-[#c9a84c] animate-spin" />
                : pullStatus.error
                  ? <XCircle size={12} className="text-[#ef4444]" />
                  : <CheckCircle2 size={12} className="text-[#22c55e]" />}
              <span className={clsx('text-xs font-mono',
                pullStatus.error ? 'text-[#ef4444]' : pullStatus.done ? 'text-[#22c55e]' : 'text-[#9090a8]')}>
                {pullStatus.status}
              </span>
            </div>
            {pullStatus.pct > 0 && (
              <span className="text-[10px] font-mono text-[#c9a84c]">{pullStatus.pct.toFixed(1)}%</span>
            )}
          </div>
          {pullStatus.pct > 0 && (
            <div className="w-full bg-[#252533] rounded-full h-1.5 overflow-hidden">
              <div className="h-full rounded-full bg-[#c9a84c] transition-all duration-300"
                style={{ width: `${Math.min(pullStatus.pct, 100)}%` }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ollama full panel
// ---------------------------------------------------------------------------

function OllamaPanel() {
  const [models, setModels] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    fetch(`${API_BASE}/llm/ollama/models`)
      .then(r => r.json())
      .then(d => { setModels(Array.isArray(d.models) ? d.models : []); setError(null) })
      .catch(() => setError('Ollama non disponibile'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="space-y-5">
      {/* Download panel */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533]">
          <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">Scarica modello Ollama</h3>
          <p className="text-[11px] text-[#9090a8] mt-0.5">Pull con tracking live del download</p>
        </div>
        <div className="px-5 py-4">
          <OllamaPullPanel onDone={load} />
        </div>
      </section>

      {/* Installed models */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533] flex items-center justify-between">
          <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">Modelli installati</h3>
          <button onClick={load} disabled={loading} className="p-1.5 rounded text-[#9090a8] hover:text-[#e8e4dd] hover:bg-[#1e1e2a] transition-colors disabled:opacity-40">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-3 text-xs text-[#9090a8]"><Loader2 size={12} className="animate-spin" />Caricamento...</div>
          ) : error ? (
            <div className="flex items-center gap-2 rounded px-3 py-2.5 bg-[#ef4444]/5 border border-[#ef4444]/20 text-xs text-[#ef4444]">
              <AlertCircle size={13} />{error}
            </div>
          ) : models.length === 0 ? (
            <p className="text-xs text-[#555568] py-2">Nessun modello installato — usa il pull sopra</p>
          ) : (
            <div className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden divide-y divide-[#252533]">
              {models.map(m => {
                const name = m.name ?? m
                const sizeB = m.size || 0
                const sizeStr = sizeB > 1e9 ? `${(sizeB/1e9).toFixed(1)} GB` : sizeB > 1e6 ? `${(sizeB/1e6).toFixed(0)} MB` : ''
                return (
                  <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                    <Database size={13} className="text-[#9090a8] shrink-0" />
                    <span className="font-mono text-xs text-[#e8e4dd] flex-1">{name}</span>
                    {sizeStr && <span className="text-[10px] text-[#555568] font-mono">{sizeStr}</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// LM Studio panel
// ---------------------------------------------------------------------------

function LMStudioPanel() {
  return (
    <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#252533]">
        <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">LM Studio</h3>
        <p className="text-[11px] text-[#9090a8] mt-0.5">Gestione modelli tramite interfaccia LM Studio</p>
      </div>
      <div className="px-5 py-5 space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-[#252533] bg-[#1e1e2a] px-4 py-3">
          <Info size={14} className="text-[#9090a8] shrink-0 mt-0.5" />
          <p className="text-xs text-[#9090a8] leading-relaxed">
            I modelli LM Studio vengono gestiti dall&apos;applicazione LM Studio.
            Apri LM Studio, scarica il modello dal suo catalogo, poi torna qui e
            configura l&apos;URL base in <span className="text-[#e8e4dd]">Servizi &rarr; LLM</span>.
          </p>
        </div>
        <button
          onClick={() => window.__electron_ipc?.invoke?.('shell:open', 'lm-studio://')}
          className="flex items-center gap-2 px-4 py-2 rounded border bg-[#1e1e2a] border-[#32324a] text-[#9090a8] hover:border-[#c9a84c]/30 hover:text-[#e8e4dd] text-xs transition-colors">
          <MonitorDot size={13} />Apri LM Studio
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Tab 2: LLM Models — provider-aware
// ---------------------------------------------------------------------------

function LLMModelsTab() {
  const [config, setConfig] = useState(null)
  const [configError, setConfigError] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/config`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { if (!cancelled) { setConfig(d); setConfigError(null) } })
      .catch(e => { if (!cancelled) setConfigError(e.message) })
      .finally(() => { if (!cancelled) setLoadingConfig(false) })
    return () => { cancelled = true }
  }, [])

  const llm = config?.llm ?? {}
  const llmRoles = config?.llm_roles ?? {}
  const pType = providerType(llm.provider)

  return (
    <div className="space-y-6">
      {/* Config LLM (sempre visibile) */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533]">
          <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">Configurazione LLM</h3>
          <p className="text-[11px] text-[#9090a8] mt-0.5">Provider attivo e configurazione per ruolo</p>
        </div>
        {loadingConfig ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[#9090a8] text-sm"><Loader2 size={14} className="animate-spin" />Caricamento...</div>
        ) : configError ? (
          <div className="flex items-start gap-2 px-5 py-4"><AlertCircle size={14} className="text-[#ef4444] shrink-0 mt-0.5" /><p className="text-xs text-[#ef4444]">{configError}</p></div>
        ) : (
          <>
            <div className="px-5 py-4 border-b border-[#252533]">
              <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-3">Predefinito</p>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[11px] px-2.5 py-1 rounded border font-mono bg-[#3b82f6]/10 text-[#3b82f6] border-[#3b82f6]/25">{llm.provider ?? '—'}</span>
                <span className="font-mono text-sm text-[#e8e4dd]">{llm.model ?? '—'}</span>
                {llm.temperature != null && <span className="text-[11px] text-[#555568] font-mono">temp {llm.temperature}</span>}
              </div>
            </div>
            <div>
              <div className="px-5 py-3 border-b border-[#252533]">
                <p className="text-[10px] text-[#555568] uppercase tracking-wider">Per ruolo</p>
              </div>
              {LLM_ROLES.map(({ key, label }) => (
                <RoleRow key={key} label={label} cfg={llmRoles[key] ?? null} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* Sezione modelli — condizionale sul provider */}
      {!loadingConfig && !configError && (
        <>
          {pType === 'cloud' && <CloudProviderNotice provider={llm.provider} />}
          {pType === 'ollama' && <OllamaPanel />}
          {pType === 'lmstudio' && <LMStudioPanel />}
          {pType === 'unknown' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-[#252533] bg-[#0f0f18] px-5 py-4">
                <Info size={15} className="text-[#9090a8] shrink-0 mt-0.5" />
                <p className="text-xs text-[#9090a8] leading-relaxed">
                  Provider <span className="text-[#e8e4dd]">{llm.provider || 'non configurato'}</span> — download modelli non supportato direttamente.
                  Se usi Ollama o LM Studio, configuralo in <span className="text-[#c9a84c]">Servizi &rarr; LLM</span>.
                </p>
              </div>
              <OllamaPanel />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'comfyui', label: 'Modelli ComfyUI', icon: Cpu },
  { id: 'llm',    label: 'Modelli LLM',     icon: Package },
]

export default function ModelsScreen() {
  const [activeTab, setActiveTab] = useState('comfyui')

  return (
    <div className="min-h-screen bg-[#07070d] text-[#e8e4dd]">
      {/* Top bar */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between
                   px-6 h-14 border-b border-[#252533] bg-[#0f0f18]"
      >
        <div className="flex items-center gap-3">
          <Package size={18} className="text-[#c9a84c]" />
          <h1 className="font-['Playfair_Display'] text-lg font-semibold text-[#e8e4dd]">
            Modelli
          </h1>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 px-6 pt-5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              'flex items-center gap-2 px-5 py-2.5 text-sm border-b-2 transition-colors',
              activeTab === id
                ? 'border-[#c9a84c] text-[#c9a84c]'
                : 'border-transparent text-[#9090a8] hover:text-[#e8e4dd]'
            )}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
        <div className="flex-1 border-b-2 border-[#252533]" />
      </div>

      {/* Content */}
      <div className="px-6 py-5 max-w-5xl">
        {activeTab === 'comfyui' && <ComfyUIModelsTab />}
        {activeTab === 'llm'     && <LLMModelsTab />}
      </div>
    </div>
  )
}
