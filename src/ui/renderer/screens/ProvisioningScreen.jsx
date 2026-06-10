import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Terminal, Wifi, WifiOff, Loader2, CheckCircle2, XCircle,
  FolderSearch, Server, Download, Trash2, HardDrive,
  CheckSquare, Square, Edit2, Check, X as XIcon, AlertTriangle, Copy,
} from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'
import { useProvisioningStore } from '../stores/provisioningStore'

const API = `${API_BASE}/provisioning`

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtGB(gb) {
  if (gb == null) return '?'
  if (gb < 1) return `${Math.round(gb * 1024)} MB`
  return `${gb.toFixed(1)} GB`
}
function totalSize(models, ids) {
  return models.filter(m => ids.has(m.id)).reduce((s, m) => s + (m.size_gb || 0), 0)
}
const CAT_COLOR = {
  gold:        'bg-[#c9a84c]/20 text-[#c9a84c]',
  blue:        'bg-[#3b82f6]/20 text-[#3b82f6]',
  green:       'bg-[#22c55e]/20 text-[#22c55e]',
  amber:       'bg-[#f59e0b]/20 text-[#f59e0b]',
  text2:       'bg-[#9090a8]/20 text-[#9090a8]',
}
function CatBadge({ cat, label }) {
  const cls = CAT_COLOR[cat] || CAT_COLOR.text2
  return <span className={clsx('text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0', cls)}>{label || cat}</span>
}
function lineColor(tag) {
  if (tag === 'DONE')             return 'text-[#22c55e]'
  if (tag === 'SKIP')             return 'text-[#555568]'
  if (tag === 'DOWNLOAD')         return 'text-[#c9a84c] font-semibold'
  if (tag === 'ERROR')            return 'text-[#ef4444]'
  if (tag === 'ERROR_AUTH')       return 'text-[#ef4444] font-semibold'
  if (tag === 'ERROR_404')        return 'text-[#f59e0b]'
  if (tag === 'WARN')             return 'text-[#f59e0b]'
  if (tag === 'PROGRESS')         return 'text-[#3b82f6]'
  if (tag === 'SYSTEM')           return 'text-[#c9a84c] opacity-70'
  if (tag === 'CHECK')            return 'text-[#555568]'
  if (tag === 'REDOWNLOAD')       return 'text-[#f59e0b] font-semibold'
  if (tag === 'SUMMARY')          return 'text-[#e8e4dd] font-semibold'
  if (tag === 'REPORT_READY')     return 'text-[#22c55e] font-semibold'
  if (tag === 'PRESCAN_OK')       return 'text-[#555568]'
  if (tag === 'PRESCAN_MISS')     return 'text-[#f59e0b]'
  if (tag === 'PRESCAN_SUMMARY')  return 'text-[#e8e4dd] font-semibold'
  return 'text-[#9090a8]'
}

// ── VramBar ───────────────────────────────────────────────────────────────────

