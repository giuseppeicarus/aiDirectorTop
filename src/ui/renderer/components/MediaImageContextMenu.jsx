/**
 * Menu contestuale (tasto destro) per immagini media — azione "Anima" → img2video.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Play } from 'lucide-react'

function clampMenuPosition(x, y) {
  const w = 168
  const h = 44
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
  }
}

export default function MediaImageContextMenu({ x, y, onAnimate, onClose }) {
  useEffect(() => {
    function dismiss(e) {
      if (e.type === 'keydown' && e.key !== 'Escape') return
      onClose()
    }
    const t = setTimeout(() => {
      window.addEventListener('mousedown', dismiss)
      window.addEventListener('keydown', dismiss)
      window.addEventListener('scroll', dismiss, true)
      window.addEventListener('resize', dismiss)
    }, 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', dismiss)
      window.removeEventListener('keydown', dismiss)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [onClose])

  const pos = clampMenuPosition(x, y)

  return createPortal(
    <div
      className="fixed z-[10001] min-w-[156px] py-1 rounded-lg border border-[var(--border2)] bg-[var(--bg1)] shadow-2xl"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
      onMouseDown={e => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => { onAnimate(); onClose() }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-[var(--text)] hover:bg-[var(--gold)]/12 hover:text-[var(--gold)] transition-colors text-left"
      >
        <Play size={14} className="text-[var(--gold)] shrink-0" />
        <span>
          <span className="font-medium block">Anima</span>
          <span className="text-[9px] text-[var(--text3)] font-mono">Image → Video</span>
        </span>
      </button>
    </div>,
    document.body,
  )
}
