import { useEffect, useRef } from 'react'
import { BACKEND_ORIGIN } from '../utils/apiClient'

function buildReconcileUrl(kind, { catalogProjectId, jobId, projectId }) {
  const enc = encodeURIComponent
  switch (kind) {
    case 'reel':
      return `${BACKEND_ORIGIN}/api/reel/jobs/${enc(catalogProjectId)}/${enc(jobId)}/reconcile?storyboard=true&hd_frames=true&videos=true`
    case 'trailer':
      return `${BACKEND_ORIGIN}/api/trailer/jobs/${enc(catalogProjectId)}/${enc(jobId)}/reconcile?storyboard=true&hd_frames=true&videos=true`
    case 'cinematic':
      return `${BACKEND_ORIGIN}/api/pipeline/${enc(projectId || catalogProjectId)}/reconcile?frames=true&videos=true`
    default:
      return null
  }
}

/**
 * Polling reconcile: recupera immagini/video da disco e history ComfyUI.
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {'reel'|'trailer'|'cinematic'} opts.kind
 * @param {string} [opts.catalogProjectId]
 * @param {string} [opts.jobId]
 * @param {string} [opts.projectId] — cinematic
 * @param {string} opts.stuckKey — cambia quando serve nuovo reconcile
 * @param {boolean} [opts.alwaysPoll] — anche senza stuckKey (job interrotto)
 * @param {(data: object) => void} opts.onResult
 * @param {(msg: string) => void} [opts.onLog]
 * @param {number} [opts.intervalMs]
 */
export function useMediaReconcile({
  enabled = true,
  kind,
  catalogProjectId,
  jobId,
  projectId,
  stuckKey = '',
  alwaysPoll = false,
  onResult,
  onLog,
  intervalMs = 30000,
}) {
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    const pid = projectId || catalogProjectId
    const needsPoll = enabled && pid && (jobId || kind === 'cinematic') && (stuckKey || alwaysPoll)
    if (!needsPoll) return undefined

    const url = buildReconcileUrl(kind, { catalogProjectId, jobId, projectId: pid })
    if (!url) return undefined

    let cancelled = false

    async function run() {
      try {
        const res = await fetch(url, { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (cancelled || !data.ok) return
        onResultRef.current?.(data)
      } catch {
        /* retry */
      }
    }

    run()
    const iv = setInterval(run, intervalMs)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [
    enabled,
    kind,
    catalogProjectId,
    jobId,
    projectId,
    stuckKey,
    alwaysPoll,
    intervalMs,
  ])
}

/**
 * Reconcile singolo job Director Cinema (POST body).
 */
export function useDirectorMediaReconcile({
  enabled,
  jobId,
  filenamePrefix,
  onResult,
  intervalMs = 30000,
}) {
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    if (!enabled || !jobId) return undefined

    let cancelled = false

    async function run() {
      try {
        const res = await fetch(`${BACKEND_ORIGIN}/api/director/reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: jobId,
            filename_prefix: filenamePrefix || undefined,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled || !data.ok) return
        onResultRef.current?.(data)
      } catch {
        /* retry */
      }
    }

    run()
    const iv = setInterval(run, intervalMs)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [enabled, jobId, filenamePrefix, intervalMs])
}
