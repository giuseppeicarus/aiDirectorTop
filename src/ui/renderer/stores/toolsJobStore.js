import { create } from 'zustand'

export const useToolsJobStore = create((set, get) => ({
  jobs: [],

  addJob(job) {
    set(s => ({ jobs: [job, ...s.jobs] }))
  },

  updateJob(id, patch) {
    set(s => ({ jobs: s.jobs.map(j => j.id === id ? { ...j, ...patch } : j) }))
  },

  clearAll() {
    set({ jobs: [] })
  },
}))
