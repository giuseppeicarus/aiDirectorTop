import { create } from 'zustand'

import { useGlobalActivityStore } from './globalActivityStore'

export { useGlobalActivityStore }

// ── Project Store ─────────────────────────────────────────────────────────────
export const useProjectStore = create((set, get) => ({
  projects: [],
  currentProject: null,
  currentStoryboard: null,
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await window.studio.project.list()
      set({ projects, loading: false })
    } catch (e) {
      set({ error: e.message, loading: false })
    }
  },

  loadProject: async (id) => {
    set({ loading: true, error: null })
    try {
      const [project, storyboard] = await Promise.allSettled([
        window.studio.project.get(id),
        window.studio.project.storyboard(id),
      ])
      set({
        currentProject:    project.status === 'fulfilled' ? project.value : null,
        currentStoryboard: storyboard.status === 'fulfilled' ? storyboard.value : null,
        loading: false,
      })
    } catch (e) {
      set({ error: e.message, loading: false })
    }
  },

  createProject: async (data) => {
    set({ loading: true, error: null })
    try {
      const project = await window.studio.project.create(data)
      set(s => ({ projects: [project, ...s.projects], currentProject: project, loading: false }))
      return project
    } catch (e) {
      set({ error: e.message, loading: false })
      throw e
    }
  },

  deleteProject: async (id, deleteMedia = false) => {
    await window.studio.project.delete(id, deleteMedia)
    set(s => ({ projects: s.projects.filter(p => p.id !== id) }))
  },

  setStoryboard: (storyboard) => set({ currentStoryboard: storyboard }),
  clearCurrent:  ()           => set({ currentProject: null, currentStoryboard: null }),
}))

// ── Pipeline Store ────────────────────────────────────────────────────────────
let _evtCounter = 0

export const usePipelineStore = create((set, get) => ({
  stage: 'idle',
  paused: false,
  totalProgress: 0,
  stageProgress: 0,
  message: '',
  logs: [],
  events: [],           // rich event objects
  currentLLM: null,     // { role, label, provider, model, description } — active LLM
  frames: {},
  clips: {},
  finalVideoPath: null,
  error: null,

  startPipeline: async (req) => {
    if (req?.project_id) {
      useGlobalActivityStore.getState().setProjectHint(req.project_id, req.title || req.project_id)
    }
    set({
      stage: 'story_analysis',
      paused: false,
      totalProgress: 0,
      logs: [],
      events: [],
      currentLLM: null,
      frames: {},
      clips: {},
      error: null,
      finalVideoPath: null,
    })

    const sendNotify = (title, body) => {
      if (window.studio?.notify) {
        window.studio.notify(title, body).catch(() => {})
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(title, { body })
      }
    }

    const cleanup = window.studio.pipeline.onProgress((data) => {
      if (data.done) {
        set({ stage: 'done', totalProgress: 1, currentLLM: null, paused: false })
        sendNotify('CinematicAI Studio', 'Pipeline completata con successo!')
        cleanup()
        return
      }
      if (data.stopped) {
        set({ stage: 'idle', currentLLM: null, paused: false })
        get().addLog('Pipeline interrotta dall\'utente')
        sendNotify('CinematicAI Studio', 'Pipeline interrotta')
        cleanup()
        return
      }
      if (data.error) {
        set({ stage: 'error', error: data.error, currentLLM: null, paused: false })
        get().addLog(`ERRORE: ${data.error}`)
        sendNotify('CinematicAI Studio', `Errore pipeline: ${data.error}`)
        cleanup()
        return
      }

      const eventType = data.event_type || 'progress'
      const extra     = data.extra || {}
      const evt = {
        id:         ++_evtCounter,
        time:       new Date().toLocaleTimeString(),
        event_type: eventType,
        stage:      data.stage,
        message:    data.message,
        extra,
      }

      // llm_thinking events: replace previous one for this stage (update in-place)
      set(s => {
        let events
        if (eventType === 'llm_thinking') {
          events = [
            ...s.events.filter(e => !(e.event_type === 'llm_thinking' && e.stage === data.stage)),
            evt,
          ]
        } else {
          events = [...s.events.slice(-800), evt]
        }

        const update = {
          stage:         data.stage,
          totalProgress: data.total_progress,
          stageProgress: data.stage_progress,
          message:       data.message,
          events,
        }

        if (eventType === 'llm_prompt' && extra.provider) {
          update.currentLLM = extra
        }
        if (eventType === 'stage_complete') {
          update.currentLLM = null
        }
        if (eventType === 'paused') {
          update.paused = true
        }
        if (eventType === 'resumed') {
          update.paused = false
        }
        if (eventType === 'stopped') {
          update.paused = false
        }

        if (data.artifact_path && data.shot_id) {
          if (data.stage === 'frame_gen') {
            const isFirst = data.message?.includes('first')
            const frames = { ...s.frames }
            frames[data.shot_id] = {
              ...frames[data.shot_id],
              [isFirst ? 'first' : 'last']: data.artifact_path,
            }
            update.frames = frames
          }
          if (data.stage === 'video_gen') {
            update.clips = { ...s.clips, [data.shot_id]: data.artifact_path }
          }
        }
        if (data.stage === 'assembly' && data.artifact_path) {
          update.finalVideoPath = data.artifact_path
        }

        return update
      })

      if (eventType !== 'llm_thinking') {
        get().addLog(data.message)
      }
    })

    try {
      await window.studio.pipeline.run(req)
    } catch (e) {
      set({ stage: 'error', error: e.message, currentLLM: null })
      cleanup()
    }
  },

  resetPipeline: async (projectId) => {
    await window.studio.pipeline.reset(projectId)
    set({ stage: 'idle', paused: false, totalProgress: 0, logs: [], events: [], currentLLM: null, frames: {}, clips: {}, error: null })
  },

  resetPipelineFrom: async (projectId, stage) => {
    const result = await window.studio.pipeline.resetFrom(projectId, stage)
    set({ stage: 'idle', paused: false, totalProgress: 0, logs: [], events: [], currentLLM: null, frames: {}, clips: {}, error: null })
    return result
  },

  stopPipeline: async (projectId) => {
    try { await window.studio.pipeline.stop(projectId) } catch { /* already stopped */ }
  },

  pausePipeline: async (projectId) => {
    await window.studio.pipeline.pause(projectId)
    set({ paused: true })
  },

  resumePipeline: async (projectId) => {
    await window.studio.pipeline.resume(projectId)
    set({ paused: false })
  },

  addLog: (msg) => set(s => ({
    logs: [...s.logs.slice(-300), { time: new Date().toLocaleTimeString(), msg }],
  })),
}))

// ── Config Store ──────────────────────────────────────────────────────────────
export const useConfigStore = create((set) => ({
  nodes: [],
  llmStatus: null,

  loadNodes: async () => {
    try {
      const nodes = await window.studio.comfyui.nodes()
      set({ nodes })
    } catch { set({ nodes: [] }) }
  },

  checkLLM: async () => {
    try {
      const status = await window.studio.llm.health()
      set({ llmStatus: status })
    } catch (e) {
      set({ llmStatus: { ok: false, error: e.message } })
    }
  },
}))
