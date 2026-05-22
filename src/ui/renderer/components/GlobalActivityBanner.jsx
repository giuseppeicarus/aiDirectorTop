import { Loader2, Sparkles, Brain, Image, Film, PauseCircle, ArrowRight } from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import { useGlobalActivityStore } from '../stores/globalActivityStore'
import { useProjectStore } from '../stores'

const KIND_ICON = {
  llm: Brain,
  image: Image,
  video: Film,
  pause: PauseCircle,
  work: Sparkles,
}

export default function GlobalActivityBanner() {
  const navigate = useNavigate()
  const tasks = useGlobalActivityStore(s => s.tasks)
  const currentProject = useProjectStore(s => s.currentProject)

  const list = Object.values(tasks)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 3)

  if (!list.length) return null

  return (
    <div className="shrink-0 border-b border-[#c9a84c]/25 bg-[#0f0f18]/95 backdrop-blur-sm z-40">
      <div className="px-4 py-2 space-y-1.5">
        {list.map(task => {
          const Icon = KIND_ICON[task.kind] || Sparkles
          const isPause = task.kind === 'pause'
          let text = task.message
          if (!text.includes('progetto') && task.channel === 'pipeline:progress' && currentProject?.title) {
            text = `${text} — progetto ${currentProject.title}`
          }
          return (
            <div
              key={task.id}
              className={clsx(
                'flex items-start gap-2.5 px-3 py-2 rounded-lg border text-[11px] font-mono',
                isPause
                  ? 'border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#93c5fd]'
                  : 'border-[#c9a84c]/35 bg-[#c9a84c]/8 text-[#e8e4dd]',
              )}
            >
              {isPause ? (
                <PauseCircle size={14} className="shrink-0 mt-0.5 text-[#3b82f6]" />
              ) : (
                <Loader2 size={14} className="shrink-0 mt-0.5 animate-spin text-[#c9a84c]" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Icon size={11} className="text-[#c9a84c] shrink-0" />
                  {task.source && (
                    <span className="text-[#9090a8] uppercase tracking-wider text-[9px]">{task.source}</span>
                  )}
                  {task.pct != null && (
                    <span className="text-[#c9a84c] tabular-nums text-[9px]">{task.pct}%</span>
                  )}
                </div>
                <p className="leading-snug mt-0.5 break-words">{text}</p>
              </div>
              {task.nav?.path && (
                <button
                  type="button"
                  onClick={() => navigate({
                    pathname: task.nav.path,
                    search: task.nav.search || '',
                  })}
                  className={clsx(
                    'shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded text-[9px] font-mono uppercase tracking-wide border transition-colors',
                    isPause
                      ? 'border-[#3b82f6]/50 text-[#93c5fd] hover:bg-[#3b82f6]/20'
                      : 'border-[#c9a84c]/50 text-[#c9a84c] hover:bg-[#c9a84c]/15',
                  )}
                  title="Apri dettaglio run"
                >
                  Vai
                  <ArrowRight size={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
