import { useCallback, useEffect, useState } from 'react'
import { Minus, Square, X, Copy } from 'lucide-react'
import clsx from 'clsx'

function focusedWindow() {
  return window.studio?.window
}

export default function WindowChrome() {
  const api = focusedWindow()
  const [maximized, setMaximized] = useState(false)

  const refreshMaximized = useCallback(async () => {
    if (!api?.isMaximized) return
    try {
      setMaximized(await api.isMaximized())
    } catch {
      /* ignore */
    }
  }, [api])

  useEffect(() => {
    if (!api) return undefined
    refreshMaximized()
    return api.onMaximizedChange?.(setMaximized)
  }, [api, refreshMaximized])

  if (!api) return null

  const onMinimize = () => api.minimize()
  const onToggleMaximize = async () => {
    await api.toggleMaximize()
    await refreshMaximized()
  }
  const onClose = () => api.close()

  return (
    <header
      className={clsx(
        'window-chrome relative z-[10002] shrink-0 h-8 flex items-stretch',
        'bg-[#0a0a0f] border-b border-[#2a2a38]',
      )}
    >
      <div
        className="window-drag flex-1 flex items-center px-3 min-w-0"
        onDoubleClick={onToggleMaximize}
        title="Trascina · doppio clic per ingrandire"
      >
        <span className="text-[10px] font-mono uppercase tracking-widest text-[#555568] truncate pointer-events-none">
          CinematicAI Studio
        </span>
      </div>
      <div className="window-no-drag flex items-stretch">
        <ChromeButton label="Riduci" onClick={onMinimize}>
          <Minus size={14} strokeWidth={1.75} />
        </ChromeButton>
        <ChromeButton label={maximized ? 'Ripristina' : 'Ingrandisci'} onClick={onToggleMaximize}>
          {maximized ? <Copy size={12} strokeWidth={1.75} /> : <Square size={12} strokeWidth={1.75} />}
        </ChromeButton>
        <ChromeButton label="Chiudi" onClick={onClose} variant="close">
          <X size={14} strokeWidth={1.75} />
        </ChromeButton>
      </div>
    </header>
  )
}

function ChromeButton({ children, label, onClick, variant }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={clsx(
        'w-11 h-full flex items-center justify-center transition-colors',
        variant === 'close'
          ? 'text-[#9090a0] hover:bg-[#ef4444] hover:text-white'
          : 'text-[#9090a0] hover:bg-[#1e1e2a] hover:text-[#f0ede8]',
      )}
    >
      {children}
    </button>
  )
}
