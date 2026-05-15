/**
 * WorkflowsScreen — visual editor per workflow ComfyUI.
 * Left: lista workflow · Right: editor visuale nodi / editor JSON / metadati inject
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Workflow, Plus, Save, Trash2, ChevronDown, ChevronUp,
  Eye, Code2, Settings2, Copy, AlertCircle, CheckCircle,
  Loader2, X, FileJson, RotateCcw,
} from 'lucide-react'
import clsx from 'clsx'

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_W   = 220
const HDR_H    = 36
const ROW_H    = 26
const PAD_B    = 10
const MIN_CANVAS_W = 3200
const MIN_CANVAS_H = 2400

const WORKFLOW_TYPES = [
  { value: 'txt2img',       label: 'Text → Image' },
  { value: 'txt2video',     label: 'Text → Video' },
  { value: 'img2video',     label: 'Image → Video' },
  { value: 'img_audio2video', label: 'Image+Audio → Video' },
]

const INJECT_PARAMS = [
  'prompt', 'negative_prompt', 'width', 'height', 'seed',
  'first_image', 'audio', 'duration_sec', 'fps', 'audio_start_sec',
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

const TYPE_LABELS = {
  txt2img:        'T→IMG',
  txt2video:      'T→VID',
  img2video:      'IMG→VID',
  img_audio2video: 'IMG+A→VID',
}
const TYPE_COLORS = {
  txt2img:        'text-purple-300 bg-purple-900/30 border-purple-500/30',
  txt2video:      'text-blue-300 bg-blue-900/30 border-blue-500/30',
  img2video:      'text-green-300 bg-green-900/30 border-green-500/30',
  img_audio2video: 'text-amber-300 bg-amber-900/30 border-amber-500/30',
}

function WorkflowList({ workflows, selectedId, onSelect, onNew }) {
  return (
    <div className="w-56 shrink-0 border-r border-[#252533] flex flex-col bg-[#0f0f18] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-3 border-b border-[#252533]">
        <span className="text-xs font-semibold text-[var(--text)]">Workflow</span>
        <button onClick={onNew}
                className="p-1 rounded text-[var(--text3)] hover:text-[var(--gold)] hover:bg-[var(--gold)]/10">
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {workflows.map(wf => (
          <button
            key={wf.id}
            onClick={() => onSelect(wf.id)}
            className={clsx(
              'w-full text-left px-2.5 py-2.5 rounded-md transition-colors',
              selectedId === wf.id
                ? 'bg-[#1e1e2a] text-[var(--text)]'
                : 'text-[var(--text2)] hover:bg-[#16161f] hover:text-[var(--text)]'
            )}
          >
            <div className="flex items-start gap-2">
              <span className={clsx(
                'text-[8px] px-1 py-0.5 rounded border font-mono shrink-0 mt-0.5',
                TYPE_COLORS[wf.type] || 'text-gray-400 bg-gray-900/30 border-gray-500/30'
              )}>
                {TYPE_LABELS[wf.type] || wf.type}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium leading-tight truncate">{wf.name}</p>
                <p className="text-[9px] text-[var(--text3)] font-mono truncate mt-0.5">{wf.file}</p>
              </div>
            </div>
          </button>
        ))}
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
