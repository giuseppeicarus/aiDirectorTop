/**
 * Preload — espone i canali IPC al renderer in modo sicuro via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('studio', {
  // Projects
  project: {
    create:     (data)  => ipcRenderer.invoke('project:create', data),
    list:       ()      => ipcRenderer.invoke('project:list'),
    get:        (id)    => ipcRenderer.invoke('project:get', id),
    delete:     (id)    => ipcRenderer.invoke('project:delete', id),
    storyboard: (id)    => ipcRenderer.invoke('project:storyboard', id),
  },

  // LLM
  llm: {
    health: () => ipcRenderer.invoke('llm:health'),
  },

  // ComfyUI
  comfyui: {
    nodes: () => ipcRenderer.invoke('comfyui:nodes'),
  },

  // Pipeline
  pipeline: {
    run:   (req)  => ipcRenderer.invoke('pipeline:run', req),
    state: (id)   => ipcRenderer.invoke('pipeline:state', id),
    reset: (id)   => ipcRenderer.invoke('pipeline:reset', id),
    onProgress: (cb) => {
      ipcRenderer.on('pipeline:progress', (_, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('pipeline:progress')
    },
  },

  // Workflow management
  workflow: {
    list:   ()           => ipcRenderer.invoke('workflow:list'),
    get:    (id)         => ipcRenderer.invoke('workflow:get', id),
    create: (data)       => ipcRenderer.invoke('workflow:create', data),
    save:   (id, data)   => ipcRenderer.invoke('workflow:save', id, data),
    delete: (id)         => ipcRenderer.invoke('workflow:delete', id),
  },

  // Utilities
  backend: {
    url: () => ipcRenderer.invoke('backend:url'),
  },

  // Shell utilities
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  },

  // Frame Cut Optimizer
  frameCut: {
    analyze:        (req)     => ipcRenderer.invoke('frameCutOptimizer:analyze',        req),
    apply:          (req)     => ipcRenderer.invoke('frameCutOptimizer:apply',          req),
    merge:          (req)     => ipcRenderer.invoke('frameCutOptimizer:merge',          req),
    cancel:         (req)     => ipcRenderer.invoke('frameCutOptimizer:cancel',         req),
    getSettings:    ()        => ipcRenderer.invoke('frameCutOptimizer:getSettings'),
    updateSettings: (s)       => ipcRenderer.invoke('frameCutOptimizer:updateSettings', s),
    readFrame:      (p)       => ipcRenderer.invoke('frameCutOptimizer:readFrame',      p),
    checkTools:     (opts)    => ipcRenderer.invoke('frameCutOptimizer:checkTools',     opts),
    cleanupJob:     (req)     => ipcRenderer.invoke('frameCutOptimizer:cleanupJob',     req),
    openVideoFiles: ()        => ipcRenderer.invoke('dialog:openVideoFiles'),
    saveVideoFile:  (opts)    => ipcRenderer.invoke('dialog:saveVideoFile',             opts),
    onProgress: (cb) => {
      ipcRenderer.on('frameCutOptimizer:progress', (_, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('frameCutOptimizer:progress')
    },
  },
})
