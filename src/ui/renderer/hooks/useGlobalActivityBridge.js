import { useEffect } from 'react'
import { useGlobalActivityStore } from '../stores/globalActivityStore'

const CHANNELS = [
  'pipeline:progress',
  'reel:progress',
  'trailer:progress',
  'director:progress',
  'tools:progress',
  'frameCutOptimizer:progress',
]

/**
 * Ascolta tutti i canali progress IPC e alimenta il banner globale.
 */
export function useGlobalActivityBridge() {
  const ingest = useGlobalActivityStore(s => s.ingest)

  useEffect(() => {
    const unsub = window.studio?.activity?.onEvent?.((channel, data) => {
      ingest(channel, data)
    })
    return () => unsub?.()
  }, [ingest])
}
