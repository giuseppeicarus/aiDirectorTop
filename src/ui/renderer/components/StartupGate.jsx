import clsx from 'clsx'
import { useAppBootstrap } from '../hooks/useAppBootstrap'
import SplashScreen from './SplashScreen'

/**
 * Wrapper isolato per splash + bootstrap.
 * Separato da App.jsx così HMR non altera l'ordine degli hook in App.
 */
export default function StartupGate({ children }) {
  const {
    steps,
    progress,
    phase,
    showApp,
    showSplash,
    criticalError,
    skip,
    enterApp,
  } = useAppBootstrap()

  return (
    <div className="app-shell h-screen w-screen overflow-hidden bg-[var(--bg0)]">
      {showSplash && (
        <SplashScreen
          steps={steps}
          progress={progress}
          phase={phase}
          criticalError={criticalError}
          onEnterAnyway={criticalError ? enterApp : undefined}
          onSkip={skip}
        />
      )}

      <div className={clsx('app-main h-full w-full', showApp && 'app-main--visible')}>
        {showApp ? children : null}
      </div>
    </div>
  )
}
