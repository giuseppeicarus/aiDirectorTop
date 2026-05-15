import { useState, useEffect } from 'react'
import { Server, RefreshCw, Cpu, Layers, CheckCircle, XCircle, Clock } from 'lucide-react'

const API = 'http://localhost:8765/api'

function StatusDot({ online, quarantined }) {
  if (quarantined) return <span className="w-2 h-2 rounded-full bg-[var(--amber)] inline-block" title="In quarantena" />
  return online
    ? <span className="w-2 h-2 rounded-full bg-[var(--green)] inline-block animate-pulse" />
    : <span className="w-2 h-2 rounded-full bg-[var(--red)] inline-block" />
}

function Stat({ label, value, unit = '' }) {
  return (
    <div className="text-center">
      <div className="text-lg font-mono text-[var(--gold)]">{value}{unit}</div>
      <div className="text-xs text-[var(--text3)] mt-0.5">{label}</div>
    </div>
  )
}

export default function NodesScreen() {
  const [nodes, setNodes] = useState([])
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState(null)
  const [models, setModels] = useState(null)
  const [loadingModels, setLoadingModels] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const r = await fetch(`${API}/comfyui/nodes`)
      const data = await r.json()
      setNodes(Array.isArray(data) ? data : [])
    } catch { setNodes([]) }
    setLoading(false)
  }

  async function loadModels(idx) {
    setSelectedNode(idx)
    setLoadingModels(true)
    setModels(null)
    try {
      const r = await fetch(`${API}/comfyui/nodes/${idx}/models`)
      setModels(await r.json())
    } catch (e) {
      setModels({ error: e.message })
    }
    setLoadingModels(false)
  }

  useEffect(() => { refresh() }, [])

  const onlineCount = nodes.filter(n => n.online).length

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Server size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Nodi ComfyUI</h1>
          <span className="text-xs text-[var(--text3)] ml-1">{onlineCount}/{nodes.length} online</span>
        </div>
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Aggiorna
        </button>
      </div>

      {/* Node cards */}
      <div className="grid grid-cols-1 gap-3 mb-6">
        {nodes.length === 0 && !loading && (
          <div className="text-center py-12 text-[var(--text3)]">
            <Server size={40} className="mx-auto mb-3 opacity-30" />
            <p>Nessun nodo configurato</p>
            <p className="text-xs mt-1">Aggiungi nodi in ~/.cinematic-studio/config.yaml</p>
          </div>
        )}
        {nodes.map((node, i) => (
          <div key={i} className={`border rounded-lg p-4 cursor-pointer transition-colors ${selectedNode === i ? 'border-[var(--gold)]' : 'border-[var(--border)] hover:border-[var(--border2)]'}`}
               style={{ background: 'var(--bg2)' }} onClick={() => loadModels(i)}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <StatusDot online={node.online} quarantined={node.quarantined} />
                <div>
                  <div className="font-medium text-sm text-[var(--text)]">{node.name}</div>
                  <div className="text-xs text-[var(--text3)] font-mono">{node.host}:{node.port}</div>
                </div>
              </div>
              <div className="flex gap-6">
                <Stat label="Coda" value={node.queue_depth >= 0 ? node.queue_depth : '—'} />
                <Stat label="Stato" value={node.online ? (node.quarantined ? 'Quarantena' : 'Online') : 'Offline'} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Models panel */}
      {selectedNode !== null && (
        <div className="border border-[var(--border)] rounded-lg p-4 flex-1 overflow-y-auto" style={{ background: 'var(--bg1)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Layers size={14} className="text-[var(--gold)]" />
            <span className="text-sm text-[var(--text2)]">Modelli disponibili su {nodes[selectedNode]?.name}</span>
          </div>
          {loadingModels && <p className="text-xs text-[var(--text3)] animate-pulse">Caricamento...</p>}
          {models?.error && <p className="text-xs text-[var(--red)]">Errore: {models.error}</p>}
          {models && !models.error && (
            <div className="space-y-3">
              <div>
                <div className="text-xs text-[var(--text3)] mb-1 uppercase tracking-wider">Checkpoint ({models.checkpoints?.length || 0})</div>
                <div className="flex flex-wrap gap-1">
                  {models.checkpoints?.map(m => (
                    <span key={m} className="text-xs px-2 py-0.5 rounded font-mono" style={{ background: 'var(--bg3)', color: 'var(--text2)' }}>{m}</span>
                  ))}
                </div>
              </div>
              {models.video_models?.length > 0 && (
                <div>
                  <div className="text-xs text-[var(--text3)] mb-1 uppercase tracking-wider">Video ({models.video_models.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {models.video_models.map(m => (
                      <span key={m} className="text-xs px-2 py-0.5 rounded font-mono" style={{ background: 'var(--bg3)', color: 'var(--gold)' }}>{m}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
