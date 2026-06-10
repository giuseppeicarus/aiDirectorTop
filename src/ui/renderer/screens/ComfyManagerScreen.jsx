import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Database, GitBranch, Loader2, Package, RefreshCw, Search, Server, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'

const API = API_BASE

function Badge({ children, tone = 'neutral' }) {
  const cls = {
    ok: 'bg-[var(--green)]/10 text-[var(--green)]',
    warn: 'bg-[var(--amber)]/10 text-[var(--amber)]',
    error: 'bg-[var(--red)]/10 text-[var(--red)]',
    gold: 'bg-[var(--gold)]/10 text-[var(--gold)]',
    neutral: 'bg-[var(--bg3)] text-[var(--text2)]',
  }[tone]
  return <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-mono', cls)}>{children}</span>
}

function NodeCard({ node, selected, onSelect, onScan }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node)}
      className={clsx(
        'w-full text-left rounded-lg border p-3 transition-colors',
        selected ? 'border-[var(--gold)] bg-[var(--gold)]/5' : 'border-[var(--border)] bg-[var(--bg2)] hover:border-[var(--border2)]',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded bg-[var(--bg3)] flex items-center justify-center shrink-0">
          <Server size={15} className="text-[var(--gold)]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text)] truncate">{node.name}</span>
            <Badge tone={node.status === 'online' ? 'ok' : node.status === 'error' ? 'error' : 'warn'}>{node.status}</Badge>
          </div>
          <p className="text-[11px] text-[var(--text3)] font-mono truncate mt-0.5">{node.host}:{node.port}</p>
          <div className="flex gap-2 mt-2">
            <Badge>{node.custom_nodes_count || 0} custom</Badge>
            <Badge tone={node.issues_count ? 'warn' : 'neutral'}>{node.issues_count || 0} issues</Badge>
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onScan(node) }}
          className="px-2 py-1 rounded border border-[var(--border)] text-[10px] text-[var(--text2)] hover:text-[var(--gold)] hover:border-[var(--gold)]/50"
        >
          SCAN
        </button>
      </div>
    </button>
  )
}

