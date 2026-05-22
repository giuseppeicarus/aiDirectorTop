import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BACKEND_ORIGIN } from '../utils/mediaUrl'

/**
 * Apre un job quando l'URL contiene ?job=<job_id> (link da notifiche attività).
 */
export function useJobQueryDeepLink({ catalogProjectId, apiPrefix, onOpenJob }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const openedRef = useRef(null)

  useEffect(() => {
    const jobId = searchParams.get('job')
    if (!jobId || !onOpenJob) return
    if (openedRef.current === jobId) return
    openedRef.current = jobId

    let cancelled = false
    ;(async () => {
      try {
        let job = null
        const detailUrl = `${BACKEND_ORIGIN}/api/${apiPrefix}/jobs/${encodeURIComponent(catalogProjectId)}/${encodeURIComponent(jobId)}`
        const res = await fetch(detailUrl)
        if (res.ok) {
          job = await res.json()
        } else {
          const listRes = await fetch(
            `${BACKEND_ORIGIN}/api/${apiPrefix}/jobs?project_id=${encodeURIComponent(catalogProjectId)}`,
          )
          if (listRes.ok) {
            const data = await listRes.json()
            const list = Array.isArray(data) ? data : (data.jobs || [])
            job = list.find(j => j.job_id === jobId)
          }
        }
        if (job && !cancelled) {
          await onOpenJob(job)
          setSearchParams({}, { replace: true })
        }
      } catch {
        /* ignore */
      }
    })()

    return () => { cancelled = true }
  }, [searchParams, catalogProjectId, apiPrefix, onOpenJob, setSearchParams])
}
