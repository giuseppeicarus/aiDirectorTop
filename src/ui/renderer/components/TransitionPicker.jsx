import { useState, useRef, useEffect, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { X } from 'lucide-react'
import clsx from 'clsx'
import { TRANSITIONS, TRANSITION_CATEGORIES, TransitionEngine } from './TransitionEngine'

const CAT_COLORS = {
  basic:     'text-[#9090a8]',
  slide:     'text-[#3b82f6]',
  wipe:      'text-[#22c55e]',
  cinematic: 'text-[#c9a84c]',
  '3d':      'text-[#a855f7]',
}

function _colorCanvas(color, w, h) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  ctx.fillStyle = color
  ctx.fillRect(0, 0, w, h)
  return c.toDataURL()
}

function TransitionThumb({ trans, isSelected, onClick, fromSrc, toSrc }) {
  const canvasRef  = useRef(null)
  const engineRef  = useRef(null)
  const [hov, setHov] = useState(false)

  const runAnim = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || trans.id === 'cut') return
    if (!engineRef.current) engineRef.current = new TransitionEngine(canvas)
    const eng = engineRef.current

    const f = new window.Image(); const t = new window.Image()
    f.crossOrigin = 'anonymous'; t.crossOrigin = 'anonymous'
    let n = 0
    const go = () => {
      n++
      if (n < 2) return
      eng.animate(trans.id, f, t, (trans.duration || 0.5) * 1000)
    }
    f.onload = go; t.onload = go; f.onerror = go; t.onerror = go
    f.src = fromSrc || _colorCanvas('#1a1020', 56, 40)
    t.src = toSrc   || _colorCanvas('#0a1520', 56, 40)
  }, [trans.id, trans.duration, fromSrc, toSrc])

  useEffect(() => {
    if (hov) runAnim()
    else engineRef.current?.stop()
    return () => engineRef.current?.stop()
  }, [hov, runAnim])

  useEffect(() => () => engineRef.current?.destroy(), [])

  return (
    <button
      type="button"
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onClick}
      title={trans.label}
      className={clsx(
        'flex flex-col items-center gap-1 p-1.5 rounded-lg border transition-all',
        isSelected
          ? 'border-[#c9a84c]/70 bg-[#c9a84c]/12'
          : 'border-[#252533] hover:border-[#32324a] bg-[#16161f] hover:bg-[#1e1e2a]',
      )}
    >
      {trans.id === 'cut'
        ? <div className="w-14 h-10 rounded flex items-center justify-center bg-[#0f0f18] text-base">✂️</div>
        : <canvas ref={canvasRef} width={56} height={40} className="rounded block" />
      }
      <span className={clsx('text-[8px] font-mono truncate w-full text-center',
        isSelected ? 'text-[#c9a84c]' : 'text-[#555568]')}>
        {trans.label}
      </span>
    </button>
  )
}

function PickerPanel({ value, onChange, onClose, fromSrc, toSrc, style }) {
  const [cat, setCat] = useState(() => {
    const cur = TRANSITIONS[value]
    return cur?.cat || 'basic'
  })
  const panelRef = useRef(null)

  useEffect(() => {
    function handler(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const catTransitions = Object.values(TRANSITIONS).filter(t => t.cat === cat)

  return ReactDOM.createPortal(
    <div
      ref={panelRef}
      className="rounded-xl border border-[#252533] bg-[#12121a] shadow-2xl overflow-hidden"
      style={{ position: 'fixed', zIndex: 9999, width: 300, ...style }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#252533]">
        <span className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider">Transizione</span>
        <button onClick={onClose} className="text-[#555568] hover:text-[#9090a8]"><X size={12} /></button>
      </div>

      <div className="flex border-b border-[#252533]">
        {TRANSITION_CATEGORIES.map(c => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            className={clsx(
              'flex-1 py-1.5 text-[8px] font-mono uppercase tracking-wider transition-colors',
              cat === c.id
                ? `bg-[#1e1e2a] ${CAT_COLORS[c.id] || 'text-[#9090a8]'}`
                : 'text-[#555568] hover:text-[#9090a8]',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="p-2 grid grid-cols-4 gap-1.5 overflow-y-auto" style={{ maxHeight: 200 }}>
        {catTransitions.map(t => (
          <TransitionThumb
            key={t.id}
            trans={t}
            isSelected={value === t.id}
            onClick={() => { onChange(t.id); onClose() }}
            fromSrc={fromSrc}
            toSrc={toSrc}
          />
        ))}
      </div>

      {TRANSITIONS[value] && (
        <div className="px-3 py-2 border-t border-[#252533] flex items-center justify-between">
          <span className="text-[9px] font-mono text-[#9090a8]">{TRANSITIONS[value].label}</span>
          <span className="text-[8px] font-mono text-[#555568]">
            {TRANSITIONS[value].duration > 0 ? `${TRANSITIONS[value].duration}s` : 'Istantaneo'}
          </span>
        </div>
      )}
    </div>,
    document.body,
  )
}

export default function TransitionPicker({ value, onChange, onClose, anchorRef, fromSrc, toSrc }) {
  const [pos, setPos] = useState(null)

  useEffect(() => {
    if (!anchorRef?.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const panelH = 320
    const panelW = 300
    let top = rect.top - panelH - 8
    if (top < 8) top = rect.bottom + 8
    let left = rect.left + rect.width / 2 - panelW / 2
    left = Math.max(8, Math.min(left, window.innerWidth - panelW - 8))
    setPos({ top, left })
  }, [anchorRef])

  if (!pos) return null
  return (
    <PickerPanel
      value={value}
      onChange={onChange}
      onClose={onClose}
      fromSrc={fromSrc}
      toSrc={toSrc}
      style={pos}
    />
  )
}
