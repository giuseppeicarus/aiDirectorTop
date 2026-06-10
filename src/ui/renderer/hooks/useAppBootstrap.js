import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, waitForBackend, BACKEND_PORT, BACKEND_ROOT } from '../utils/apiClient'

const MIN_SPLASH_MS = 2200
const STEP_DELAY_MS = 200
const BOOTSTRAP_MAX_MS = 28000
const EXIT_MS = 780

export const BOOTSTRAP_STEPS = [
  { id: 'ui',       label: 'Interfaccia cinematografica',   detail: 'Inizializzazione renderer e risorse UI' },
  { id: 'backend',  label: 'Motore Python',                detail: `Connessione al backend FastAPI :${BACKEND_PORT}` },
  { id: 'database', label: 'Database e configurazione',    detail: 'SQLite, percorsi progetto e impostazioni' },
  { id: 'llm',      label: 'Provider intelligenza artificiale', detail: 'Verifica LLM globale e ruoli pipeline' },
  { id: 'comfyui',  label: 'Nodi ComfyUI',                 detail: 'Pool GPU e workflow di generazione' },
  { id: 'workspace', label: 'Workspace di produzione',   detail: 'Finalizzazione ambienti di lavoro' },
]

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label} — timeout (${Math.round(ms / 1000)}s)`)
    }),
  ])
}

function initStepState() {
  return Object.fromEntries(BOOTSTRAP_STEPS.map((s) => [s.id, { status: 'pending', message: '' }]))
}

export function useAppBootstrap() {
  const [steps, setSteps] = useState(initStepState)
  const [progress, setProgress] = useState(0)
  const [phase, setPhase] = useState('loading')
  const [criticalError, setCriticalError] = useState(null)
  const [view, setView] = useState('splash')

  const timersRef = useRef({ exit: null, max: null, transitionStarted: false })

  const enterApp = useCallback(() => {
    if (timersRef.current.transitionStarted) return
    timersRef.current.transitionStarted = true
    setPhase('exiting')
    setView('exiting')
    if (timersRef.current.exit) clearTimeout(timersRef.current.exit)
    timersRef.current.exit = setTimeout(() => {
      setView('app')
      setPhase('done')
    }, EXIT_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (timersRef.current.exit) clearTimeout(timersRef.current.exit)
      if (timersRef.current.max) clearTimeout(timersRef.current.max)
    }
  }, [])

  useEffect(() => {
    let alive = true

    const patch = (id, patchData) => {
      if (!alive) return
      setSteps((prev) => ({ ...prev, [id]: { ...prev[id], ...patchData } }))
    }

    const setProg = (n) => {
      if (alive) setProgress(Math.min(100, Math.max(0, n)))
    }

    async function runStep(id, fn) {
      patch(id, { status: 'active', message: '' })
      await delay(STEP_DELAY_MS)
      if (!alive) return
      try {
        const msg = await fn()
        if (!alive) return
        patch(id, { status: 'done', message: msg || 'Completato' })
      } catch (e) {
        if (!alive) return
        patch(id, { status: 'error', message: e?.message || String(e) })
        throw e
      }
    }

    async function runOptionalStep(id, fn, timeoutMs = 12000) {
      patch(id, { status: 'active', message: '' })
      await delay(STEP_DELAY_MS)
      if (!alive) return
      try {
        const msg = await withTimeout(fn(), timeoutMs, BOOTSTRAP_STEPS.find((s) => s.id === id)?.label || id)
        if (!alive) return
        patch(id, { status: 'done', message: msg || 'Completato' })
      } catch (e) {
        if (!alive) return
        patch(id, {
          status: 'warn',
          message: e?.message || 'Non disponibile — continua in modalità limitata',
        })
      }
    }

    let finished = false
    timersRef.current.max = setTimeout(() => {
      if (!alive || finished) return
      finished = true
      setCriticalError((prev) => prev || 'Avvio prolungato — accesso all\'app sbloccato')
      enterApp()
    }, BOOTSTRAP_MAX_MS)

    ;(async () => {
      const t0 = Date.now()
      let fatal = null

      try {
        await runStep('ui', async () => {
          setProg(8)
          await delay(280)
          return 'Componenti React pronti'
        })

        await runStep('backend', async () => {
          setProg(22)
          const ok = await waitForBackend(20000)
          if (!ok) {
            const hint = import.meta.env.DEV ? ' — avvia npm run dev' : ' — riavvia l\'applicazione'
            throw new Error(`Backend non raggiungibile${hint}`)
          }
          return 'Backend online'
        })

        await runStep('database', async () => {
          setProg(40)
          const r = await withTimeout(
            fetch(`${BACKEND_ROOT}/health`, { cache: 'no-store' }),
            8000,
            'Database',
          )
          if (!r.ok) throw new Error('Health check fallito')
          const h = await r.json()
          return h?.version ? `v${h.version}` : 'Sistema operativo'
        })

        await runOptionalStep('llm', async () => {
          setProg(58)
          const h = await apiGet('/llm/health', { retries: 1, timeoutMs: 15000 })
          if (!h?.ok) throw new Error(h?.error || 'LLM non configurato')
          const m = h.model ? ` · ${h.model}` : ''
          return `${h.provider || 'LLM'} connesso${m}`
        }, 18000)

        await runOptionalStep('comfyui', async () => {
          setProg(76)
          const nodes = await apiGet('/comfyui/nodes', { retries: 1, timeoutMs: 10000 })
          const list = Array.isArray(nodes) ? nodes : nodes?.nodes || []
          const online = list.filter((n) => n.online).length
          if (!list.length) return 'Nessun nodo configurato'
          return `${online}/${list.length} nodi online`
        }, 12000)

        await runStep('workspace', async () => {
          setProg(94)
          await delay(300)
          setProg(100)
          return 'Pronto per la regia'
        })
      } catch (e) {
        fatal = e?.message || 'Avvio non riuscito'
        if (alive) {
          setCriticalError(fatal)
          setProg((p) => Math.max(p, 15))
        }
      }

      const elapsed = Date.now() - t0
      if (elapsed < MIN_SPLASH_MS) await delay(MIN_SPLASH_MS - elapsed)

      if (timersRef.current.max) clearTimeout(timersRef.current.max)
      if (!alive) return

      if (!fatal) {
        finished = true
        enterApp()
      }
    })()

    return () => {
      alive = false
      if (timersRef.current.max) clearTimeout(timersRef.current.max)
    }
  }, [enterApp])

  return {
    steps,
    progress,
    phase,
    view,
    showApp: view === 'app',
    showSplash: view !== 'app',
    criticalError,
    skip: enterApp,
    enterApp,
    stepDefs: BOOTSTRAP_STEPS,
  }
}
