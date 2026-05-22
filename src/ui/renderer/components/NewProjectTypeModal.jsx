import { useEffect } from 'react'
import {
  X, FolderOpen, Clapperboard, Tv, Instagram, ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'

export const NEW_PROJECT_OPTIONS = [
  {
    id: 'cinematic',
    label: 'Progetto normale',
    description: 'Pipeline cinematic a 5 LLM, storyboard e generazione shot.',
    Icon: FolderOpen,
    to: '/projects/new',
  },
  {
    id: 'director',
    label: 'Director Cinema',
    description: 'Workspace clip singole, txt2video e controllo manuale.',
    Icon: Clapperboard,
    to: '/director',
    state: { newProject: true },
    accent: true,
  },
  {
    id: 'trailer',
    label: 'Trailer Generator',
    description: 'Music video / trailer da audio, EDL e generazione LTX.',
    Icon: Tv,
    to: '/trailer',
    state: { newProject: true },
    accent: true,
  },
  {
    id: 'reel',
    label: 'Reel',
    description: 'Reel verticale da brief, immagini di riferimento e audio.',
    Icon: Instagram,
    to: '/createreel',
    state: { newProject: true },
    accent: true,
  },
]

export default function NewProjectTypeModal({ open, onClose, onSelect }) {
  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-[#07070d]/80 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-[#252533] bg-[#16161f] shadow-2xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-labelledby="new-project-title"
        aria-modal="true"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#252533]">
          <div>
            <h2 id="new-project-title" className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">
              Nuovo progetto
            </h2>
            <p className="text-[10px] font-mono text-[#555568] mt-0.5">
              Scegli il tipo di produzione
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-[#555568] hover:text-[#e8e4dd] hover:bg-[#1e1e2a]"
            aria-label="Chiudi"
          >
            <X size={16} />
          </button>
        </div>

        <ul className="p-2 space-y-1">
          {NEW_PROJECT_OPTIONS.map(({ id, label, description, Icon, accent }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => onSelect?.(id)}
                className={clsx(
                  'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors group',
                  accent
                    ? 'hover:bg-[#c9a84c]/10 border border-transparent hover:border-[#c9a84c]/30'
                    : 'hover:bg-[#1e1e2a] border border-transparent',
                )}
              >
                <span
                  className={clsx(
                    'mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                    accent ? 'bg-[#c9a84c]/15 text-[#c9a84c]' : 'bg-[#1e1e2a] text-[#9090a8]',
                  )}
                >
                  <Icon size={16} />
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={clsx(
                      'text-sm font-medium block',
                      accent ? 'text-[#c9a84c]' : 'text-[#e8e4dd]',
                    )}
                  >
                    {label}
                  </span>
                  <span className="text-[10px] font-mono text-[#555568] leading-relaxed block mt-0.5">
                    {description}
                  </span>
                </span>
                <ChevronRight
                  size={14}
                  className="shrink-0 mt-2 text-[#555568] group-hover:text-[#c9a84c] transition-colors"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
