import { useEffect, useRef } from 'react'
import { useGlobalActivityStore } from '../stores/globalActivityStore'
import { BACKEND_ORIGIN } from '../utils/apiClient'

const API = `${BACKEND_ORIGIN}/api`
const POLL_MS = 12000

export function useCharacterTrainingMonitor() {
  const storeRef = useRef(useGlobalActivityStore.getState())
  useEffect(() => {
    const unsub = useGlobalActivityStore.subscribe(s => { storeRef.current = s })
    return unsub
  }, [])

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(`${API}/characters/active-trainings`, { cache: 'no-store' })
        if (!res.ok || cancelled) return
        const list = await res.json()

        // Remove stale character training tasks that are no longer active
        const store = storeRef.current
        const existingKeys = Object.keys(store.tasks).filter(k => k.startsWith('character:training:'))
        const activeIds = new Set(list.map(t => `character:training:${t.character_id}`))
        existingKeys.forEach(k => {
          if (!activeIds.has(k)) {
            useGlobalActivityStore.setState(s => {
              const tasks = { ...s.tasks }
              delete tasks[k]
              return { tasks }
            })
          }
        })

        // Inject / update active training tasks (only truly running ones)
        list.filter(t => t.is_running).forEach(t => {
          const etaStr = t.eta_seconds != null ? formatEta(t.eta_seconds) : null
          const pct = Math.round(t.percent)
          const msg = `Training ${t.name} — step ${t.current_step}/${t.total_steps}${etaStr ? ` — ETA ${etaStr}` : ''}`

          useGlobalActivityStore.setState(s => ({
            tasks: {
              ...s.tasks,
              [`character:training:${t.character_id}`]: {
                id: `character:training:${t.character_id}`,
                channel: 'character:training',
                kind: 'work',
                source: 'LoRA Training',
                message: msg,
                pct,
                active: true,
                nav: { path: `/characters/${t.character_id}` },
                updatedAt: Date.now(),
              },
            },
          }))
        })
      } catch (_) {
        // Swallow network errors — backend may be restarting
      }
    }

    poll()
    const id = setInterval(poll, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])
}

function formatEta(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return `${h}h ${m}min`
}
