import { create } from 'zustand'
import { parseGlobalActivity } from '../utils/globalActivityMessages'

export const useGlobalActivityStore = create((set, get) => ({
  tasks: {},
  projectHints: {},

  setProjectHint(projectId, title) {
    if (!projectId && !title) return
    set(s => ({
      projectHints: {
        ...s.projectHints,
        [String(projectId)]: title || projectId,
      },
    }))
  },

  ingest(channel, data) {
    const id = `${channel}:${data?.job_id || data?.project_id || data?.storage_project_id
      || data?.catalog_project_id || data?.extra?.project_id || 'default'}`
    const prev = get().tasks[id]

    const enriched = { ...data }
    if (!enriched.job_id && prev?.jobId) enriched.job_id = prev.jobId
    if (!enriched.catalog_project_id && prev?.catalogProjectId) {
      enriched.catalog_project_id = prev.catalogProjectId
    }
    const pid = data?.project_id || data?.extra?.project_id
    if (pid && !enriched.title) {
      const hint = get().projectHints[String(pid)]
      if (hint) enriched.title = hint
    }

    const parsed = parseGlobalActivity(channel, enriched)
    if (parsed.clear) {
      set(s => {
        const tasks = { ...s.tasks }
        delete tasks[parsed.id]
        return { tasks }
      })
      return
    }
    if (!parsed.active || !parsed.message) return

    set(s => ({
      tasks: {
        ...s.tasks,
        [parsed.id]: {
          ...parsed,
          channel,
          updatedAt: Date.now(),
        },
      },
    }))
  },

  clearAll() {
    set({ tasks: {} })
  },
}))
