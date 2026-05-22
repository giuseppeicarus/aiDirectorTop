import { useEffect, useState } from 'react'
import { Film, CheckCircle2, Loader2, AlertTriangle, Circle } from 'lucide-react'
import clsx from 'clsx'
import { BOOTSTRAP_STEPS } from '../hooks/useAppBootstrap'

function StepIcon({ status }) {
  if (status === 'done') return <CheckCircle2 size={14} className="text-[var(--green)] shrink-0" />
  if (status === 'active') return <Loader2 size={14} className="text-[var(--gold)] animate-spin shrink-0" />
  if (status === 'error') return <AlertTriangle size={14} className="text-[var(--red)] shrink-0" />
  if (status === 'warn') return <AlertTriangle size={14} className="text-[var(--amber)] shrink-0" />
  return <Circle size={14} className="text-[var(--text3)] shrink-0" />
}

export default function SplashScreen({
  steps,
  progress,
  phase,
  criticalError,
  onEnterAnyway,
  onSkip,
}) {
  const exiting = phase === 'exiting' || phase === 'done'
  const [showSkip, setShowSkip] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setShowSkip(true), 6000)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className={clsx(
        'splash-root fixed inset-0 z-[9999] flex items-center justify-center overflow-hidden',
        exiting && 'splash-root--exit',
      )}
      aria-live="polite"
      aria-busy={!exiting}
    >
      <div className="splash-grain" aria-hidden />
      <div className="splash-vignette" aria-hidden />
      <div className="splash-scanline" aria-hidden />

      <div className="splash-perf splash-perf--left" aria-hidden />
      <div className="splash-perf splash-perf--right" aria-hidden />

      <div className={clsx('splash-panel', exiting && 'splash-panel--exit')}>
        <div className="splash-logo-ring" aria-hidden>
          <div className="splash-logo-orbit" />
        </div>

        <header className="splash-header">
          <div className="flex items-center justify-center gap-2.5 mb-1">
            <Film className="text-[var(--gold)]" size={26} strokeWidth={1.5} />
            <h1 className="font-display text-3xl tracking-wide gold-gradient">
              CinematicAI
            </h1>
          </div>
          <p className="text-[10px] uppercase tracking-[0.35em] text-[var(--text3)] text-center">
            Studio · Director Edition
          </p>
        </header>

        <div className="splash-progress-block">
          <div className="flex justify-between text-[10px] text-[var(--text3)] mb-2 font-mono">
            <span>Avvio sistema</span>
            <span className="text-[var(--gold)] tabular-nums">{Math.round(progress)}%</span>
          </div>
          <div className="splash-progress-track">
            <div
              className="splash-progress-fill"
              style={{ width: `${progress}%` }}
            />
            <div
              className="splash-progress-glow"
              style={{ left: `calc(${progress}% - 12px)` }}
            />
          </div>
        </div>

        <ul className="splash-steps">
          {BOOTSTRAP_STEPS.map((def, i) => {
            const st = steps[def.id] || { status: 'pending', message: '' }
            return (
              <li
                key={def.id}
                className={clsx(
                  'splash-step splash-step--visible',
                  st.status === 'active' && 'splash-step--active',
                  st.status === 'done' && 'splash-step--done',
                  st.status === 'pending' && 'splash-step--pending',
                )}
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <StepIcon status={st.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-[var(--text)]">{def.label}</div>
                  <div className="text-[10px] text-[var(--text3)] truncate">
                    {st.message || def.detail}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>

        {criticalError && (
          <div className="splash-error">
            <p className="text-xs text-[var(--red)]">{criticalError}</p>
            {onEnterAnyway && (
              <button type="button" className="splash-enter-btn mt-2" onClick={onEnterAnyway}>
                Continua comunque
              </button>
            )}
          </div>
        )}

        <footer className="splash-footer flex-col gap-2">
          <div className="flex items-center justify-center gap-2">
            <span className="splash-footer-dot" />
            Pipeline LLM · ComfyUI · FFmpeg
          </div>
          {showSkip && onSkip && !exiting && (
            <button type="button" className="splash-enter-btn" onClick={onSkip}>
              Salta intro e apri l&apos;app
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