function VramBar({ pct }) {
  if (pct == null) return null
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#22c55e'
  return (
    <div className="w-full bg-[#252533] rounded-full h-2 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  )
}

// ── HealthPanel ───────────────────────────────────────────────────────────────

function HealthPanel({ nodeIdx }) {
  const [health, setHealth] = useState(null)
  const [live, setLive] = useState(false)
  const esRef = useRef(null)

  useEffect(() => {
    if (nodeIdx == null || nodeIdx < 0) return
    setLive(false); setHealth(null)
    const es = new EventSource(`${API}/health-stream/${nodeIdx}`)
    esRef.current = es
    es.onopen = () => setLive(true)
    es.onmessage = e => { try { setHealth(JSON.parse(e.data)); setLive(true) } catch {} }
    es.onerror = () => setLive(false)
    return () => { es.close(); esRef.current = null; setLive(false) }
  }, [nodeIdx])

  const online = health?.online ?? false
  return (
    <div className="bg-[#0f0f18] border border-[#252533] rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {online ? <Wifi size={14} className="text-[#22c55e]" /> : <WifiOff size={14} className="text-[#ef4444]" />}
          <span className="text-sm font-medium text-[#e8e4dd]">{health?.node_name || `Nodo ${nodeIdx}`}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {live && <span className="flex items-center gap-1 text-[10px] text-[#22c55e] font-mono"><span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse inline-block" />LIVE</span>}
          <span className={clsx('text-[10px] font-mono px-2 py-0.5 rounded uppercase', online ? 'bg-[#22c55e]/15 text-[#22c55e]' : 'bg-[#ef4444]/15 text-[#ef4444]')}>{online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
      </div>
      {health?.gpu_name && <p className="text-[11px] text-[#9090a8] font-mono truncate">{health.gpu_name}</p>}
      {health?.vram_total != null && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-[#9090a8]">
            <span>VRAM</span>
            <span>{Math.round((health.vram_total - (health.vram_free || 0)) / 1024)} / {Math.round(health.vram_total / 1024)} MB <span className="text-[#555568]">({health.vram_used_pct}%)</span></span>
          </div>
          <VramBar pct={health.vram_used_pct} />
        </div>
      )}
      <div className="flex gap-4 text-[11px]">
        <div className="flex items-center gap-1.5"><span className="text-[#9090a8]">Running:</span><span className={clsx('font-mono font-bold', health?.queue_running > 0 ? 'text-[#c9a84c]' : 'text-[#555568]')}>{health?.queue_running ?? 0}</span></div>
        <div className="flex items-center gap-1.5"><span className="text-[#9090a8]">Pending:</span><span className={clsx('font-mono font-bold', health?.queue_pending > 0 ? 'text-[#f59e0b]' : 'text-[#555568]')}>{health?.queue_pending ?? 0}</span></div>
      </div>
      {nodeIdx < 0 && <p className="text-[11px] text-[#555568] text-center py-2">Seleziona un nodo per il health check</p>}
    </div>
  )
}

// ── ReportPanel ───────────────────────────────────────────────────────────────

function ReportPanel({ report }) {
  if (!report) return null
  const { downloaded = 0, skipped = 0, errors = 0, total = 0,
          start_time, end_time, models = [] } = report
  const elapsed = start_time && end_time
    ? Math.round((new Date(end_time) - new Date(start_time)) / 1000)
    : null

  return (
    <div className="mt-3 border border-[#252533] rounded-lg overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-3 py-2 bg-[#0f0f18] border-b border-[#252533]">
        <span className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider">[ REPORT ]</span>
        {elapsed != null && <span className="text-[10px] text-[#555568]">{elapsed}s totali</span>}
      </div>
      {/* Summary bar */}
      <div className="flex divide-x divide-[#252533]">
        {[
          { label: 'Scaricati', val: downloaded, color: 'text-[#22c55e]' },
          { label: 'Saltati',   val: skipped,    color: 'text-[#555568]' },
          { label: 'Errori',    val: errors,      color: 'text-[#ef4444]' },
        ].map(({ label, val, color }) => (
          <div key={label} className="flex-1 text-center py-2">
            <div className={clsx('text-base font-mono font-bold', color)}>{val}</div>
            <div className="text-[9px] text-[#555568] uppercase tracking-wider">{label}</div>
          </div>
        ))}
      </div>
      {/* Model rows */}
      {models.length > 0 && (
        <div className="max-h-40 overflow-y-auto divide-y divide-[#1a1a24]">
          {models.map((m, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1.5">
              <span className={clsx('text-[10px] w-20 shrink-0 font-mono',
                m.status === 'downloaded' ? 'text-[#22c55e]' :
                m.status === 'error'      ? 'text-[#ef4444]' : 'text-[#555568]'
              )}>
                {m.status === 'downloaded' ? '✓ ok' :
                 m.status === 'skipped'    ? '— skip' :
                 m.status === 'no_url'     ? '— no url' : '✗ err'}
              </span>
              <span className="text-[10px] text-[#9090a8] font-mono truncate flex-1">{m.filename}</span>
              {m.size_bytes > 0 && (
                <span className="text-[10px] text-[#555568] shrink-0">
                  {(m.size_bytes / 1024 / 1024).toFixed(1)} MB
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── TerminalPanel ─────────────────────────────────────────────────────────────

function TerminalPanel({ lines, pct, running, currentProgress, report, onClear }) {
  const bottomRef = useRef(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (autoScroll && bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' })
  }, [lines, autoScroll])

  function handleCopy() {
    const text = lines.map(l => l.text).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#0f0f18] border border-[#252533] rounded-t-lg shrink-0">
        <div className="flex items-center gap-2">
          <Terminal size={12} className="text-[#c9a84c]" />
          <span className="text-[10px] font-mono text-[#9090a8] uppercase tracking-widest">[ OUTPUT SSH ]</span>
          {running && <Loader2 size={10} className="text-[#c9a84c] animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setAutoScroll(v => !v)} className={clsx('text-[9px] font-mono px-1.5 py-0.5 rounded', autoScroll ? 'bg-[#c9a84c]/20 text-[#c9a84c]' : 'bg-[#252533] text-[#555568]')}>AUTO</button>
          <button onClick={handleCopy} disabled={lines.length === 0} title="Copia output" className={clsx('transition-colors disabled:opacity-30', copied ? 'text-[#22c55e]' : 'text-[#555568] hover:text-[#9090a8]')}>{copied ? <CheckCircle2 size={10} /> : <Copy size={10} />}</button>
          <button onClick={onClear} disabled={running} className="text-[#555568] hover:text-[#9090a8] disabled:opacity-30"><Trash2 size={10} /></button>
        </div>
      </div>

      {/* Progress bar globale */}
      {(running || pct > 0) && (
        <div className="px-3 py-2 bg-[#0a0a12] border-x border-[#252533] shrink-0 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#9090a8]">Totale</span>
            <span className="text-[10px] font-mono text-[#c9a84c]">{Math.round(pct * 100)}%</span>
          </div>
          <div className="w-full bg-[#252533] rounded-full h-1.5 overflow-hidden">
            <div className="h-full rounded-full bg-[#c9a84c] transition-all duration-300" style={{ width: `${pct * 100}%` }} />
          </div>
          {/* Progress aria2c / wget corrente */}
          {currentProgress && (
            <div className="flex items-center justify-between text-[10px] font-mono">
              <span className="text-[#3b82f6]">{currentProgress.dl_done} / {currentProgress.dl_total} ({currentProgress.dl_pct}%)</span>
              <span className="text-[#555568]">{currentProgress.speed} · ETA {currentProgress.eta}</span>
            </div>
          )}
        </div>
      )}

      {/* Log lines */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[11px] space-y-0.5 min-h-0 bg-[#07070d] border-x border-b border-[#252533] rounded-b-lg">
        {lines.length === 0 && <p className="text-[#555568]">_ in attesa di output...</p>}
        {lines.map((l, i) => (
          <div key={i} className={clsx('leading-relaxed whitespace-pre-wrap break-all', lineColor(l.tag))}>
            {l.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Report finale */}
      <ReportPanel report={report} />
    </div>
  )
}

// ── UrlEditor inline ──────────────────────────────────────────────────────────

function UrlEditor({ model, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(model.url || '')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await fetch(`${API}/models/url`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: model.filename, url: val.trim() || null }),
      })
      onSaved?.()
    } finally { setSaving(false); setEditing(false) }
  }

  if (!editing) return (
    <div className="flex items-center gap-1.5 min-w-0">
      {model.has_url
        ? <span className="text-[10px] text-[#22c55e] font-mono truncate max-w-[160px]" title={model.url}>URL ✓</span>
        : <span className="text-[10px] text-[#f59e0b]">URL mancante</span>}
      <button onClick={() => { setVal(model.url || ''); setEditing(true) }} className="shrink-0 text-[#555568] hover:text-[#c9a84c]"><Edit2 size={11} /></button>
    </div>
  )

  return (
    <div className="flex items-center gap-1 mt-1">
      <input value={val} onChange={e => setVal(e.target.value)} placeholder="https://..." className="flex-1 min-w-0 bg-[#0f0f18] border border-[#c9a84c]/40 rounded px-2 py-1 text-[11px] text-[#e8e4dd] font-mono outline-none" autoFocus />
      <button onClick={save} disabled={saving} className="shrink-0 text-[#22c55e] hover:opacity-80">{saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}</button>
      <button onClick={() => setEditing(false)} className="shrink-0 text-[#555568] hover:text-[#ef4444]"><XIcon size={12} /></button>
    </div>
  )
}

// ── ModelManifest ─────────────────────────────────────────────────────────────

function ModelManifest({ models, categories, selectedIds, onToggle, onSelectAll, onSelectRequired, onSelectNone, onRefresh }) {
  const byCategory = {}
  for (const m of models) {
    if (!byCategory[m.category]) byCategory[m.category] = []
    byCategory[m.category].push(m)
  }
  const totalGB = totalSize(models, selectedIds)
  const noUrl = models.filter(m => !m.has_url).length

  return (
    <div className="flex-1 flex flex-col overflow-hidden border-r border-[#252533] min-w-0">
      <div className="px-4 py-3 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xs font-mono uppercase tracking-wider text-[#555568]">Modelli dai Workflow</h2>
          <span className="text-[11px] text-[#9090a8]">{selectedIds.size} sel. — <span className="text-[#c9a84c] font-mono">{fmtGB(totalGB)}</span></span>
        </div>
        {noUrl > 0 && (
          <div className="flex items-center gap-1.5 text-[10px] text-[#f59e0b] mb-2">
            <AlertTriangle size={11} />
            {noUrl} modelli senza URL — clicca <Edit2 size={10} className="inline" /> per aggiungerlo
          </div>
        )}
        <div className="flex gap-2">
          {[['Tutti', onSelectAll], ['Required', onSelectRequired], ['Nessuno', onSelectNone]].map(([l, fn]) => (
            <button key={l} onClick={fn} className="text-[10px] px-2 py-1 bg-[#16161f] hover:bg-[#1e1e2a] border border-[#252533] rounded text-[#9090a8] hover:text-[#e8e4dd] transition-colors">{l}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-5 min-h-0">
        {Object.entries(byCategory).map(([cat, catModels]) => (
          <div key={cat}>
            <div className="flex items-center gap-2 mb-2">
              <CatBadge cat={categories[cat]?.color || 'text2'} label={categories[cat]?.label || cat} />
              <span className="text-[10px] text-[#555568]">({catModels.length})</span>
            </div>
            <div className="space-y-1.5">
              {catModels.map(m => {
                const checked = selectedIds.has(m.id)
                return (
                  <div key={m.id} className={clsx('rounded-lg border transition-colors', checked ? 'bg-[#c9a84c]/8 border-[#c9a84c]/30' : 'bg-[#0f0f18] border-[#252533]')}>
                    <div className="flex items-start gap-3 p-3" onClick={() => onToggle(m.id)} style={{ cursor: 'pointer' }}>
                      <div className="mt-0.5 shrink-0">
                        {checked ? <CheckSquare size={14} className="text-[#c9a84c]" /> : <Square size={14} className="text-[#555568]" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-medium text-[#e8e4dd] truncate">{m.name}</span>
                          {m.size_gb && <span className="text-[10px] text-[#c9a84c] shrink-0">{fmtGB(m.size_gb)}</span>}
                          {!m.has_url && <span className="text-[9px] px-1.5 py-0.5 bg-[#f59e0b]/20 text-[#f59e0b] rounded uppercase shrink-0">No URL</span>}
                        </div>
                        <p className="text-[10px] text-[#555568] font-mono mt-0.5 truncate">{m.filename}</p>
                        {/* Workflow che lo usano */}
                        <div className="flex flex-wrap gap-1 mt-1">
                          {m.workflows.map(wf => (
                            <span key={wf} className="text-[9px] px-1 py-0.5 rounded bg-[#252533] text-[#555568] font-mono">
                              {wf.replace('.json', '')}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    {/* URL editor — sempre visibile in fondo alla card */}
                    <div className="px-3 pb-2 -mt-1" onClick={e => e.stopPropagation()}>
                      <UrlEditor model={m} onSaved={onRefresh} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function ProvisioningScreen() {
  const [mode, setMode] = useState('ssh')  // 'ssh' | 'local'

  // SSH
  const [host, setHost] = useState('')
  const [sshPort, setSshPort] = useState(22)
  const [user, setUser] = useState('root')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [comfyuiPath, setComfyuiPath] = useState('')
  const [allNodes, setAllNodes] = useState([])
  const [remoteNodes, setRemoteNodes] = useState([])
  const [selectedNodeIdx, setSelectedNodeIdx] = useState(-1)
  const [sshStatus, setSshStatus] = useState(null)
  const [findStatus, setFindStatus] = useState(null)
  const [testingSSH, setTestingSSH] = useState(false)
  const [findingComfyUI, setFindingComfyUI] = useState(false)

  // Local
  const [findingLocal, setFindingLocal] = useState(false)

  // Models
  const [manifest, setManifest] = useState({ categories: {}, models: [] })
  const [selectedIds, setSelectedIds] = useState(new Set())

  // Auto-save SSH config
  const [saveStatus, setSaveStatus] = useState(null)  // null | 'saving' | 'saved' | 'error'
  const autoSaveTimer = useRef(null)

  // Terminal + running state — persistito nello store cross-navigazione
  const {
    termLines, termPct, running, currentProgress, report, activeMode,
    localPath, setLocalPath,
    startStream, clearOutput,
  } = useProvisioningStore()

  // ── Auto-save SSH config con debounce 800ms ──────────────────────────────
  const doSaveSSH = useCallback(async (nodeIdx, fields) => {
    if (nodeIdx < 0) return
    setSaveStatus('saving')
    try {
      const r = await fetch(`${API}/save-ssh-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          global_idx:        nodeIdx,
          provisioning_enabled: true,
          ssh_port:          Number(fields.sshPort) || 22,
          ssh_user:          fields.user || 'root',
          ssh_password:      fields.password || null,
          ssh_private_key:   fields.privateKey || null,
          ssh_comfyui_path:  fields.comfyuiPath || null,
        }),
      })
      const d = await r.json()
      setSaveStatus(d.ok ? 'saved' : 'error')
    } catch {
      setSaveStatus('error')
    }
    setTimeout(() => setSaveStatus(null), 2500)
  }, [])

  // Debounce: ogni volta che cambiano i campi SSH, aspetta 800ms poi salva
  useEffect(() => {
    if (selectedNodeIdx < 0) return
    clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      doSaveSSH(selectedNodeIdx, { sshPort, user, password, privateKey, comfyuiPath })
    }, 800)
    return () => clearTimeout(autoSaveTimer.current)
  }, [sshPort, user, password, privateKey, comfyuiPath, selectedNodeIdx])

  function loadManifest() {
    fetch(`${API}/models`)
      .then(r => r.json())
      .then(data => {
        setManifest(data)
        const all = new Set((data.models || []).map(m => m.id))
        setSelectedIds(all)
      })
      .catch(console.error)
  }

  useEffect(() => {
    loadManifest()

    fetch(`${API}/nodes`)
      .then(r => r.json())
      .then(list => {
        const all = Array.isArray(list) ? list : []
        setAllNodes(all); setRemoteNodes(all)
        const first = all.find(n => n.provisioning_enabled) || all[0]
        if (first) {
          setSelectedNodeIdx(first.global_idx)
          setHost(first.host || '')
          setSshPort(first.ssh_port || 22)
          setUser(first.ssh_user || 'root')
          setPassword(first.ssh_password || '')
          setPrivateKey(first.ssh_private_key || '')
          setComfyuiPath(first.ssh_comfyui_path || '')
        }
      })
      .catch(() => { setAllNodes([]); setRemoteNodes([]) })

    // Prova a trovare ComfyUI locale solo se il path non è già salvato
    if (!localPath) {
      fetch(`${API}/find-local-comfyui`)
        .then(r => r.json())
        .then(d => { if (d.found && d.path) setLocalPath(d.path) })
        .catch(() => {})
    }
  }, [])

  const sshCredentials = () => ({
    host, port: Number(sshPort), user,
    password: password || null, private_key: privateKey || null,
  })

  async function handleTestSSH() {
    if (!host || !user) return
    setTestingSSH(true); setSshStatus(null)
    try {
      const r = await fetch(`${API}/test-ssh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sshCredentials()) })
      setSshStatus(await r.json())
    } catch (e) { setSshStatus({ ok: false, error: String(e) }) }
    finally { setTestingSSH(false) }
  }

  async function handleFindComfyUI() {
    if (!host || !user) return
    setFindingComfyUI(true); setFindStatus(null)
    try {
      const r = await fetch(`${API}/find-comfyui`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sshCredentials()) })
      const data = await r.json()
      setFindStatus(data)
      if (data.found && data.path) setComfyuiPath(data.path)
    } catch (e) { setFindStatus({ found: false, error: String(e) }) }
    finally { setFindingComfyUI(false) }
  }

  async function handleFindLocal() {
    setFindingLocal(true)
    try {
      const r = await fetch(`${API}/find-local-comfyui`)
      const d = await r.json()
      if (d.found && d.path) setLocalPath(d.path)
      else alert('ComfyUI non trovato automaticamente — inserisci il path manualmente')
    } catch {} finally { setFindingLocal(false) }
  }

  const canSSH   = sshStatus?.ok && host && user && comfyuiPath && selectedIds.size > 0 && !running
  const canLocal = localPath && selectedIds.size > 0 && !running

  const totalGB = totalSize(manifest.models || [], selectedIds)

  return (
    <div className="h-full flex flex-col bg-[#07070d] text-[#e8e4dd] overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-[#252533] bg-[#0f0f18] shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Server size={20} className="text-[#c9a84c]" />
            <div>
              <h1 className="font-['Playfair_Display'] text-lg font-semibold text-[#c9a84c]">Provisioning Nodi</h1>
              <p className="text-xs text-[#9090a8]">Installa modelli ComfyUI dai workflow attivi</p>
            </div>
          </div>
          {/* Mode tabs */}
          <div className="flex gap-1 p-1 bg-[#16161f] rounded-lg border border-[#252533]">
            {[['ssh', Terminal, 'SSH Remoto'], ['local', HardDrive, 'Locale']].map(([m, Icon, label]) => (
              <button key={m} onClick={() => setMode(m)} className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors', mode === m ? 'bg-[#c9a84c] text-[#07070d] font-medium' : 'text-[#9090a8] hover:text-[#e8e4dd]')}>
                <Icon size={13} />{label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden min-h-0 relative">

        {/* ── Col 1: Config (280px) ── */}
        <div className="w-[280px] shrink-0 border-r border-[#252533] flex flex-col overflow-y-auto">
          <div className="p-4 space-y-4">

            {mode === 'ssh' ? (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-mono uppercase tracking-wider text-[#555568]">SSH Config</h2>
                  {saveStatus === 'saving' && (
                    <span className="flex items-center gap-1 text-[10px] text-[#555568]">
                      <Loader2 size={10} className="animate-spin" /> salvataggio...
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="flex items-center gap-1 text-[10px] text-[#22c55e]">
                      <CheckCircle2 size={10} /> salvato
                    </span>
                  )}
                  {saveStatus === 'error' && (
                    <span className="text-[10px] text-[#ef4444]">errore salvataggio</span>
                  )}
                </div>

                {/* Node selector */}
                <div>
                  <label className="block text-[11px] text-[#9090a8] mb-1">
                    Nodo target
                    {remoteNodes.length === 0 && <span className="ml-1 text-[#f59e0b]">— abilita SSH in Nodi</span>}
                  </label>
                  <select
                    value={selectedNodeIdx}
                    onChange={e => {
                      const gi = Number(e.target.value); setSelectedNodeIdx(gi)
                      setSshStatus(null); setFindStatus(null); setComfyuiPath('')
                      const n = remoteNodes.find(x => x.global_idx === gi)
                      if (n) {
                        setHost(n.host || '')
                        setSshPort(n.ssh_port || 22)
                        setUser(n.ssh_user || '')
                        setPassword(n.ssh_password || '')
                        setPrivateKey(n.ssh_private_key || '')
                        setComfyuiPath(n.ssh_comfyui_path || '')
                      }
                    }}
                    className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] focus:border-[#c9a84c] outline-none"
                  >
                    <option value={-1}>— seleziona —</option>
                    {remoteNodes.map(n => <option key={n.global_idx} value={n.global_idx}>{n.name} — {n.host}{n.provisioning_enabled ? ' ✓' : ''}</option>)}
                  </select>
                  {selectedNodeIdx >= 0 && !remoteNodes.find(n => n.global_idx === selectedNodeIdx)?.provisioning_enabled && (
                    <p className="text-[10px] text-[#f59e0b] mt-1">Configura SSH in Nodi ComfyUI per pre-compilare</p>
                  )}
                </div>

                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] text-[#9090a8] mb-1">Host / IP</label>
                    <input value={host} onChange={e => setHost(e.target.value)} placeholder="192.168.1.100" className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none" />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1"><label className="block text-[11px] text-[#9090a8] mb-1">Porta SSH</label><input type="number" value={sshPort} onChange={e => setSshPort(e.target.value)} className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] focus:border-[#c9a84c] outline-none" /></div>
                    <div className="flex-1"><label className="block text-[11px] text-[#9090a8] mb-1">Utente</label><input value={user} onChange={e => setUser(e.target.value)} placeholder="root" className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none" /></div>
                  </div>
                  <div><label className="block text-[11px] text-[#9090a8] mb-1">Password</label><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="lascia vuoto per chiave" className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none" /></div>
                  <div>
                    <label className="block text-[11px] text-[#9090a8] mb-1">Chiave privata SSH (PEM)</label>
                    <textarea value={privateKey} onChange={e => setPrivateKey(e.target.value)} rows={4} spellCheck={false} placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"} className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none font-mono resize-none leading-relaxed" />
                  </div>
                </div>

                <div className="flex gap-2">
                  <button onClick={handleTestSSH} disabled={!host || !user || testingSSH} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-[#16161f] hover:bg-[#1e1e2a] border border-[#252533] hover:border-[#c9a84c]/40 rounded text-xs text-[#e8e4dd] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                    {testingSSH ? <Loader2 size={12} className="animate-spin" /> : <Wifi size={12} />} Test SSH
                  </button>
                  <button onClick={handleFindComfyUI} disabled={!host || !user || findingComfyUI} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-[#16161f] hover:bg-[#1e1e2a] border border-[#252533] hover:border-[#c9a84c]/40 rounded text-xs text-[#e8e4dd] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                    {findingComfyUI ? <Loader2 size={12} className="animate-spin" /> : <FolderSearch size={12} />} Trova
                  </button>
                </div>

                {sshStatus && (
                  <div className={clsx('flex items-center gap-2 px-3 py-2 rounded text-xs border', sshStatus.ok ? 'bg-[#22c55e]/10 border-[#22c55e]/30 text-[#22c55e]' : 'bg-[#ef4444]/10 border-[#ef4444]/30 text-[#ef4444]')}>
                    {sshStatus.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                    <span className="truncate">{sshStatus.ok ? `Connesso — ${sshStatus.latency_ms}ms` : (sshStatus.error || 'Fallito')}</span>
                  </div>
                )}

                {findStatus && (
                  <div className={clsx('px-3 py-2 rounded text-xs border space-y-1', findStatus.found ? 'bg-[#22c55e]/10 border-[#22c55e]/30' : 'bg-[#ef4444]/10 border-[#ef4444]/30')}>
                    <div className="flex items-center gap-2">
                      {findStatus.found ? <CheckCircle2 size={12} className="text-[#22c55e] shrink-0" /> : <XCircle size={12} className="text-[#ef4444] shrink-0" />}
                      <span className={findStatus.found ? 'text-[#22c55e]' : 'text-[#ef4444]'}>{findStatus.found ? 'Trovato' : (findStatus.error || 'Non trovato')}</span>
                    </div>
                    {findStatus.found && findStatus.candidates?.length > 1 && findStatus.candidates.slice(0, 3).map((c, i) => (
                      <button key={i} onClick={() => setComfyuiPath(c)} className="block w-full text-left text-[10px] text-[#9090a8] hover:text-[#c9a84c] truncate font-mono pl-4">{c}</button>
                    ))}
                  </div>
                )}

                <div><label className="block text-[11px] text-[#9090a8] mb-1">Path ComfyUI remoto</label><input value={comfyuiPath} onChange={e => setComfyuiPath(e.target.value)} placeholder="/workspace/ComfyUI" className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none font-mono" /></div>
              </>
            ) : (
              <>
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#555568]">Provisioning Locale</h2>
                <p className="text-[11px] text-[#9090a8] leading-relaxed">Scarica modelli direttamente nella cartella ComfyUI locale senza SSH.</p>
                <div>
                  <label className="block text-[11px] text-[#9090a8] mb-1">Path ComfyUI locale</label>
                  <input value={localPath} onChange={e => setLocalPath(e.target.value)} placeholder="C:\ComfyUI" className="w-full bg-[#16161f] border border-[#252533] rounded px-2 py-1.5 text-xs text-[#e8e4dd] placeholder-[#555568] focus:border-[#c9a84c] outline-none font-mono" />
                </div>
                <button onClick={handleFindLocal} disabled={findingLocal} className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-[#16161f] hover:bg-[#1e1e2a] border border-[#252533] hover:border-[#c9a84c]/40 rounded text-xs text-[#e8e4dd] disabled:opacity-50 transition-colors">
                  {findingLocal ? <Loader2 size={12} className="animate-spin" /> : <FolderSearch size={12} />} Rileva automaticamente
                </button>
                {localPath && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded text-xs bg-[#22c55e]/10 border border-[#22c55e]/30 text-[#22c55e]">
                    <CheckCircle2 size={12} />
                    <span className="truncate font-mono">{localPath}</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ── Col 2: Model Manifest ── */}
        <ModelManifest
          models={manifest.models || []}
          categories={manifest.categories || {}}
          selectedIds={selectedIds}
          onToggle={id => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })}
          onSelectAll={() => setSelectedIds(new Set((manifest.models || []).map(m => m.id)))}
          onSelectRequired={() => setSelectedIds(new Set((manifest.models || []).filter(m => m.has_url).map(m => m.id)))}
          onSelectNone={() => setSelectedIds(new Set())}
          onRefresh={loadManifest}
        />

        {/* Banner provisioning in corso su altro modo */}
        {running && activeMode && activeMode !== mode && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-4 py-2 bg-[#c9a84c]/20 border border-[#c9a84c]/40 rounded-lg text-xs text-[#c9a84c] font-mono shadow-lg">
            <Loader2 size={11} className="animate-spin shrink-0" />
            Provisioning {activeMode === 'ssh' ? 'SSH' : 'locale'} in corso in background — vai alla tab {activeMode === 'ssh' ? 'SSH Remoto' : 'Locale'} per vedere il log
          </div>
        )}

        {/* ── Col 3: Health + Terminal (360px) ── */}
        <div className="w-[360px] shrink-0 flex flex-col overflow-hidden">
          <div className="h-[40%] p-4 border-b border-[#252533] overflow-y-auto shrink-0">
            <h2 className="text-xs font-mono uppercase tracking-wider text-[#555568] mb-3">
              {mode === 'ssh' ? 'Health Monitor' : 'ComfyUI Locale'}
            </h2>
            {mode === 'ssh'
              ? <HealthPanel nodeIdx={selectedNodeIdx} />
              : (
                <div className="bg-[#0f0f18] border border-[#252533] rounded-lg p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <HardDrive size={14} className="text-[#c9a84c]" />
                    <span className="text-sm text-[#e8e4dd]">Provisioning Locale</span>
                  </div>
                  <p className="text-[11px] text-[#9090a8]">I file vengono scaricati direttamente nelle sottocartelle <code className="text-[#c9a84c]">models/</code> di ComfyUI usando httpx.</p>
                  {localPath && <p className="text-[10px] font-mono text-[#555568] break-all">{localPath}</p>}
                </div>
              )
            }
          </div>

          <div className="flex-1 p-4 overflow-hidden flex flex-col min-h-0">
            {/* CTA */}
            <div className="mb-3 shrink-0">
              {mode === 'ssh' ? (
                <button onClick={() => startStream(`${API}/start`, { ...sshCredentials(), comfyui_path: comfyuiPath, model_ids: [...selectedIds] }, 'ssh')} disabled={!canSSH} className={clsx('w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors', canSSH ? 'bg-[#22c55e] hover:bg-[#16a34a] text-white' : 'bg-[#16161f] border border-[#252533] text-[#555568] cursor-not-allowed')}>
                  {running && activeMode === 'ssh' ? <><Loader2 size={14} className="animate-spin" />SSH in corso...</> : <><Download size={14} />SSH — {selectedIds.size} modelli ({fmtGB(totalGB)})</>}
                </button>
              ) : (
                <button onClick={() => startStream(`${API}/start-local`, { comfyui_path: localPath, model_ids: [...selectedIds] }, 'local')} disabled={!canLocal} className={clsx('w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors', canLocal ? 'bg-[#3b82f6] hover:bg-[#2563eb] text-white' : 'bg-[#16161f] border border-[#252533] text-[#555568] cursor-not-allowed')}>
                  {running && activeMode === 'local' ? <><Loader2 size={14} className="animate-spin" />Download in corso...</> : <><HardDrive size={14} />Locale — {selectedIds.size} modelli ({fmtGB(totalGB)})</>}
                </button>
              )}
              {mode === 'ssh' && !sshStatus?.ok && <p className="text-[10px] text-[#555568] text-center mt-1">Testa SSH prima di procedere</p>}
              {mode === 'local' && !localPath && <p className="text-[10px] text-[#555568] text-center mt-1">Specifica il path ComfyUI locale</p>}
            </div>

            <div className="flex-1 min-h-0">
              <TerminalPanel
                lines={termLines}
                pct={termPct}
                running={running}
                currentProgress={currentProgress}
                report={report}
                onClear={clearOutput}
              />
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
