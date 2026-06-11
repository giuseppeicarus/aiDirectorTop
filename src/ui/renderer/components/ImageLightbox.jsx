/**
 * Galleria fullscreen con zoom (rotella/pinch) e pan (trascina).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  X, ZoomIn, ZoomOut, RotateCcw, ChevronLeft, ChevronRight, Maximize2, Download,
} from 'lucide-react'
import clsx from 'clsx'

const MIN_SCALE = 1
const MAX_SCALE = 12
const PAN_CLICK_THRESHOLD_PX = 6

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

export default function ImageLightbox({
  open,
  onClose,
  items = [],
  initialIndex = 0,
}) {
  const [index, setIndex] = useState(initialIndex)
  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const dragging = useRef(false)
  const didPan = useRef(false)
  const panStart = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const viewportRef = useRef(null)

  const list = items.filter(it => it?.src)
  const current = list[index] ?? null
  const isImage = current?.type !== 'video'

  const resetTransform = useCallback(() => {
    setScale(1)
    setPos({ x: 0, y: 0 })
  }, [])

  const handleDownload = () => {
    if (!current?.src) return
    const link = document.createElement('a')
    link.href = current.src
    const urlName = String(current.src).split(/[/\\]/).pop() || 'resource'
    const cleanUrlName = urlName.split('?')[0]
    const ext = isImage ? '.png' : '.mp4'
    const baseName = current.alt
      ? current.alt.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      : cleanUrlName.replace(/\.[^/.]+$/, "")
    const filename = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  useEffect(() => {
    if (!open) return
    setIndex(clamp(initialIndex, 0, Math.max(0, list.length - 1)))
    resetTransform()
  }, [open, initialIndex, list.length, resetTransform])

  useEffect(() => {
    resetTransform()
  }, [index, resetTransform])

  const go = useCallback((dir) => {
    if (list.length < 2) return
    setIndex(i => (i + dir + list.length) % list.length)
  }, [list.length])

  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
      if (e.key === '+' || e.key === '=') setScale(s => clamp(s * 1.2, MIN_SCALE, MAX_SCALE))
      if (e.key === '-') setScale(s => clamp(s / 1.2, MIN_SCALE, MAX_SCALE))
      if (e.key === '0') resetTransform()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, go, resetTransform])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Safety net: if native fullscreen is triggered (F key, video control bypass…)
  // exit immediately so the custom header stays visible
  useEffect(() => {
    if (!open) return
    function onFsChange() {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [open])

  const zoomBy = useCallback((factor) => {
    setScale(s => {
      const next = clamp(s * factor, MIN_SCALE, MAX_SCALE)
      if (next <= 1) setPos({ x: 0, y: 0 })
      return next
    })
  }, [])

  const onWheel = useCallback((e) => {
    if (!isImage) return
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 0.88
    zoomBy(factor)
  }, [isImage, zoomBy])

  const onPointerDown = useCallback((e) => {
    if (!isImage || scale <= 1) return
    dragging.current = true
    didPan.current = false
    panStart.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [isImage, scale, pos])

  const onPointerMove = useCallback((e) => {
    if (!dragging.current) return
    const dx = e.clientX - panStart.current.x
    const dy = e.clientY - panStart.current.y
    if (Math.hypot(dx, dy) >= PAN_CLICK_THRESHOLD_PX) {
      didPan.current = true
    }
    setPos({
      x: panStart.current.px + dx,
      y: panStart.current.py + dy,
    })
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const onViewportClick = useCallback((e) => {
    // Dopo un pan il browser emette ancora un click sullo sfondo → non chiudere
    if (didPan.current) {
      didPan.current = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (e.target === e.currentTarget) {
      onClose()
    }
  }, [onClose])

  const onDoubleClick = useCallback(() => {
    if (scale > 1) resetTransform()
    else setScale(2.5)
  }, [scale, resetTransform])

  if (!open || !current) return null

  const ui = (
    <div
      className="fixed inset-x-0 bottom-0 top-8 z-[9999] flex flex-col bg-black/95 select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Anteprima immagine"
    >
      {/* Header — relative z-10 keeps it above video stacking context */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0 border-b border-white/10 relative z-10">
        <div className="min-w-0 flex-1 pr-4">
          <p className="text-sm text-white/90 truncate font-mono">{current.alt || 'Anteprima'}</p>
          {list.length > 1 && (
            <p className="text-[10px] text-white/40 mt-0.5">
              {index + 1} / {list.length}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <ToolbarBtn onClick={handleDownload} title="Scarica risorsa">
            <Download size={17} />
          </ToolbarBtn>
          {isImage && (
            <>
              <ToolbarBtn onClick={() => zoomBy(0.8)} title="Zoom −">
                <ZoomOut size={18} />
              </ToolbarBtn>
              <span className="text-[11px] text-white/50 font-mono w-12 text-center tabular-nums">
                {Math.round(scale * 100)}%
              </span>
              <ToolbarBtn onClick={() => zoomBy(1.25)} title="Zoom +">
                <ZoomIn size={18} />
              </ToolbarBtn>
              <ToolbarBtn onClick={resetTransform} title="Ripristina">
                <RotateCcw size={16} />
              </ToolbarBtn>
            </>
          )}
          <ToolbarBtn onClick={onClose} title="Chiudi (Esc)">
            <X size={18} />
          </ToolbarBtn>
        </div>
      </div>

      {/* Viewport */}
      <div
        ref={viewportRef}
        className={clsx(
          'flex-1 relative overflow-hidden flex items-center justify-center',
          isImage && scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onClick={onViewportClick}
      >
        {list.length > 1 && (
          <>
            <NavBtn side="left" onClick={() => go(-1)} />
            <NavBtn side="right" onClick={() => go(1)} />
          </>
        )}

        {isImage ? (
          <img
            src={current.src}
            alt={current.alt || ''}
            draggable={false}
            className="max-w-[92vw] max-h-[78vh] object-contain pointer-events-none will-change-transform"
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              transition: dragging.current ? 'none' : 'transform 0.08s ease-out',
            }}
          />
        ) : (
          <video
            src={current.src}
            controls
            autoPlay
            controlsList="nofullscreen nodownload nopictureinpicture"
            disablePictureInPicture
            className="max-w-full max-h-full pointer-events-auto"
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        )}
      </div>

      {/* Footer hint */}
      <div className="shrink-0 px-4 py-2 border-t border-white/10 flex items-center justify-center gap-2 text-[10px] text-white/35 font-mono">
        {isImage ? (
          <>
            <Maximize2 size={11} />
            <span>Rotella · pinch = zoom</span>
            <span className="text-white/20">·</span>
            <span>Trascina = sposta</span>
            <span className="text-white/20">·</span>
            <span>Doppio click = reset / 250%</span>
          </>
        ) : (
          <span>Esc per chiudere</span>
        )}
        {list.length > 1 && (
          <>
            <span className="text-white/20">·</span>
            <span>← → cambia immagine</span>
          </>
        )}
      </div>
    </div>
  )

  return createPortal(ui, document.body)
}

function ToolbarBtn({ children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
    >
      {children}
    </button>
  )
}

function NavBtn({ side, onClick }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className={clsx(
        'absolute top-1/2 -translate-y-1/2 z-10 p-3 rounded-full',
        'bg-black/50 text-white/80 hover:bg-black/70 hover:text-white transition-colors',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      {side === 'left' ? <ChevronLeft size={22} /> : <ChevronRight size={22} />}
    </button>
  )
}