export default function ComfyManagerScreen() {
  const [nodes, setNodes] = useState([])
  const [catalog, setCatalog] = useState([])
  const [selected, setSelected] = useState(null)
  const [customNodes, setCustomNodes] = useState(null)
  const [scanPath, setScanPath] = useState('')
  const [workflowTarget, setWorkflowTarget] = useState('LTX2.3_Music_Video_Creator_I2V_V5_1.json')
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function apiJson(url, options) {
    const res = await fetch(url, options)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data?.detail?.error || data?.detail || data?.error || `HTTP ${res.status}`)
    return data
  }

  async function loadAll() {
    setError('')
    const [nodeData, catalogData] = await Promise.all([
      apiJson(`${API}/comfy/nodes`),
      apiJson(`${API}/custom-nodes/catalog`),
    ])
    setNodes(nodeData.nodes || [])
    setCatalog(catalogData.packages || [])
    if (!selected && nodeData.nodes?.[0]) setSelected(nodeData.nodes[0])
  }

  async function loadCustom(node = selected) {
    if (!node) return
    const data = await apiJson(`${API}/comfy/nodes/${node.id}/custom-nodes`)
    setCustomNodes(data)
  }

  async function scanNode(node = selected) {
    if (!node) return
    setLoading(true); setError('')
    try {
      const body = scanPath.trim() ? { comfy_root_path: scanPath.trim() } : {}
      const result = await apiJson(`${API}/comfy/nodes/${node.id}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setCustomNodes({ installed: result.installed || [], unknown: result.unknown || [], node_types: result.node_types || [] })
      await loadAll()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function analyzeWorkflow() {
    setLoading(true); setError('')
    try {
      const result = await apiJson(`${API}/workflows/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: workflowTarget.trim() }),
      })
      setAnalysis(result)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll().catch(e => setError(e.message)) }, [])
  useEffect(() => { if (selected) loadCustom(selected).catch(() => setCustomNodes(null)) }, [selected?.id])

  return (
    <div className="h-full overflow-auto bg-[var(--bg0)] text-[var(--text)]">
      <div className="max-w-7xl mx-auto p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">ComfyUI Node Manager</h1>
            <p className="text-sm text-[var(--text2)] mt-1">Discovery reale custom node, registry e compatibilità workflow.</p>
          </div>
          <button onClick={() => loadAll().catch(e => setError(e.message))} className="flex items-center gap-2 px-3 py-2 rounded border border-[var(--border)] text-sm text-[var(--text2)] hover:text-[var(--gold)]">
            <RefreshCw size={14} /> Aggiorna
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 border border-[var(--red)]/30 bg-[var(--red)]/10 rounded-lg px-3 py-2 text-sm text-[var(--red)]">
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        <div className="grid grid-cols-12 gap-4">
          <section className="col-span-12 lg:col-span-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text2)] uppercase tracking-wider">
              <Server size={13} /> Comfy Nodes
            </div>
            {nodes.map(node => (
              <NodeCard key={node.id} node={node} selected={selected?.id === node.id} onSelect={setSelected} onScan={scanNode} />
            ))}
          </section>

          <section className="col-span-12 lg:col-span-8 rounded-lg border border-[var(--border)] bg-[var(--bg1)] p-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
              <input
                value={scanPath}
                onChange={e => setScanPath(e.target.value)}
                placeholder="Path ComfyUI root opzionale, es. Z:\\ComfyUI\\ComfyUI_windows_portable"
                className="bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--gold)]/60"
              />
              <button onClick={() => scanNode()} disabled={!selected || loading} className="flex items-center justify-center gap-2 px-4 py-2 rounded bg-[var(--gold)] text-[var(--bg0)] text-sm font-semibold disabled:opacity-50">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Scan Node
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="rounded border border-[var(--border)] bg-[var(--bg2)] p-3">
                <div className="flex items-center gap-2 text-xs text-[var(--green)]"><CheckCircle2 size={13} /> Installed</div>
                <div className="text-2xl mt-2">{customNodes?.installed?.length || 0}</div>
              </div>
              <div className="rounded border border-[var(--border)] bg-[var(--bg2)] p-3">
                <div className="flex items-center gap-2 text-xs text-[var(--amber)]"><AlertTriangle size={13} /> Unknown</div>
                <div className="text-2xl mt-2">{customNodes?.unknown?.length || 0}</div>
              </div>
              <div className="rounded border border-[var(--border)] bg-[var(--bg2)] p-3">
                <div className="flex items-center gap-2 text-xs text-[var(--gold)]"><Database size={13} /> Node Types</div>
                <div className="text-2xl mt-2">{customNodes?.node_types?.length || 0}</div>
              </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div>
                <h2 className="text-sm font-medium mb-2">Installati / Issues</h2>
                <div className="space-y-2 max-h-72 overflow-auto">
                  {(customNodes?.installed || []).map(item => (
                    <div key={`${item.package_id}-${item.folder_name}`} className="rounded border border-[var(--border)] bg-[var(--bg2)] p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm truncate">{item.folder_name}</span>
                        <Badge tone={item.dependencies_status === 'ok' ? 'ok' : item.dependencies_status === 'missing' ? 'warn' : 'neutral'}>{item.dependencies_status}</Badge>
                      </div>
                      {item.missing_dependencies?.length > 0 && <p className="text-[11px] text-[var(--amber)] mt-1">Missing: {item.missing_dependencies.join(', ')}</p>}
                    </div>
                  ))}
                  {!customNodes?.installed?.length && <p className="text-sm text-[var(--text3)]">Nessuna scansione installati disponibile.</p>}
                </div>
              </div>
              <div>
                <h2 className="text-sm font-medium mb-2">Unknown Custom Nodes</h2>
                <div className="space-y-2 max-h-72 overflow-auto">
                  {(customNodes?.unknown || []).map(item => (
                    <div key={`${item.folder_name}-${item.path}`} className="rounded border border-[var(--amber)]/25 bg-[var(--amber)]/5 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm truncate">{item.folder_name}</span>
                        <Badge tone="warn">{item.status}</Badge>
                      </div>
                      <p className="text-[10px] text-[var(--text3)] font-mono truncate mt-1">{item.git_url || item.path}</p>
                    </div>
                  ))}
                  {!customNodes?.unknown?.length && <p className="text-sm text-[var(--text3)]">Nessun unknown rilevato.</p>}
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg1)] p-4">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text2)] uppercase tracking-wider mb-3">
              <Package size={13} /> Custom Node Registry
            </div>
            <div className="space-y-2 max-h-80 overflow-auto">
              {catalog.map(pkg => (
                <div key={pkg.id} className="rounded border border-[var(--border)] bg-[var(--bg2)] p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">{pkg.name}</span>
                    <Badge tone={pkg.trusted ? 'ok' : 'neutral'}>{pkg.trusted ? 'trusted' : 'untrusted'}</Badge>
                  </div>
                  <p className="text-[10px] text-[var(--text3)] font-mono truncate mt-1">{pkg.github_url}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[var(--border)] bg-[var(--bg1)] p-4 space-y-3">
            <div className="flex items-center gap-2 text-xs font-mono text-[var(--text2)] uppercase tracking-wider">
              <GitBranch size={13} /> Workflow Compatibility
            </div>
            <div className="flex gap-2">
              <input value={workflowTarget} onChange={e => setWorkflowTarget(e.target.value)} className="flex-1 bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--gold)]/60" />
              <button onClick={analyzeWorkflow} disabled={loading || !workflowTarget.trim()} className="px-4 py-2 rounded bg-[var(--gold)] text-[var(--bg0)] text-sm font-semibold disabled:opacity-50">Analyze</button>
            </div>
            {analysis && (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="text-3xl font-mono text-[var(--gold)]">{analysis.compatibility_score}%</div>
                  <div className="text-sm text-[var(--text2)]">Compatibility score<br />{analysis.total_node_types} node types</div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                  <div className="rounded bg-[var(--bg2)] border border-[var(--border)] p-2"><CheckCircle2 size={13} className="text-[var(--green)] inline mr-1" /> OK {analysis.ok?.length || 0}</div>
                  <div className="rounded bg-[var(--bg2)] border border-[var(--border)] p-2"><AlertTriangle size={13} className="text-[var(--amber)] inline mr-1" /> Missing {analysis.missing_custom_nodes?.length || 0}</div>
                  <div className="rounded bg-[var(--bg2)] border border-[var(--border)] p-2"><XCircle size={13} className="text-[var(--red)] inline mr-1" /> Unknown {analysis.unknown_node_types?.length || 0}</div>
                </div>
                {analysis.missing_custom_nodes?.length > 0 && <p className="text-xs text-[var(--amber)]">Missing: {analysis.missing_custom_nodes.map(x => x.folder_name || x.class_type).join(', ')}</p>}
                {analysis.unknown_node_types?.length > 0 && <p className="text-xs text-[var(--red)]">Unknown: {analysis.unknown_node_types.join(', ')}</p>}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

