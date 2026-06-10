import { useState, useEffect } from 'react'
import { Server, RefreshCw, Layers, Star, ChevronDown, ChevronRight, Terminal, Save, Loader2, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { API_BASE } from '../utils/apiClient'
import ComfyUIQueuePanel from '../components/ComfyUIQueuePanel'

const API = API_BASE

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
const isLocal = (host) => LOCAL_HOSTS.includes((host || '').toLowerCase())

function StatusDot({ online, quarantined }) {
  if (quarantined) return <span className="w-2 h-2 rounded-full bg-[var(--amber)] inline-block" title="In quarantena" />
  return online
    ? <span className="w-2 h-2 rounded-full bg-[var(--green)] inline-block animate-pulse" />
    : <span className="w-2 h-2 rounded-full bg-[var(--red)] inline-block" />
}

function Stat({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-lg font-mono text-[var(--gold)]">{value}</div>
      <div className="text-xs text-[var(--text3)] mt-0.5">{label}</div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-[11px] text-[var(--text3)] mb-1">{label}</label>
      {children}
    </div>
  )
}

const inputCls = "w-full bg-[var(--bg0)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text)] placeholder-[var(--text3)] focus:border-[var(--gold)] outline-none font-mono"

// ── SSH / Provisioning panel per nodo remoto ──────────────────────────────────

function SshProvisioningPanel({ nodeIdx, initial, onSaved }) {
  const [form, setForm] = useState({
    provisioning_enabled: initial.provisioning_enabled ?? false,
    ssh_port:        initial.ssh_port        ?? 22,
    ssh_user:        initial.ssh_user        ?? 'root',
    ssh_password:    initial.ssh_password    ?? '',
    ssh_private_key: initial.ssh_private_key ?? '',
  })
  const [showPwd, setShowPwd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  async function save() {
    setSaving(true)
    setError(null)
    try {
      // Recupera la config completa del nodo e la aggiorna
      const cfgRes = await fetch(`${API}/comfyui/nodes/config`)
      const cfgData = await cfgRes.json()
      const nodes = Array.isArray(cfgData) ? cfgData : (cfgData?.nodes || [])
      const node = nodes[nodeIdx]
      if (!node) throw new Error('Nodo non trovato')

      const updated = {
        ...node,
        provisioning_enabled: form.provisioning_enabled,
        ssh_port:        Number(form.ssh_port) || 22,
        ssh_user:        form.ssh_user || 'root',
        ssh_password:    form.ssh_password || null,
        ssh_private_key: form.ssh_private_key || null,
      }

      const res = await fetch(`${API}/comfyui/nodes/config/${nodeIdx}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      })
      if (!res.ok) throw new Error(await res.text())
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onSaved?.()
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-3">
      {/* Toggle provisioning */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-medium text-[var(--text)]">Provisioning SSH</span>
          <p className="text-[10px] text-[var(--text3)] mt-0.5">
            Abilita per installare modelli su questo nodo
          </p>
        </div>
        <button
          onClick={() => setForm(f => ({ ...f, provisioning_enabled: !f.provisioning_enabled }))}
          className={`relative w-10 h-5 rounded-full transition-colors ${form.provisioning_enabled ? 'bg-[var(--gold)]' : 'bg-[var(--border2)]'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.provisioning_enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {/* SSH fields — visibili solo se provisioning abilitato */}
      {form.provisioning_enabled && (
        <div className="space-y-2 pl-0">
          <div className="flex gap-2">
            <Field label="Porta SSH">
              <input
                type="number"
                value={form.ssh_port}
                onChange={set('ssh_port')}
                className={inputCls}
                placeholder="22"
              />
            </Field>
            <Field label="Utente SSH">
              <input
                value={form.ssh_user}
                onChange={set('ssh_user')}
                className={inputCls}
                placeholder="root"
              />
            </Field>
          </div>

          <Field label="Password SSH">
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                value={form.ssh_password}
                onChange={set('ssh_password')}
                className={`${inputCls} pr-8`}
                placeholder="lascia vuoto per chiave"
              />
              <button
                onClick={() => setShowPwd(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text3)] hover:text-[var(--text2)]"
              >
                {showPwd ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          </Field>

          <Field label="Chiave privata SSH (PEM)">
            <textarea
              value={form.ssh_private_key}
              onChange={set('ssh_private_key')}
              rows={5}
              spellCheck={false}
              className={`${inputCls} resize-none leading-relaxed`}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
            />
          </Field>
        </div>
      )}

      {/* Salva */}
      <div className="flex items-center justify-between pt-1">
        {error && <p className="text-[10px] text-[var(--red)] truncate flex-1 mr-2">{error}</p>}
        {!error && saved && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--green)]">
            <CheckCircle2 size={11} /> Salvato
          </span>
        )}
        {!error && !saved && <span />}
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--gold)] hover:bg-[var(--gold2)] text-[var(--bg0)] rounded text-xs font-medium disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          Salva
        </button>
      </div>
    </div>
  )
}

// ── NodeCard ──────────────────────────────────────────────────────────────────

function NodeCard({ node, idx, onSelect, selected, onRefresh }) {
  const [sshOpen, setSshOpen] = useState(false)

  return (
    <div
      className={`border rounded-lg transition-colors ${selected ? 'border-[var(--gold)]' : 'border-[var(--border)] hover:border-[var(--border2)]'}`}
      style={{ background: 'var(--bg2)' }}
    >
      {/* Main row */}
      <div className="flex items-center justify-between p-4 cursor-pointer" onClick={() => onSelect(idx)}>
        <div className="flex items-center gap-3">
          <StatusDot online={node.online} quarantined={node.quarantined} />
          <div>
            <div className="font-medium text-sm text-[var(--text)] flex items-center gap-2">
              {node.name}
              {node.primary && (
                <span className="text-[10px] px-1.5 py-0.5 rounded text-[var(--gold)] border border-[var(--gold)]/30 flex items-center gap-0.5">
                  <Star size={9} className="fill-current" /> Principale
                </span>
              )}
              {node.provisioning_enabled && !isLocal(node.host) && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--gold)]/10 text-[var(--gold)] border border-[var(--gold)]/20 flex items-center gap-0.5">
                  <Terminal size={9} /> SSH
                </span>
              )}
            </div>
            <div className="text-xs text-[var(--text3)] font-mono">{node.host}:{node.port}</div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <Stat label="Coda" value={node.queue_depth >= 0 ? node.queue_depth : '—'} />
          <Stat label="Stato" value={node.online ? (node.quarantined ? 'Quarantena' : 'Online') : 'Offline'} />
          {/* SSH toggle — solo nodi remoti */}
          {!isLocal(node.host) && (
            <button
              onClick={e => { e.stopPropagation(); setSshOpen(v => !v) }}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10 border border-transparent hover:border-[var(--gold)]/20 transition-colors"
              title="Configura SSH / Provisioning"
            >
              <Terminal size={12} />
              SSH
              {sshOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          )}
        </div>
      </div>

      {/* SSH / Provisioning panel */}
      {!isLocal(node.host) && sshOpen && (
        <div className="px-4 pb-4">
          <SshProvisioningPanel
            nodeIdx={idx}
            initial={node}
            onSaved={() => { onRefresh(); setSshOpen(false) }}
          />
        </div>
      )}
    </div>
  )
}

