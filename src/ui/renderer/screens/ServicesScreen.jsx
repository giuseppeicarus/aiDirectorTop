import { useState, useEffect } from 'react'
import { Activity, CheckCircle, XCircle, RefreshCw, Brain, Server, Database, Film, HardDrive, Mic } from 'lucide-react'
import { API_BASE } from '../utils/apiClient'

const API = API_BASE

function ServiceCard({ icon: Icon, title, status }) {
  const ok = status?.ok
  return (
    <div className="border rounded-lg p-4" style={{ background: 'var(--bg2)', borderColor: ok ? 'var(--border)' : 'var(--red)33' }}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={16} className={ok ? 'text-[var(--gold)]' : 'text-[var(--red)]'} />
          <span className="text-sm font-medium text-[var(--text)]">{title}</span>
        </div>
        {ok !== undefined && (
          ok ? <CheckCircle size={16} className="text-[var(--green)]" /> : <XCircle size={16} className="text-[var(--red)]" />
        )}
      </div>
      {status ? (
        <div className="space-y-1">
          {Object.entries(status).filter(([k]) => k !== 'ok' && k !== 'nodes').map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-xs">
              <span className="text-[var(--text3)] w-24 shrink-0">{k.replace(/_/g, ' ')}</span>
              <span className="text-[var(--text2)] font-mono truncate">{String(v)}</span>
            </div>
          ))}
          {status.nodes?.map((n, i) => (
            <div key={i} className="flex items-center gap-2 text-xs ml-2">
              <span className={`w-2 h-2 rounded-full ${n.online ? 'bg-[var(--green)]' : 'bg-[var(--red)]'}`} />
              <span className="text-[var(--text3)]">{n.name}</span>
              <span className="text-[var(--text3)]">— coda: {n.queue_depth}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--text3)] animate-pulse">Verifica in corso...</p>
      )}
    </div>
  )
}

function WhisperConfigSection() {
  const [modelSize, setModelSize] = useState('base')
  const [language, setLanguage] = useState('')
  const [mode, setMode] = useState('local')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    fetch(`${API}/services/whisper-config`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => {
        if (d.model_size) setModelSize(d.model_size)
        if (d.language) setLanguage(d.language)
        if (d.mode) setMode(d.mode)
        if (d.remote_url) setRemoteUrl(d.remote_url)
      })
      .catch(e => setLoadError(String(e)))
  }, [])

  async function save() {
    setSaving(true)
    try {
      await fetch(`${API}/services/whisper-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_size: modelSize,
          language: language.trim() || null,
          mode,
          remote_url: mode === 'remote' ? remoteUrl.trim() : null,
        }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="rounded-lg border p-4 space-y-4"
      style={{ background: 'var(--bg2)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <Mic size={16} className="text-[var(--gold)]" />
        <span className="text-sm font-medium" style={{ color: '#c9a84c' }}>
          Whisper / Trascrizione Audio
        </span>
      </div>
      <p className="text-xs font-mono" style={{ color: 'var(--text2)' }}>
        Trascrizione automatica locale o via nodo remoto. Richiede openai-whisper installato.
      </p>

      {loadError && (
        <p className="text-xs font-mono" style={{ color: 'var(--red)' }}>
          Impossibile caricare config: {loadError}
        </p>
      )}

      <div className="space-y-3">
        <div>
          <label className="block text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
            Modello Whisper
          </label>
          <select
            value={modelSize}
            onChange={e => setModelSize(e.target.value)}
            className="w-full rounded px-3 py-1.5 text-xs font-mono border"
            style={{
              background: 'var(--bg3)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          >
            {['tiny', 'base', 'small', 'medium', 'large'].map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
            Lingua
          </label>
          <input
            type="text"
            value={language}
            onChange={e => setLanguage(e.target.value)}
            placeholder="auto (lascia vuoto per rilevamento automatico)"
            className="w-full rounded px-3 py-1.5 text-xs font-mono border"
            style={{
              background: 'var(--bg3)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
        </div>

        <div>
          <label className="block text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: 'var(--text3)' }}>
            Modo
          </label>
          <div className="flex gap-4">
            {[{ value: 'local', label: 'Locale' }, { value: 'remote', label: 'Nodo remoto' }].map(opt => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="whisper-mode"
                  value={opt.value}
                  checked={mode === opt.value}
                  onChange={() => setMode(opt.value)}
                  className="accent-[#c9a84c]"
                />
                <span className="text-xs font-mono" style={{ color: mode === opt.value ? '#c9a84c' : 'var(--text2)' }}>
                  {opt.label}
                </span>
              </label>
            ))}
          </div>
        </div>

        {mode === 'remote' && (
          <div>
            <label className="block text-[10px] font-mono uppercase tracking-wider mb-1" style={{ color: 'var(--text3)' }}>
              URL nodo remoto
            </label>
            <input
              type="text"
              value={remoteUrl}
              onChange={e => setRemoteUrl(e.target.value)}
              placeholder="http://192.168.1.100:8188"
              className="w-full rounded px-3 py-1.5 text-xs font-mono border"
              style={{
                background: 'var(--bg3)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono border"
          style={{
            background: saving ? 'transparent' : '#c9a84c18',
            borderColor: '#c9a84c66',
            color: '#c9a84c',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Salvataggio…' : 'Salva'}
        </button>
        {saved && (
          <span
            className="text-xs font-mono px-2 py-0.5 rounded border"
            style={{ background: '#22c55e18', borderColor: '#22c55e44', color: '#22c55e' }}
          >
            Salvato
          </span>
        )}
      </div>
    </div>
  )
}

export default function ServicesScreen() {
  const [services, setServices] = useState({})
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const r = await fetch(`${API}/services/status`)
      setServices(await r.json())
    } catch (e) {
      setServices({ error: e.message })
    }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [])

  const allOk = Object.values(services).every(s => s?.ok !== false)

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Activity size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Servizi</h1>
          {Object.keys(services).length > 0 && (
            <span className={`text-xs px-2 py-0.5 rounded font-mono ${allOk ? 'text-[var(--green)]' : 'text-[var(--amber)]'}`}
                  style={{ background: allOk ? '#22c55e22' : '#f59e0b22' }}>
              {allOk ? 'Tutti operativi' : 'Attenzione richiesta'}
            </span>
          )}
        </div>
        <button onClick={refresh} disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Aggiorna
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ServiceCard icon={Brain}    title="LLM"      status={services.llm} />
        <ServiceCard icon={Server}   title="ComfyUI"  status={services.comfyui} />
        <ServiceCard icon={Database} title="Database" status={services.database} />
        <ServiceCard icon={Film}     title="FFmpeg"   status={services.ffmpeg} />
      </div>

      <div className="mt-3">
        <WhisperConfigSection />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <ServiceCard icon={HardDrive} title="Storage" status={services.storage} />
      </div>

      {services.error && (
        <div className="mt-4 p-3 rounded border border-[var(--red)] text-xs text-[var(--red)]">
          Errore: {services.error}
        </div>
      )}
    </div>
  )
}
