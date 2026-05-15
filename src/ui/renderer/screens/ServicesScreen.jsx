import { useState, useEffect } from 'react'
import { Activity, CheckCircle, XCircle, RefreshCw, Brain, Server, Database, Film, HardDrive } from 'lucide-react'

const API = 'http://localhost:8765/api'

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