// ── Main Screen ───────────────────────────────────────────────────────────────

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
      // Merge runtime status con config (per avere ssh_* e provisioning_enabled)
      const statusList = Array.isArray(data) ? data : []

      const cfgRes = await fetch(`${API}/comfyui/nodes/config`)
      const cfgData = await cfgRes.json()
      const cfgList = Array.isArray(cfgData) ? cfgData : (cfgData?.nodes || [])

      // Il pool riordina per priorità; usiamo config come lista canonica
      // e cerchiamo il match per host:port
      const merged = cfgList.map((cfg, idx) => {
        const rt = statusList.find(s => s.host === cfg.host && s.port === cfg.port) || {}
        return { ...cfg, ...rt, _cfgIdx: idx }
      })
      setNodes(merged)
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
  const provCount = nodes.filter(n => n.provisioning_enabled && !isLocal(n.host)).length

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Server size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Nodi ComfyUI</h1>
          <span className="text-xs text-[var(--text3)] ml-1">{onlineCount}/{nodes.length} online</span>
          {provCount > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--gold)]/10 text-[var(--gold)] border border-[var(--gold)]/20 flex items-center gap-1">
              <Terminal size={10} /> {provCount} SSH
            </span>
          )}
        </div>
        <button onClick={refresh} disabled={loading} className="flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)] hover:text-[var(--gold)]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Aggiorna
        </button>
      </div>

      {/* ComfyUI Queue attiva */}
      <div className="mb-4">
        <ComfyUIQueuePanel />
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
          <NodeCard
            key={i}
            node={node}
            idx={node._cfgIdx ?? i}
            selected={selectedNode === i}
            onSelect={() => loadModels(node._cfgIdx ?? i)}
            onRefresh={refresh}
          />
        ))}
      </div>

      {/* Models panel */}
      {selectedNode !== null && (
        <div className="border border-[var(--border)] rounded-lg p-4 flex-1 overflow-y-auto" style={{ background: 'var(--bg1)' }}>
          <div className="flex items-center gap-2 mb-3">
            <Layers size={14} className="text-[var(--gold)]" />
            <span className="text-sm text-[var(--text2)]">Modelli su {nodes.find(n => (n._cfgIdx ?? nodes.indexOf(n)) === selectedNode)?.name}</span>
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
