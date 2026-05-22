/**
 * WorkflowsScreen — visual editor per workflow ComfyUI.
 * Left: lista workflow · Right: editor visuale nodi / editor JSON / metadati inject
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Workflow, Plus, Save, Trash2, ChevronDown, ChevronUp,
  Eye, Code2, Settings2, Copy, AlertCircle, CheckCircle,
  Loader2, X, FileJson, RotateCcw, Download, Cpu, ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'
import { BACKEND_ORIGIN } from '../utils/apiClient'

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W   = 220
const HDR_H    = 36
const ROW_H    = 26
const PAD_B    = 10
const MIN_CANVAS_W = 3200
const MIN_CANVAS_H = 2400

const WORKFLOW_TYPES = [
  { value: 'txt2img',              label: 'Text → Image' },
  { value: 'txt2video',            label: 'Text → Video' },
  { value: 'img2video',            label: 'Image → Video' },
  { value: 'img2video_lastframe',  label: 'Image → Video + Last Frame' },
  { value: 'img_audio2video',      label: 'Image+Audio → Video' },
  { value: 'director',             label: 'Director' },
]

const INJECT_PARAMS = [
  'prompt', 'negative_prompt', 'width', 'height', 'seed',
  'first_image', 'last_image', 'audio', 'duration_sec', 'duration_frames',
  'fps', 'audio_start_sec', 'local_prompts', 'segment_lengths', 'timeline_data',
]

// Node colour by class_type category
function nodeColor(classType) {
  if (!classType) return '#1a1a28'
  const ct = classType.toLowerCase()
  if (ct.includes('loader') || ct.includes('load'))       return '#1a2840'
  if (ct.includes('sampler') || ct.includes('guider'))    return '#281a10'
  if (ct.includes('encode') || ct.includes('clip'))       return '#221428'
  if (ct.includes('decode') || ct.includes('vae'))        return '#122814'
  if (ct.includes('save') || ct.includes('create') || ct.includes('output')) return '#281414'
  if (ct.includes('primitive') || ct.includes('math') || ct.includes('expression')) return '#1e1e28'
  if (ct.includes('ltxv') || ct.includes('ltx'))         return '#122828'
  if (ct.includes('resize') || ct.includes('image'))     return '#28281a'
  if (ct.includes('noise') || ct.includes('sigma'))      return '#202028'
  return '#1a1a28'
}

function nodeAccent(classType) {
  if (!classType) return '#555'
  const ct = classType.toLowerCase()
  if (ct.includes('loader') || ct.includes('load'))       return '#3b82f6'
  if (ct.includes('sampler') || ct.includes('guider'))    return '#f59e0b'
  if (ct.includes('encode') || ct.includes('clip'))       return '#a78bfa'
  if (ct.includes('decode') || ct.includes('vae'))        return '#34d399'
  if (ct.includes('save') || ct.includes('create'))       return '#f87171'
  if (ct.includes('primitive') || ct.includes('math'))    return '#9090a8'
  if (ct.includes('ltxv') || ct.includes('ltx'))         return '#22d3ee'
  if (ct.includes('resize') || ct.includes('image'))     return '#fbbf24'
  return '#9090a8'
}

// ── Graph utilities ───────────────────────────────────────────────────────────

function isRef(val) {
  return Array.isArray(val) && val.length === 2 &&
    (typeof val[0] === 'string' || typeof val[0] === 'number')
}

function buildGraph(wf) {
  const nodes = {}
  const edges = [] // { source, target, inputKey, inputIdx, outputSlot }

  Object.entries(wf).forEach(([id, node]) => {
    const inputs = node.inputs || {}
    const inputKeys = Object.keys(inputs).filter(k => !isRef(inputs[k]))
    nodes[id] = {
      id,
      classType:  node.class_type || '',
      title:      node._meta?.title || node.class_type || id,
      inputs,
      editableKeys: inputKeys,
    }
  })

  Object.entries(wf).forEach(([id, node]) => {
    Object.entries(node.inputs || {}).forEach(([key, val], inputIdx) => {
      if (isRef(val)) {
        const sourceId = String(val[0])
        if (sourceId in nodes) {
          edges.push({ source: sourceId, target: id, inputKey: key, inputIdx, outputSlot: val[1] })
        }
      }
    })
  })

  return { nodes, edges }
}

function autoLayout(wf) {
  const { nodes, edges } = buildGraph(wf)
  const ids = Object.keys(nodes)

  const depth = Object.fromEntries(ids.map(id => [id, 0]))
  const dependents = Object.fromEntries(ids.map(id => [id, []]))
  const inDeg = Object.fromEntries(ids.map(id => [id, 0]))

  edges.forEach(e => {
    dependents[e.source].push(e.target)
    inDeg[e.target]++
  })

  const queue = ids.filter(id => inDeg[id] === 0)
  const visited = new Set(queue)

  while (queue.length) {
    const curr = queue.shift()
    dependents[curr].forEach(next => {
      depth[next] = Math.max(depth[next], depth[curr] + 1)
      if (!visited.has(next)) { visited.add(next); queue.push(next) }
    })
  }

  const cols = {}
  ids.forEach(id => {
    const d = depth[id]
    if (!cols[d]) cols[d] = []
    cols[d].push(id)
  })

  const positions = {}
  Object.keys(cols).sort((a, b) => +a - +b).forEach(d => {
    const col = cols[d]
    const x = +d * (NODE_W + 80) + 40
    let y = 40
    col.forEach(id => {
      positions[id] = { x, y }
      const editCount = nodes[id].editableKeys.length
      const h = HDR_H + editCount * ROW_H + PAD_B
      y += Math.max(h, 80) + 24
    })
  })

  return positions
}

// ── Node Canvas ───────────────────────────────────────────────────────────────

function NodeCanvas({ wf, selectedId, onSelect, positions, onPositionChange }) {
  const { nodes, edges } = buildGraph(wf)
  const containerRef = useRef(null)
  const dragRef = useRef(null)

  const canvasW = Math.max(MIN_CANVAS_W, ...Object.values(positions).map(p => p.x + NODE_W + 200))
  const canvasH = Math.max(MIN_CANVAS_H, ...Object.values(positions).map(p => {
    const n = nodes[p ? Object.keys(positions).find(k => positions[k] === p) : '']
    return p.y + 300
  }))

  function nodeH(id) {
    const n = nodes[id]
    if (!n) return 80
    return HDR_H + n.editableKeys.length * ROW_H + PAD_B
  }

  function portOut(id) {
    const p = positions[id] || { x: 0, y: 0 }
    return { x: p.x + NODE_W, y: p.y + HDR_H / 2 }
  }

  function portIn(id, inputKey) {
    const p = positions[id] || { x: 0, y: 0 }
    const n = nodes[id]
    if (!n) return { x: p.x, y: p.y + HDR_H / 2 }
    const allKeys = Object.keys(n.inputs)
    const idx = allKeys.indexOf(inputKey)
    return { x: p.x, y: p.y + HDR_H + idx * ROW_H + ROW_H / 2 }
  }

  function bezier(sx, sy, tx, ty) {
    const cx = (tx - sx) * 0.5
    return `M${sx},${sy} C${sx + cx},${sy} ${tx - cx},${ty} ${tx},${ty}`
  }

  // Drag handling
  function onMouseDown(e, id) {
    e.stopPropagation()
    const rect = containerRef.current.getBoundingClientRect()
    const scrollLeft = containerRef.current.scrollLeft
    const scrollTop  = containerRef.current.scrollTop
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      origX:  positions[id]?.x || 0,
      origY:  positions[id]?.y || 0,
    }
    onSelect(id)

    function onMove(me) {
      if (!dragRef.current) return
      const dx = me.clientX - dragRef.current.startX
      const dy = me.clientY - dragRef.current.startY
      onPositionChange(dragRef.current.id, {
        x: Math.max(0, dragRef.current.origX + dx),
        y: Math.max(0, dragRef.current.origY + dy),
      })
    }
    function onUp() {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-auto bg-[#07070d] relative select-none"
         onClick={() => onSelect(null)}>
      <div style={{ width: canvasW, height: canvasH, position: 'relative' }}>
        {/* SVG connections layer */}
        <svg
          style={{ position: 'absolute', top: 0, left: 0, width: canvasW, height: canvasH, pointerEvents: 'none', zIndex: 1 }}
        >
          <defs>
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#555" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const src = portOut(e.source)
            const tgt = portIn(e.target, e.inputKey)
            const color = nodeAccent(nodes[e.source]?.classType)
            return (
              <path
                key={i}
                d={bezier(src.x, src.y, tgt.x, tgt.y)}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeOpacity={0.6}
              />
            )
          })}
        </svg>

        {/* Node cards */}
        {Object.values(nodes).map(node => {
          const pos = positions[node.id] || { x: 40, y: 40 }
          const isSelected = selectedId === node.id
          const accent = nodeAccent(node.classType)
          const bg = nodeColor(node.classType)
          const allInputKeys = Object.keys(node.inputs)

          return (
            <div
              key={node.id}
              style={{
                position: 'absolute',
                left: pos.x,
                top: pos.y,
                width: NODE_W,
                zIndex: isSelected ? 10 : 2,
                boxShadow: isSelected ? `0 0 0 2px ${accent}` : '0 2px 8px rgba(0,0,0,0.5)',
              }}
              className="rounded-lg overflow-hidden cursor-grab active:cursor-grabbing"
              onMouseDown={e => onMouseDown(e, node.id)}
              onClick={e => { e.stopPropagation(); onSelect(node.id) }}
            >
              {/* Header */}
              <div
                className="px-2.5 flex items-center gap-1.5"
                style={{ height: HDR_H, background: bg, borderBottom: `2px solid ${accent}` }}
              >
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
                <span className="text-[10px] font-semibold text-white truncate flex-1">{node.title}</span>
                <span className="text-[8px] text-gray-500 font-mono shrink-0">{node.id}</span>
              </div>

              {/* Input rows */}
              <div style={{ background: '#0f0f1a' }}>
                {allInputKeys.map((key, ki) => {
                  const val = node.inputs[key]
                  const isConn = isRef(val)
                  return (
                    <div
                      key={key}
                      style={{ height: ROW_H }}
                      className={clsx(
                        'flex items-center px-2.5 gap-1.5 border-b border-[#1a1a28]',
                        isConn ? 'opacity-60' : ''
                      )}
                    >
                      {/* Input port dot */}
                      <div className={clsx(
                        'w-2 h-2 rounded-full shrink-0 -ml-0.5',
                        isConn ? 'border border-gray-500' : 'bg-[#252535]'
                      )} />
                      <span className="text-[9px] text-gray-400 truncate w-16 shrink-0 font-mono">{key}</span>
                      {isConn ? (
                        <span className="text-[9px] text-gray-600 font-mono truncate">← {val[0]}</span>
                      ) : (
                        <span className="text-[9px] text-gray-300 truncate flex-1 font-mono">
                          {typeof val === 'boolean' ? String(val) :
                           typeof val === 'string'  ? `"${val.slice(0, 20)}${val.length > 20 ? '…' : ''}"` :
                           String(val)}
                        </span>
                      )}
                    </div>
                  )
                })}
                {/* Output port row */}
                <div style={{ height: PAD_B + 8 }}
                     className="flex items-center justify-end pr-1.5">
                  <div className="w-2 h-2 rounded-full border" style={{ borderColor: accent }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Node Inspector (right sidebar) ────────────────────────────────────────────

function NodeInspector({ nodeId, wf, onChange }) {
  if (!nodeId || !wf[nodeId]) return null
  const node = wf[nodeId]
  const inputs = node.inputs || {}
  const title  = node._meta?.title || node.class_type || nodeId

  function updateField(key, raw) {
    const prev = inputs[key]
    let val = raw
    if (typeof prev === 'number') {
      const n = Number(raw)
      val = isNaN(n) ? prev : n
    } else if (typeof prev === 'boolean') {
      val = raw === 'true' || raw === true
    }
    onChange(nodeId, key, val)
  }

  const editableEntries = Object.entries(inputs).filter(([, v]) => !isRef(v))
  const connectedEntries = Object.entries(inputs).filter(([, v]) => isRef(v))

  return (
    <div className="w-64 border-l border-[#252533] bg-[#0f0f18] flex flex-col overflow-hidden shrink-0">
      <div className="px-3 py-2.5 border-b border-[#252533]">
        <p className="text-[10px] text-[var(--text3)] font-mono">{node.class_type}</p>
        <p className="text-xs font-semibold text-[var(--text)] truncate">{title}</p>
        <p className="text-[9px] text-[var(--text3)] font-mono mt-0.5">ID: {nodeId}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {editableEntries.length === 0 && (
          <p className="text-[10px] text-[var(--text3)] p-2 text-center">Tutti gli input sono connessi</p>
        )}

        {editableEntries.map(([key, val]) => (
          <div key={key} className="rounded border border-[#252533] bg-[#16161f] overflow-hidden">
            <div className="px-2 py-1 bg-[#1e1e2a]">
              <span className="text-[9px] font-mono text-[var(--text3)]">{key}</span>
            </div>
            <div className="px-2 py-1.5">
              {typeof val === 'boolean' ? (
                <select
                  value={String(val)}
                  onChange={e => updateField(key, e.target.value === 'true')}
                  className="w-full text-[10px] bg-[#252533] text-[var(--text)] rounded px-1.5 py-1 border border-[#32324a]"
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : typeof val === 'number' ? (
                <input
                  type="number"
                  value={val}
                  onChange={e => updateField(key, e.target.value)}
                  step={Number.isInteger(val) ? 1 : 0.01}
                  className="w-full text-[10px] bg-[#252533] text-[var(--text)] rounded px-1.5 py-1 border border-[#32324a] font-mono"
                />
              ) : typeof val === 'string' && val.length > 60 ? (
                <textarea
                  value={val}
                  onChange={e => updateField(key, e.target.value)}
                  rows={4}
                  className="w-full text-[10px] bg-[#252533] text-[var(--text)] rounded px-1.5 py-1 border border-[#32324a] font-mono resize-y"
                />
              ) : (
                <input
                  type="text"
                  value={String(val)}
                  onChange={e => updateField(key, e.target.value)}
                  className="w-full text-[10px] bg-[#252533] text-[var(--text)] rounded px-1.5 py-1 border border-[#32324a] font-mono"
                />
              )}
            </div>
          </div>
        ))}

        {connectedEntries.length > 0 && (
          <div className="mt-2">
            <p className="text-[9px] text-[var(--text3)] uppercase tracking-wider mb-1 px-1">Connessioni (read-only)</p>
            {connectedEntries.map(([key, val]) => (
              <div key={key} className="flex items-center gap-1.5 px-2 py-1 text-[9px] font-mono text-[var(--text3)]">
                <span className="text-[var(--text3)] w-20 truncate">{key}</span>
                <span>←</span>
                <span className="text-[#3b82f6]">{val[0]}[{val[1]}]</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Inject Mapping Editor ─────────────────────────────────────────────────────

function InjectEditor({ inject, onChange }) {
  return (
    <div className="p-4 space-y-3">
      <div>
        <p className="text-xs text-[var(--text)] font-semibold mb-1">Mapping parametri pipeline → nodi</p>
        <p className="text-[10px] text-[var(--text3)] mb-3">
          Specifica quale nodo/campo riceve ogni parametro quando la pipeline esegue il workflow.
        </p>
      </div>
      <div className="space-y-2">
        {INJECT_PARAMS.map(param => {
          const mapping = inject[param] || {}
          return (
            <div key={param} className="grid grid-cols-[120px_1fr_1fr] gap-2 items-center">
              <span className="text-[10px] font-mono text-[var(--gold)]">{param}</span>
              <input
                placeholder="Node ID"
                value={mapping.node || ''}
                onChange={e => onChange({ ...inject, [param]: { ...mapping, node: e.target.value } })}
                className="text-[10px] bg-[#16161f] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono"
              />
              <input
                placeholder="Field"
                value={mapping.field || ''}
                onChange={e => onChange({ ...inject, [param]: { ...mapping, field: e.target.value } })}
                className="text-[10px] bg-[#16161f] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}


const LS_OVERRIDES_KEY = (wfId) => `cinematic_model_overrides_${wfId}`

// ── Models & LoRA Tab ─────────────────────────────────────────────────────────

function ModelsLoraTab({ workflowId }) {
  const [nodeModels, setNodeModels]     = useState(null)
  const [wfNodes, setWfNodes]           = useState(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState(null)
  const [saved, setSaved]               = useState(false)

  // Overrides: { checkpoint?, video_model?, loras?: [{lora_name, strength_model, strength_clip}] }
  const [overrides, setOverrides] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY(workflowId)) || 'null') || {} }
    catch { return {} }
  })

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_OVERRIDES_KEY(workflowId)) || 'null') || {}
      setOverrides(stored)
    } catch { setOverrides({}) }
    setSaved(false)
  }, [workflowId])

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      setError(null)
      try {
        const [mRes, nRes] = await Promise.all([
          fetch(`${BACKEND_ORIGIN}/api/comfyui/nodes/0/models`).then(r => r.json()),
          fetch(`${BACKEND_ORIGIN}/api/comfyui/workflow/${workflowId}/model-nodes`).then(r => r.json()),
        ])
        setNodeModels(mRes)
        setWfNodes(nRes)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [workflowId])

  function saveDefaults() {
    localStorage.setItem(LS_OVERRIDES_KEY(workflowId), JSON.stringify(overrides))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function clearDefaults() {
    localStorage.removeItem(LS_OVERRIDES_KEY(workflowId))
    setOverrides({})
    setSaved(false)
  }

  function setCheckpoint(val) {
    setOverrides(o => ({ ...o, checkpoint: val || undefined }))
    setSaved(false)
  }

  function setVideoModel(val) {
    setOverrides(o => ({ ...o, video_model: val || undefined }))
    setSaved(false)
  }

  function setLoraName(idx, val) {
    setOverrides(o => {
      const loras = [...(o.loras || [])]
      if (!loras[idx]) loras[idx] = { lora_name: '', strength_model: 1.0, strength_clip: 1.0 }
      loras[idx] = { ...loras[idx], lora_name: val }
      return { ...o, loras }
    })
    setSaved(false)
  }

  function setLoraStrength(idx, field, val) {
    setOverrides(o => {
      const loras = [...(o.loras || [])]
      if (!loras[idx]) loras[idx] = { lora_name: '', strength_model: 1.0, strength_clip: 1.0 }
      loras[idx] = { ...loras[idx], [field]: parseFloat(val) }
      return { ...o, loras }
    })
    setSaved(false)
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-[var(--text3)]">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-xs font-mono">Caricamento modelli dal nodo...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 p-4">
        <div className="flex items-start gap-2 p-3 rounded border border-[#ef4444]/30 bg-[#ef4444]/5 text-[#ef4444]">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <div>
            <p className="text-xs font-semibold mb-0.5">Nodo non raggiungibile</p>
            <p className="text-[10px] font-mono opacity-80">{error}</p>
            <p className="text-[10px] text-[var(--text3)] mt-1">Assicurati che un nodo ComfyUI sia online e configurato.</p>
          </div>
        </div>
      </div>
    )
  }

  const checkpoints = nodeModels?.checkpoints || []
  const videoModels = nodeModels?.video_models || []
  const loras       = nodeModels?.loras || []

  const cpNodes   = wfNodes?.checkpoint_nodes || []
  const vmNodes   = wfNodes?.video_model_nodes || []
  const loraNodes = wfNodes?.lora_nodes || []

  const hasOverrides = !!(
    overrides.checkpoint ||
    overrides.video_model ||
    (overrides.loras || []).some(l => l?.lora_name)
  )

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--text)]">Override modelli per questo workflow</p>
          <p className="text-[10px] text-[var(--text3)] mt-0.5">
            Seleziona checkpoint, video model o LoRA da applicare al posto dei valori nel JSON.
            Vengono salvati per questo workflow e passati automaticamente alla pipeline.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {hasOverrides && (
            <button
              onClick={clearDefaults}
              className="px-2.5 py-1.5 text-[10px] rounded border border-[#252533] text-[var(--text3)] hover:text-[#ef4444] hover:border-[#ef4444]/40 font-mono"
            >
              Reset
            </button>
          )}
          <button
            onClick={saveDefaults}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] rounded font-mono transition-colors"
            style={{ background: saved ? 'var(--green)' : 'var(--gold)', color: 'var(--bg0)' }}
          >
            {saved ? <CheckCircle size={11} /> : <Save size={11} />}
            {saved ? 'Salvato' : 'Salva come default'}
          </button>
        </div>
      </div>

      {/* Active override pill */}
      {hasOverrides && (
        <div className="flex flex-wrap gap-1.5">
          {overrides.checkpoint && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[#3b82f6]/10 border border-[#3b82f6]/30 text-[#3b82f6] truncate max-w-[200px]">
              ckpt: {overrides.checkpoint}
            </span>
          )}
          {overrides.video_model && (
            <span className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[#a78bfa]/10 border border-[#a78bfa]/30 text-[#a78bfa] truncate max-w-[200px]">
              video: {overrides.video_model}
            </span>
          )}
          {(overrides.loras || []).map((l, i) => l?.lora_name && (
            <span key={i} className="text-[9px] font-mono px-2 py-0.5 rounded-full bg-[#f59e0b]/10 border border-[#f59e0b]/30 text-[#f59e0b] truncate max-w-[200px]">
              lora{i+1}: {l.lora_name}
            </span>
          ))}
        </div>
      )}

      {/* Checkpoint */}
      {(cpNodes.length > 0 || checkpoints.length > 0) && (
        <section className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#252533] bg-[#1e1e2a]">
            <div className="w-2 h-2 rounded-full bg-[#3b82f6] shrink-0" />
            <span className="text-[10px] font-semibold text-[var(--text)]">Checkpoint</span>
            {cpNodes[0]?.current_value && (
              <span className="ml-auto text-[9px] font-mono text-[var(--text3)] truncate max-w-[180px]" title={cpNodes[0].current_value}>
                attuale: {cpNodes[0].current_value}
              </span>
            )}
          </div>
          <div className="p-3">
            {checkpoints.length === 0 ? (
              <p className="text-[10px] text-[var(--text3)] italic">Nessun checkpoint sul nodo ComfyUI.</p>
            ) : (
              <select
                value={overrides.checkpoint || ''}
                onChange={e => setCheckpoint(e.target.value)}
                className="w-full text-[11px] bg-[#0f0f18] text-[var(--text)] rounded px-2.5 py-2 border border-[#252533] font-mono"
              >
                <option value="">(usa il valore del workflow JSON)</option>
                {checkpoints.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            )}
          </div>
        </section>
      )}

      {/* Video Model */}
      {(vmNodes.length > 0 || videoModels.length > 0) && (
        <section className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#252533] bg-[#1e1e2a]">
            <div className="w-2 h-2 rounded-full bg-[#a78bfa] shrink-0" />
            <span className="text-[10px] font-semibold text-[var(--text)]">Video Model</span>
            {vmNodes[0]?.current_value && (
              <span className="ml-auto text-[9px] font-mono text-[var(--text3)] truncate max-w-[180px]" title={vmNodes[0].current_value}>
                attuale: {vmNodes[0].current_value}
              </span>
            )}
          </div>
          <div className="p-3">
            {videoModels.length === 0 ? (
              <p className="text-[10px] text-[var(--text3)] italic">Nessun video model sul nodo ComfyUI.</p>
            ) : (
              <select
                value={overrides.video_model || ''}
                onChange={e => setVideoModel(e.target.value)}
                className="w-full text-[11px] bg-[#0f0f18] text-[var(--text)] rounded px-2.5 py-2 border border-[#252533] font-mono"
              >
                <option value="">(usa il valore del workflow JSON)</option>
                {videoModels.map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}
          </div>
        </section>
      )}

      {/* LoRAs */}
      {loraNodes.length > 0 && (
        <section className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[#252533] bg-[#1e1e2a]">
            <div className="w-2 h-2 rounded-full bg-[#f59e0b] shrink-0" />
            <span className="text-[10px] font-semibold text-[var(--text)]">
              LoRA — {loraNodes.length} {loraNodes.length === 1 ? 'nodo' : 'nodi'} nel workflow
            </span>
          </div>
          <div className="divide-y divide-[#252533]">
            {loraNodes.map((loraNode, idx) => {
              const ov = (overrides.loras || [])[idx] || {}
              const smVal = ov.strength_model ?? loraNode.strength_model ?? 1.0
              const scVal = ov.strength_clip  ?? loraNode.strength_clip  ?? 1.0
              return (
                <div key={loraNode.node_id} className="p-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">
                      Slot {idx + 1}
                    </span>
                    <span className="text-[8px] text-[var(--text3)] font-mono">
                      {loraNode.class_type} · ID {loraNode.node_id}
                    </span>
                    {loraNode.current_value && (
                      <span className="ml-auto text-[8px] font-mono text-[var(--text3)] truncate max-w-[130px]" title={loraNode.current_value}>
                        {loraNode.current_value}
                      </span>
                    )}
                  </div>

                  {loras.length === 0 ? (
                    <p className="text-[10px] text-[var(--text3)] italic">Nessuna LoRA sul nodo ComfyUI.</p>
                  ) : (
                    <select
                      value={ov.lora_name || ''}
                      onChange={e => setLoraName(idx, e.target.value)}
                      className="w-full text-[11px] bg-[#0f0f18] text-[var(--text)] rounded px-2.5 py-2 border border-[#252533] font-mono"
                    >
                      <option value="">(usa il valore del workflow JSON)</option>
                      {loras.map(l => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="flex justify-between mb-1.5">
                        <span className="text-[9px] font-mono text-[var(--text3)]">strength_model</span>
                        <span className="text-[9px] font-mono text-[var(--gold)]">{parseFloat(smVal).toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0} max={1.5} step={0.05}
                        value={parseFloat(smVal)}
                        onChange={e => setLoraStrength(idx, 'strength_model', e.target.value)}
                        className="w-full h-1.5 accent-[var(--gold)] cursor-pointer"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between mb-1.5">
                        <span className="text-[9px] font-mono text-[var(--text3)]">strength_clip</span>
                        <span className="text-[9px] font-mono text-[var(--gold)]">{parseFloat(scVal).toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0} max={1.5} step={0.05}
                        value={parseFloat(scVal)}
                        onChange={e => setLoraStrength(idx, 'strength_clip', e.target.value)}
                        className="w-full h-1.5 accent-[var(--gold)] cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Empty state */}
      {cpNodes.length === 0 && vmNodes.length === 0 && loraNodes.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-[var(--text3)]">
          <Cpu size={32} className="opacity-15" />
          <p className="text-xs font-mono">Nessun nodo model/LoRA trovato in questo workflow.</p>
          <p className="text-[10px] text-center max-w-xs leading-relaxed">
            Il workflow non contiene CheckpointLoaderSimple, LTXVModelLoader, LoraLoader o nodi simili.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Workflow Editor ───────────────────────────────────────────────────────────

function WorkflowEditor({ initialData, onSave, onDelete }) {
  const [tab, setTab]               = useState('visual')
  const [meta, setMeta]             = useState(initialData.meta)
  const [wf, setWf]                 = useState(initialData.workflow)
  const [jsonText, setJsonText]     = useState(JSON.stringify(initialData.workflow, null, 2))
  const [jsonError, setJsonError]   = useState(null)
  const [positions, setPositions]   = useState(() => autoLayout(initialData.workflow))
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [saving, setSaving]         = useState(false)
  const [dirty, setDirty]           = useState(false)

  // When switching to JSON tab, sync from wf state
  function handleTabChange(t) {
    if (t === 'json') setJsonText(JSON.stringify(wf, null, 2))
    setTab(t)
  }

  // Parse JSON and update wf state
  function applyJson(text) {
    try {
      const parsed = JSON.parse(text)
      setWf(parsed)
      setPositions(autoLayout(parsed))
      setSelectedNodeId(null)
      setJsonError(null)
      setDirty(true)
    } catch (e) {
      setJsonError(e.message)
    }
  }

  function updateNodeField(nodeId, key, val) {
    const updated = {
      ...wf,
      [nodeId]: {
        ...wf[nodeId],
        inputs: { ...wf[nodeId].inputs, [key]: val },
      },
    }
    setWf(updated)
    setDirty(true)
  }

  function updatePosition(id, pos) {
    setPositions(p => ({ ...p, [id]: pos }))
  }

  function resetLayout() {
    setPositions(autoLayout(wf))
  }

  async function handleSave() {
    setSaving(true)
    try {
      await onSave(meta.id, { ...meta, workflow: wf })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDownload() {
    const json = JSON.stringify(wf, null, 2)
    await window.studio.workflow.exportJson(meta.id, json)
  }

  const nodeCount = Object.keys(wf).length
  const edgeCount = Object.values(wf).reduce((acc, node) =>
    acc + Object.values(node.inputs || {}).filter(isRef).length, 0)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-[#252533] shrink-0 bg-[#0f0f18]">
        <div className="flex-1 min-w-0">
          <input
            value={meta.name}
            onChange={e => { setMeta(m => ({ ...m, name: e.target.value })); setDirty(true) }}
            className="text-sm font-semibold bg-transparent text-[var(--text)] border-none outline-none w-full"
          />
          <div className="flex items-center gap-3 text-[10px] text-[var(--text3)]">
            <span className="font-mono">{nodeCount} nodi · {edgeCount} connessioni</span>
            <span>·</span>
            <span className="font-mono text-[var(--text3)]">{meta.file}</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex rounded border border-[#252533] overflow-hidden text-[10px]">
          {[
            { key: 'visual', icon: Eye,      label: 'Visuale' },
            { key: 'json',   icon: Code2,    label: 'JSON' },
            { key: 'inject', icon: Settings2, label: 'Inject' },
            { key: 'models', icon: Cpu,      label: 'Modelli' },
          ].map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => handleTabChange(key)}
              className={clsx(
                'flex items-center gap-1 px-2.5 py-1.5 transition-colors',
                tab === key ? 'bg-[#1e1e2a] text-[var(--text)]' : 'text-[var(--text3)] hover:text-[var(--text2)]',
                key !== 'visual' && 'border-l border-[#252533]'
              )}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {tab === 'visual' && (
            <button onClick={resetLayout}
                    title="Reset layout auto"
                    className="px-2 py-1.5 text-[10px] rounded border border-[#252533] text-[var(--text3)] hover:text-[var(--text2)] flex items-center gap-1">
              <RotateCcw size={11} /> Layout
            </button>
          )}
          <button
            onClick={handleDownload}
            title="Scarica workflow JSON per ComfyUI"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] rounded border border-[#252533] text-[var(--text3)] hover:text-[var(--gold)] hover:border-[var(--gold)]/40 transition-colors"
          >
            <Download size={11} /> Export
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] rounded font-mono disabled:opacity-40"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
            Salva
          </button>
          <button onClick={onDelete}
                  className="p-1.5 rounded text-[var(--text3)] hover:text-[var(--red)] border border-[#252533]">
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Workflow type + description bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-[#252533] shrink-0 bg-[#0f0f18]">
        <select
          value={meta.type}
          onChange={e => { setMeta(m => ({ ...m, type: e.target.value })); setDirty(true) }}
          className="text-[10px] bg-[#16161f] text-[var(--text)] rounded px-2 py-1 border border-[#252533]"
        >
          {WORKFLOW_TYPES.map(t => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <input
          value={meta.description}
          onChange={e => { setMeta(m => ({ ...m, description: e.target.value })); setDirty(true) }}
          placeholder="Descrizione workflow..."
          className="flex-1 text-[10px] bg-transparent text-[var(--text2)] border-none outline-none placeholder-[var(--text3)]"
        />
      </div>

      {/* Tab content */}
      {tab === 'visual' && (
        <div className="flex-1 flex overflow-hidden">
          <NodeCanvas
            wf={wf}
            selectedId={selectedNodeId}
            onSelect={setSelectedNodeId}
            positions={positions}
            onPositionChange={updatePosition}
          />
          {selectedNodeId && (
            <NodeInspector
              nodeId={selectedNodeId}
              wf={wf}
              onChange={updateNodeField}
            />
          )}
        </div>
      )}

      {tab === 'json' && (
        <div className="flex-1 flex flex-col overflow-hidden p-4">
          {jsonError && (
            <div className="flex items-center gap-2 px-3 py-2 rounded mb-2 text-[11px] bg-red-900/20 border border-red-500/30 text-red-400 shrink-0">
              <AlertCircle size={13} />
              {jsonError}
            </div>
          )}
          <div className="flex gap-2 shrink-0 mb-2">
            <button
              onClick={() => applyJson(jsonText)}
              className="px-3 py-1.5 text-[10px] rounded font-mono flex items-center gap-1"
              style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
            >
              <CheckCircle size={11} /> Applica JSON
            </button>
            <span className="text-[10px] text-[var(--text3)] self-center">
              Modifica struttura, nodi e connessioni — poi clicca Applica.
            </span>
          </div>
          <textarea
            value={jsonText}
            onChange={e => setJsonText(e.target.value)}
            className="flex-1 font-mono text-[11px] bg-[#07070d] text-[var(--text)] border border-[#252533] rounded p-3 resize-none outline-none focus:border-[#32324a]"
            spellCheck={false}
          />
        </div>
      )}

      {tab === 'inject' && (
        <div className="flex-1 overflow-y-auto">
          <InjectEditor
            inject={meta.inject || {}}
            onChange={inject => { setMeta(m => ({ ...m, inject })); setDirty(true) }}
          />
          <div className="px-4 pb-4">
            <p className="text-[10px] text-[var(--text3)] mb-2">Output nodes (ID dei nodi SaveImage / SaveVideo)</p>
            <div className="space-y-1.5">
              {(meta.output_nodes || []).map((n, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={n}
                    onChange={e => {
                      const nodes = [...(meta.output_nodes || [])]
                      nodes[i] = e.target.value
                      setMeta(m => ({ ...m, output_nodes: nodes }))
                      setDirty(true)
                    }}
                    className="text-[10px] bg-[#16161f] text-[var(--text)] rounded px-2 py-1.5 border border-[#252533] font-mono flex-1"
                  />
                  <button onClick={() => {
                    const nodes = (meta.output_nodes || []).filter((_, j) => j !== i)
                    setMeta(m => ({ ...m, output_nodes: nodes }))
                    setDirty(true)
                  }} className="text-[var(--red)] p-1">
                    <X size={12} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => {
                  setMeta(m => ({ ...m, output_nodes: [...(m.output_nodes || []), ''] }))
                  setDirty(true)
                }}
                className="text-[10px] text-[var(--text3)] hover:text-[var(--text2)] flex items-center gap-1"
              >
                <Plus size={11} /> Aggiungi output node
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'models' && (
        <ModelsLoraTab workflowId={meta.id} />
      )}
    </div>
  )
}

// ── New Workflow Modal ─────────────────────────────────────────────────────────

function NewWorkflowModal({ onClose, onCreate }) {
  const [step, setStep]       = useState('form')   // 'form' | 'paste'
  const [name, setName]       = useState('')
  const [type, setType]       = useState('txt2img')
  const [jsonText, setJsonText] = useState('{}')
  const [error, setError]     = useState(null)
  const [saving, setSaving]   = useState(false)

  async function handleCreate() {
    setError(null)
    let wf = {}
    try { wf = JSON.parse(jsonText) } catch (e) { setError('JSON non valido: ' + e.message); return }
    if (!name.trim()) { setError('Inserisci un nome'); return }
    setSaving(true)
    try {
      await onCreate({ name: name.trim(), type, workflow: wf })
      onClose()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[640px] max-h-[80vh] flex flex-col rounded-xl border border-[#252533] bg-[#12121a] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#252533]">
          <span className="text-sm font-semibold text-[var(--text)]">Nuovo workflow</span>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded text-[11px] bg-red-900/20 border border-red-500/30 text-red-400">
              <AlertCircle size={13} /> {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-[var(--text3)] block mb-1">Nome *</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Es. SDXL Lightning"
                className="w-full text-xs bg-[#16161f] text-[var(--text)] rounded px-2.5 py-2 border border-[#252533] outline-none focus:border-[var(--gold)]"
              />
            </div>
            <div>
              <label className="text-[10px] text-[var(--text3)] block mb-1">Tipo</label>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full text-xs bg-[#16161f] text-[var(--text)] rounded px-2.5 py-2 border border-[#252533]"
              >
                {WORKFLOW_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] text-[var(--text3)] block mb-1">
              JSON del workflow ComfyUI (copia dal browser ComfyUI: Save → API format)
            </label>
            <textarea
              value={jsonText}
              onChange={e => setJsonText(e.target.value)}
              rows={12}
              placeholder='{ "1": { "class_type": "...", "inputs": {...} }, ... }'
              className="w-full font-mono text-[10px] bg-[#07070d] text-[var(--text)] border border-[#252533] rounded p-2.5 resize-none outline-none focus:border-[var(--gold)]"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#252533]">
          <button onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-[#252533] text-[var(--text3)] hover:text-[var(--text)]">
            Annulla
          </button>
          <button
            onClick={handleCreate}
            disabled={saving}
            className="px-4 py-1.5 text-xs rounded font-mono flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Crea workflow
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Workflow List (left panel) ────────────────────────────────────────────────

// ── Workflow type → category metadata ─────────────────────────────────────────

const CATEGORIES = [
  {
    type: 'txt2img',
    label: 'Text → Image',
    icon: '🖼',
    color: 'text-purple-300',
    border: 'border-purple-500/40',
    badge: 'text-purple-300 bg-purple-900/30 border-purple-500/30',
  },
  {
    type: 'txt2video',
    label: 'Text → Video',
    icon: '🎬',
    color: 'text-blue-300',
    border: 'border-blue-500/40',
    badge: 'text-blue-300 bg-blue-900/30 border-blue-500/30',
  },
  {
    type: 'img2video',
    label: 'Image → Video',
    icon: '🎞',
    color: 'text-green-300',
    border: 'border-green-500/40',
    badge: 'text-green-300 bg-green-900/30 border-green-500/30',
  },
  {
    type: 'img2video_lastframe',
    label: 'Image → Video + Last Frame',
    icon: '🔗',
    color: 'text-orange-300',
    border: 'border-orange-500/40',
    badge: 'text-orange-300 bg-orange-900/30 border-orange-500/30',
  },
  {
    type: 'img2img',
    label: 'Image → Image',
    icon: '🔄',
    color: 'text-teal-300',
    border: 'border-teal-500/40',
    badge: 'text-teal-300 bg-teal-900/30 border-teal-500/30',
  },
  {
    type: 'img_audio2video',
    label: 'Audio+Image → Video',
    icon: '🎵',
    color: 'text-amber-300',
    border: 'border-amber-500/40',
    badge: 'text-amber-300 bg-amber-900/30 border-amber-500/30',
  },
  {
    type: 'director',
    label: 'Director',
    icon: '🎥',
    color: 'text-[#c9a84c]',
    border: 'border-[#c9a84c]/50',
    badge: 'text-[#c9a84c] bg-[#c9a84c]/10 border-[#c9a84c]/30',
  },
]

const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.type, c]))

function WorkflowList({ workflows, selectedId, onSelect, onNew }) {
  const [collapsed, setCollapsed] = useState({})

  function toggleCat(type) {
    setCollapsed(c => ({ ...c, [type]: !c[type] }))
  }

  // Group workflows by type; unknown types go into a fallback bucket
  const grouped = {}
  workflows.forEach(wf => {
    const t = wf.type || 'other'
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(wf)
  })

  // Render categories in order (only if they have workflows or are known)
  const orderedTypes = [
    ...CATEGORIES.map(c => c.type).filter(t => grouped[t]),
    ...Object.keys(grouped).filter(t => !CAT_MAP[t]),
  ]

  return (
    <div className="w-60 shrink-0 border-r border-[#252533] flex flex-col bg-[#0f0f18] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#252533]">
        <span className="text-xs font-semibold text-[var(--text)]">Workflow</span>
        <button onClick={onNew}
                className="p-1 rounded text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10">
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {orderedTypes.length === 0 && (
          <p className="text-[11px] text-[var(--text3)] px-3 py-4 text-center">Nessun workflow configurato</p>
        )}
        {orderedTypes.map(type => {
          const cat = CAT_MAP[type] || { label: type, icon: '⚙', color: 'text-gray-300', border: 'border-gray-500/40', badge: 'text-gray-300 bg-gray-900/30 border-gray-500/30' }
          const items = grouped[type] || []
          const isOpen = !collapsed[type]

          return (
            <div key={type}>
              {/* Category header */}
              <button
                onClick={() => toggleCat(type)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 py-2 border-b border-[#1e1e2a] hover:bg-[#16161f] transition-colors',
                  isOpen ? 'bg-[#12121a]' : 'bg-[#0f0f18]'
                )}
              >
                <span className="text-[11px] shrink-0">{cat.icon}</span>
                <span className={clsx('text-[10px] font-semibold tracking-wider flex-1 text-left', cat.color)}>
                  {cat.label}
                </span>
                <span className="text-[9px] text-[var(--text3)] font-mono mr-1">{items.length}</span>
                {isOpen
                  ? <ChevronUp size={10} className="text-[var(--text3)] shrink-0" />
                  : <ChevronDown size={10} className="text-[var(--text3)] shrink-0" />}
              </button>

              {/* Workflow items */}
              {isOpen && (
                <div className="py-1">
                  {items.map(wf => (
                    <button
                      key={wf.id}
                      onClick={() => onSelect(wf.id)}
                      className={clsx(
                        'w-full text-left px-3 py-2 transition-colors border-l-2 ml-0',
                        selectedId === wf.id
                          ? `bg-[#1e1e2a] text-[var(--text)] ${cat.border}`
                          : 'border-transparent text-[var(--text2)] hover:bg-[#16161f] hover:text-[var(--text)]'
                      )}
                    >
                      <p className="text-[11px] font-medium leading-tight truncate">{wf.name}</p>
                      <p className="text-[9px] text-[var(--text3)] font-mono truncate mt-0.5">{wf.file}</p>
                      {wf.models?.length > 0 && (
                        <p className="text-[8px] text-[var(--text3)] truncate mt-0.5 opacity-60">
                          {wf.models[0]}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function WorkflowsScreen() {
  const [workflows, setWorkflows]     = useState([])
  const [selectedId, setSelectedId]   = useState(null)
  const [editorData, setEditorData]   = useState(null)
  const [loading, setLoading]         = useState(true)
  const [loadingWf, setLoadingWf]     = useState(false)
  const [showNew, setShowNew]         = useState(false)

  async function loadList() {
    try {
      const m = await window.studio.workflow.list()
      setWorkflows(m.workflows || [])
      // Auto-select first if none selected
      if (!selectedId && m.workflows?.length > 0) {
        await selectWorkflow(m.workflows[0].id)
      }
    } finally {
      setLoading(false)
    }
  }

  async function selectWorkflow(id) {
    setSelectedId(id)
    setLoadingWf(true)
    try {
      const data = await window.studio.workflow.get(id)
      setEditorData(data)
    } finally {
      setLoadingWf(false)
    }
  }

  async function handleSave(id, data) {
    await window.studio.workflow.save(id, data)
  }

  async function handleCreate(data) {
    const res = await window.studio.workflow.create(data)
    await loadList()
    await selectWorkflow(res.id)
  }

  async function handleDelete() {
    if (!selectedId) return
    if (!confirm('Eliminare questo workflow?')) return
    await window.studio.workflow.delete(selectedId)
    setEditorData(null)
    setSelectedId(null)
    await loadList()
  }

  useEffect(() => { loadList() }, [])

  // When user clicks a workflow in the list
  useEffect(() => {
    if (selectedId && (!editorData || editorData.meta?.id !== selectedId)) {
      selectWorkflow(selectedId)
    }
  }, [selectedId])

  return (
    <div className="flex h-full overflow-hidden">
      {showNew && (
        <NewWorkflowModal onClose={() => setShowNew(false)} onCreate={handleCreate} />
      )}

      <WorkflowList
        workflows={workflows}
        selectedId={selectedId}
        onSelect={id => { if (id !== selectedId) selectWorkflow(id) }}
        onNew={() => setShowNew(true)}
      />

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={24} className="animate-spin text-[var(--text3)]" />
        </div>
      ) : !editorData ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
          <FileJson size={40} className="text-[var(--text3)] opacity-20" />
          <p className="text-sm text-[var(--text3)]">Seleziona un workflow dalla lista</p>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-xs rounded font-mono"
            style={{ background: 'var(--gold)', color: 'var(--bg0)' }}
          >
            <Plus size={13} /> Nuovo workflow
          </button>
        </div>
      ) : loadingWf ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-[var(--text3)]" />
        </div>
      ) : (
        <WorkflowEditor
          key={selectedId}
          initialData={editorData}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
