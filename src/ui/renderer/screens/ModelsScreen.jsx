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
} from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

// ---------------------------------------------------------------------------
// Model catalog data
// ---------------------------------------------------------------------------

const MODEL_CATALOG = [
  {
    group: 'WAN 2.1',
    subtitle: 'txt2img · img2video',
    workflows: ['wan_txt2img', 'wan_img2video'],
    models: [
      {
        file: 'wan2.1_t2v_14B_bf16.safetensors',
        type: 'Checkpoint',
        folder: 'models/checkpoints/',
        url: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-14B',
        workflows: ['WAN txt2img'],
      },
      {
        file: 'wan2.1_i2v_480p.safetensors',
        type: 'Checkpoint',
        folder: 'models/checkpoints/',
        url: 'https://huggingface.co/Wan-AI/Wan2.1-I2V-14B-480P',
        workflows: ['WAN img2video'],
      },
    ],
  },
  {
    group: 'SDXL',
    subtitle: 'txt2img',
    workflows: ['sdxl_txt2img'],
    models: [
      {
        file: 'sd_xl_base_1.0.safetensors',
        type: 'Checkpoint',
        folder: 'models/checkpoints/',
        url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
        workflows: ['SDXL txt2img'],
      },
      {
        file: 'sdxl_vae.safetensors',
        type: 'VAE',
        folder: 'models/vae/',
        url: 'https://huggingface.co/stabilityai/sdxl-vae',
        workflows: ['SDXL txt2img'],
      },
    ],
  },
  {
    group: 'FLUX Dev',
    subtitle: 'txt2img',
    workflows: ['flux_txt2img'],
    models: [
      {
        file: 'flux1-dev.safetensors',
        type: 'Checkpoint',
        folder: 'models/checkpoints/',
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
        workflows: ['FLUX txt2img'],
      },
      {
        file: 'ae.safetensors',
        type: 'VAE',
        folder: 'models/vae/',
        url: 'https://huggingface.co/black-forest-labs/FLUX.1-dev',
        workflows: ['FLUX txt2img'],
      },
      {
        file: 't5xxl_fp16.safetensors',
        type: 'CLIP',
        folder: 'models/clip/',
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders',
        workflows: ['FLUX txt2img', 'LTX Director'],
      },
      {
        file: 'clip_l.safetensors',
        type: 'CLIP',
        folder: 'models/clip/',
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders',
        workflows: ['FLUX txt2img'],
      },
    ],
  },
  {
    group: 'LTX Director 2.3',
    subtitle: 'img2video · img+audio2video',
    workflows: ['ltx_img2video', 'ltx_audio2video'],
    models: [
      {
        file: 'ltx-video-2b-v0.9.6.safetensors',
        type: 'Checkpoint',
        folder: 'models/checkpoints/',
        url: 'https://huggingface.co/Lightricks/LTX-Video',
        workflows: ['LTX Director img2video', 'LTX Director audio2video'],
      },
      {
        file: 'ltx-video-vae-decode-v0.9.6.safetensors',
        type: 'VAE',
        folder: 'models/vae/',
        url: 'https://huggingface.co/Lightricks/LTX-Video',
        workflows: ['LTX Director img2video', 'LTX Director audio2video'],
      },
      {
        file: 't5xxl_fp16.safetensors',
        type: 'CLIP',
        folder: 'models/clip/',
        url: 'https://huggingface.co/comfyanonymous/flux_text_encoders',
        workflows: ['LTX Director img2video', 'FLUX txt2img'],
      },
      {
        file: 'ltxv_spatial_upscaler_0.9.7.safetensors',
        type: 'Upscaler',
        folder: 'models/upscale_models/',
        url: 'https://huggingface.co/Lightricks/LTX-Video',
        workflows: ['LTX Director img2video'],
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// LLM role labels
// ---------------------------------------------------------------------------

const LLM_ROLES = [
  { key: 'story_analyst',       label: 'Story Analyst' },
  { key: 'narrative_director',  label: 'Narrative Director' },
  { key: 'cinematographer',     label: 'Cinematographer' },
  { key: 'prompt_engineer',     label: 'Prompt Engineer' },
  { key: 'continuity_checker',  label: 'Continuity Checker' },
]

const OLLAMA_QUICK = [
  'gemma3:4b',
  'gemma3:12b',
  'llama3.2:3b',
  'mistral:7b',
  'qwen2.5:7b',
  'deepseek-r1:7b',
]

// ---------------------------------------------------------------------------
// Helper: type badge color
// ---------------------------------------------------------------------------

function typeBadgeClass(type) {
  switch (type) {
    case 'Checkpoint': return 'bg-[#3b82f6]/15 text-[#3b82f6] border-[#3b82f6]/30'
    case 'VAE':        return 'bg-[#a855f7]/15 text-[#a855f7] border-[#a855f7]/30'
    case 'CLIP':       return 'bg-[#22c55e]/15 text-[#22c55e] border-[#22c55e]/30'
    case 'LoRA':       return 'bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30'
    case 'Upscaler':   return 'bg-[#c9a84c]/15 text-[#c9a84c] border-[#c9a84c]/30'
    case 'Audio VAE':  return 'bg-[#ef4444]/15 text-[#ef4444] border-[#ef4444]/30'
    default:           return 'bg-[#9090a8]/15 text-[#9090a8] border-[#9090a8]/30'
  }
}

// ---------------------------------------------------------------------------
// ModelCard
// ---------------------------------------------------------------------------

function ModelCard({ model }) {
  const handleDownload = () => {
    window.open(model.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      className="rounded-lg border border-[#252533] bg-[#16161f] p-4
                 hover:border-[#32324a] transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Filename */}
          <p className="font-mono text-xs text-[#e8e4dd] truncate" title={model.file}>
            {model.file}
          </p>

          {/* Folder path */}
          <p className="font-mono text-[10px] text-[#555568] mt-1">
            {model.folder}
          </p>

          {/* Workflows */}
          <div className="flex flex-wrap gap-1 mt-2">
            {model.workflows.map((w) => (
              <span
                key={w}
                className="text-[9px] px-1.5 py-0.5 rounded border
                           bg-[#c9a84c]/10 text-[#c9a84c] border-[#c9a84c]/25
                           font-mono"
              >
                {w}
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {/* Type badge */}
          <span
            className={clsx(
              'text-[9px] px-1.5 py-0.5 rounded-full border font-mono uppercase tracking-wide',
              typeBadgeClass(model.type)
            )}
          >
            {model.type}
          </span>

          {/* Status badge */}
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-full border
                       bg-[#9090a8]/10 text-[#9090a8] border-[#9090a8]/30"
          >
            Non scaricato
          </span>
        </div>
      </div>

      {/* Download button */}
      <button
        onClick={handleDownload}
        className="mt-3 w-full flex items-center justify-center gap-1.5
                   text-[11px] py-1.5 rounded
                   bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20
                   text-[#c9a84c] border border-[#c9a84c]/25 hover:border-[#c9a84c]/50
                   transition-colors"
      >
        <Download size={11} />
        Download da HuggingFace
        <ExternalLink size={10} className="opacity-60" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelGroup
// ---------------------------------------------------------------------------

function ModelGroup({ group }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-4
                   hover:bg-[#16161f] transition-colors text-left"
      >
        {open
          ? <ChevronDown size={15} className="text-[#9090a8] shrink-0" />
          : <ChevronRight size={15} className="text-[#9090a8] shrink-0" />
        }
        <div className="flex-1 min-w-0">
          <span className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">
            {group.group}
          </span>
          <span className="ml-3 text-xs text-[#9090a8]">{group.subtitle}</span>
        </div>
        <span className="text-[10px] text-[#555568] font-mono">
          {group.models.length} file
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {group.models.map((m) => (
            <ModelCard key={m.file + m.folder} model={m} />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 1: ComfyUI Models
// ---------------------------------------------------------------------------

function ComfyUIModelsTab() {
  return (
    <div className="space-y-4">
      {/* Info box */}
      <div
        className="flex items-start gap-3 rounded-lg border border-[#c9a84c]/25
                   bg-[#c9a84c]/5 px-4 py-3"
      >
        <Info size={15} className="text-[#c9a84c] shrink-0 mt-0.5" />
        <p className="text-xs text-[#9090a8] leading-relaxed">
          I modelli vanno copiati nelle cartelle indicate all&apos;interno della directory di
          installazione di ComfyUI. Riavvia ComfyUI dopo il download.
        </p>
      </div>

      {MODEL_CATALOG.map((group) => (
        <ModelGroup key={group.group} group={group} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LLM role grid
// ---------------------------------------------------------------------------

function RoleRow({ roleKey, label, cfg }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-3
                 border-b border-[#252533] last:border-b-0"
    >
      <div className="w-36 shrink-0">
        <p className="text-xs text-[#e8e4dd]">{label}</p>
      </div>
      {cfg ? (
        <>
          <span
            className="text-[10px] px-2 py-0.5 rounded border font-mono
                       bg-[#3b82f6]/10 text-[#3b82f6] border-[#3b82f6]/25"
          >
            {cfg.provider ?? '—'}
          </span>
          <span className="font-mono text-[11px] text-[#9090a8] truncate flex-1">
            {cfg.model ?? '—'}
          </span>
          {cfg.temperature != null && (
            <span className="text-[10px] text-[#555568] font-mono shrink-0">
              temp {cfg.temperature}
            </span>
          )}
        </>
      ) : (
        <span className="text-[11px] text-[#555568] font-mono">non configurato</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Ollama model list item
// ---------------------------------------------------------------------------

function OllamaModelRow({ name, size, modified }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#252533] last:border-b-0">
      <Database size={13} className="text-[#9090a8] shrink-0" />
      <span className="font-mono text-xs text-[#e8e4dd] flex-1">{name}</span>
      {size && (
        <span className="text-[10px] text-[#555568] font-mono">{size}</span>
      )}
      {modified && (
        <span className="text-[10px] text-[#555568]">{modified}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab 2: LLM Models
// ---------------------------------------------------------------------------

function LLMModelsTab() {
  const [config, setConfig] = useState(null)
  const [configError, setConfigError] = useState(null)
  const [loadingConfig, setLoadingConfig] = useState(true)

  const [ollamaModels, setOllamaModels] = useState([])
  const [ollamaError, setOllamaError] = useState(null)
  const [loadingOllama, setLoadingOllama] = useState(true)

  const [pullModel, setPullModel] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState(null)

  // Fetch app config
  useEffect(() => {
    let cancelled = false
    setLoadingConfig(true)
    fetch(`${API_BASE}/config`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) {
          setConfig(data)
          setConfigError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setConfigError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoadingConfig(false)
      })
    return () => { cancelled = true }
  }, [])

  // Fetch Ollama models
  const loadOllamaModels = useCallback(() => {
    setLoadingOllama(true)
    fetch(`${API_BASE}/llm/ollama/models`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        setOllamaModels(Array.isArray(data.models) ? data.models : [])
        setOllamaError(null)
      })
      .catch(() => {
        setOllamaError('Ollama non disponibile')
        setOllamaModels([])
      })
      .finally(() => setLoadingOllama(false))
  }, [])

  useEffect(() => {
    loadOllamaModels()
  }, [loadOllamaModels])

  const handlePull = async (modelName) => {
    const name = modelName || pullModel
    if (!name.trim()) return
    setPulling(true)
    setPullResult(null)
    try {
      const r = await fetch(`${API_BASE}/llm/ollama/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name.trim() }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setPullResult({ ok: true, message: data.message ?? 'Download avviato' })
      loadOllamaModels()
    } catch {
      setPullResult({ ok: false, message: 'Ollama non disponibile o modello non trovato' })
    } finally {
      setPulling(false)
    }
  }

  const llm = config?.llm ?? {}
  const llmRoles = config?.llm_roles ?? {}

  return (
    <div className="space-y-6">
      {/* Default LLM Config */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533]">
          <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">
            Configurazione LLM
          </h3>
          <p className="text-[11px] text-[#9090a8] mt-0.5">
            Provider e modello predefiniti e configurazione per ruolo
          </p>
        </div>

        {loadingConfig ? (
          <div className="flex items-center gap-2 px-5 py-6 text-[#9090a8] text-sm">
            <Loader2 size={14} className="animate-spin" />
            Caricamento configurazione...
          </div>
        ) : configError ? (
          <div className="flex items-start gap-2 px-5 py-4">
            <AlertCircle size={14} className="text-[#ef4444] shrink-0 mt-0.5" />
            <p className="text-xs text-[#ef4444]">
              Impossibile caricare la configurazione: {configError}
            </p>
          </div>
        ) : (
          <>
            {/* Default */}
            <div className="px-5 py-4 border-b border-[#252533]">
              <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-3">
                Predefinito
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className="text-[11px] px-2.5 py-1 rounded border font-mono
                             bg-[#3b82f6]/10 text-[#3b82f6] border-[#3b82f6]/25"
                >
                  {llm.provider ?? '—'}
                </span>
                <span className="font-mono text-sm text-[#e8e4dd]">
                  {llm.model ?? '—'}
                </span>
                {llm.temperature != null && (
                  <span className="text-[11px] text-[#555568] font-mono">
                    temperature: {llm.temperature}
                  </span>
                )}
              </div>
            </div>

            {/* Per-role */}
            <div>
              <div className="px-5 py-3 border-b border-[#252533]">
                <p className="text-[10px] text-[#555568] uppercase tracking-wider">
                  Configurazione per ruolo
                </p>
              </div>
              {LLM_ROLES.map(({ key, label }) => (
                <RoleRow
                  key={key}
                  roleKey={key}
                  label={label}
                  cfg={llmRoles[key] ?? null}
                />
              ))}
            </div>
          </>
        )}
      </section>

      {/* Ollama section */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533] flex items-center justify-between">
          <div>
            <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">
              Scarica modelli Ollama
            </h3>
            <p className="text-[11px] text-[#9090a8] mt-0.5">
              Scarica ed esegui modelli LLM localmente tramite Ollama
            </p>
          </div>
          <button
            onClick={loadOllamaModels}
            disabled={loadingOllama}
            className="p-1.5 rounded text-[#9090a8] hover:text-[#e8e4dd]
                       hover:bg-[#1e1e2a] transition-colors disabled:opacity-40"
            title="Aggiorna lista"
          >
            <RefreshCw size={14} className={loadingOllama ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Quick buttons */}
          <div>
            <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-2">
              Download rapido
            </p>
            <div className="flex flex-wrap gap-2">
              {OLLAMA_QUICK.map((m) => (
                <button
                  key={m}
                  disabled={pulling}
                  onClick={() => handlePull(m)}
                  className="font-mono text-[11px] px-2.5 py-1 rounded border
                             bg-[#1e1e2a] border-[#32324a] text-[#9090a8]
                             hover:border-[#c9a84c]/50 hover:text-[#c9a84c]
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-colors"
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Custom model input */}
          <div>
            <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-2">
              Modello personalizzato
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={pullModel}
                onChange={(e) => setPullModel(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handlePull()}
                placeholder="es. gemma3:4b"
                className="flex-1 font-mono text-xs px-3 py-2 rounded border
                           bg-[#1e1e2a] border-[#252533] text-[#e8e4dd]
                           placeholder:text-[#555568]
                           focus:outline-none focus:border-[#c9a84c]/50
                           transition-colors"
              />
              <button
                onClick={() => handlePull()}
                disabled={pulling || !pullModel.trim()}
                className="flex items-center gap-1.5 px-4 py-2 rounded border
                           bg-[#c9a84c]/10 border-[#c9a84c]/25 text-[#c9a84c]
                           hover:bg-[#c9a84c]/20 hover:border-[#c9a84c]/50
                           disabled:opacity-40 disabled:cursor-not-allowed
                           text-xs transition-colors"
              >
                {pulling
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Play size={12} />
                }
                Avvia download
              </button>
            </div>
          </div>

          {/* Pull result */}
          {pullResult && (
            <div
              className={clsx(
                'flex items-start gap-2 rounded px-3 py-2.5 text-xs border',
                pullResult.ok
                  ? 'bg-[#22c55e]/5 border-[#22c55e]/25 text-[#22c55e]'
                  : 'bg-[#ef4444]/5 border-[#ef4444]/25 text-[#ef4444]'
              )}
            >
              {pullResult.ok
                ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" />
                : <XCircle size={13} className="shrink-0 mt-0.5" />
              }
              {pullResult.message}
            </div>
          )}

          {/* Installed models */}
          <div>
            <p className="text-[10px] text-[#555568] uppercase tracking-wider mb-2">
              Modelli installati
            </p>
            {loadingOllama ? (
              <div className="flex items-center gap-2 py-3 text-xs text-[#9090a8]">
                <Loader2 size={12} className="animate-spin" />
                Caricamento...
              </div>
            ) : ollamaError ? (
              <div className="flex items-start gap-2 rounded px-3 py-2.5
                              bg-[#ef4444]/5 border border-[#ef4444]/20 text-xs text-[#ef4444]">
                <AlertCircle size={13} className="shrink-0 mt-0.5" />
                {ollamaError}
              </div>
            ) : ollamaModels.length === 0 ? (
              <p className="text-xs text-[#555568] py-2">
                Nessun modello Ollama installato
              </p>
            ) : (
              <div className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
                {ollamaModels.map((m) => (
                  <OllamaModelRow
                    key={m.name ?? m}
                    name={m.name ?? m}
                    size={m.size}
                    modified={m.modified_at}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* LM Studio section */}
      <section className="rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#252533]">
          <h3 className="font-['Playfair_Display'] text-base font-semibold text-[#e8e4dd]">
            LM Studio
          </h3>
          <p className="text-[11px] text-[#9090a8] mt-0.5">
            Gestione modelli tramite interfaccia LM Studio
          </p>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div
            className="flex items-start gap-3 rounded-lg border border-[#252533]
                       bg-[#1e1e2a] px-4 py-3"
          >
            <Info size={14} className="text-[#9090a8] shrink-0 mt-0.5" />
            <p className="text-xs text-[#9090a8] leading-relaxed">
              I modelli LM Studio vengono gestiti direttamente dall&apos;applicazione LM Studio.
              Avvia LM Studio, carica il modello desiderato dal catalogo interno, poi configura
              l&apos;URL base in <span className="text-[#e8e4dd]">Servizi &rarr; LLM</span>.
            </p>
          </div>

          <button
            onClick={() => {
              if (window.__electron_ipc) {
                window.__electron_ipc.invoke?.('shell:open', 'lm-studio://')
              }
            }}
            className="flex items-center gap-2 px-4 py-2 rounded border
                       bg-[#1e1e2a] border-[#32324a] text-[#9090a8]
                       hover:border-[#c9a84c]/30 hover:text-[#e8e4dd]
                       text-xs transition-colors"
          >
            <MonitorDot size={13} />
            Apri LM Studio
          </button>
        </div>
      </section>
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
