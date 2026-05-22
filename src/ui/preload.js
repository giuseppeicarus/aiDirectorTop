/**
 * Preload — espone i canali IPC al renderer in modo sicuro via contextBridge.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const BACKEND_PORT = Number(process.env.CINEMATIC_BACKEND_PORT || 8123)
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

contextBridge.exposeInMainWorld('studio', {
  // Projects
  project: {
    create:     (data)  => ipcRenderer.invoke('project:create', data),
    list:       ()      => ipcRenderer.invoke('project:list'),
    get:        (id)    => ipcRenderer.invoke('project:get', id),
    delete:     (id, deleteMedia = false) => ipcRenderer.invoke('project:delete', id, deleteMedia),
    mediaCount: (id)                      => ipcRenderer.invoke('project:media-count', id),
    storyboard: (id)    => ipcRenderer.invoke('project:storyboard', id),
  },

  // LLM
  llm: {
    health: () => ipcRenderer.invoke('llm:health'),
    enhancePrompt: (req) => ipcRenderer.invoke('llm:enhancePrompt', req),
  },

  // ComfyUI
  comfyui: {
    nodes: () => ipcRenderer.invoke('comfyui:nodes'),
  },

  // Pipeline
  pipeline: {
    run:    (req) => ipcRenderer.invoke('pipeline:run', req),
    state:  (id)  => ipcRenderer.invoke('pipeline:state', id),
    reset:  (id)  => ipcRenderer.invoke('pipeline:reset', id),
    stop:       (id)          => ipcRenderer.invoke('pipeline:stop', id),
    pause:      (id)          => ipcRenderer.invoke('pipeline:pause', id),
    resume:     (id)          => ipcRenderer.invoke('pipeline:resume', id),
    resetFrom:  (id, stage)   => ipcRenderer.invoke('pipeline:resetFrom', id, stage),
    thumbnails: (req) => ipcRenderer.invoke('pipeline:thumbnails', req),
    onProgress: (cb) => {
      ipcRenderer.on('pipeline:progress', (_, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('pipeline:progress')
    },
    onThumbnailProgress: (cb) => {
      ipcRenderer.on('pipeline:thumbnail-progress', (_, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('pipeline:thumbnail-progress')
    },
  },

  // Workflow management
  workflow: {
    list:       ()              => ipcRenderer.invoke('workflow:list'),
    get:        (id)            => ipcRenderer.invoke('workflow:get', id),
    create:     (data)          => ipcRenderer.invoke('workflow:create', data),
    save:       (id, data)      => ipcRenderer.invoke('workflow:save', id, data),
    delete:     (id)            => ipcRenderer.invoke('workflow:delete', id),
    exportJson: (id, json)      => ipcRenderer.invoke('workflow:export-json', id, json),
  },

  // Utilities
  backend: {
    url: () => ipcRenderer.invoke('backend:url'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    close: () => ipcRenderer.invoke('window:close'),
    onMaximizedChange: (cb) => {
      const handler = (_, value) => cb(Boolean(value))
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
  },

  // Tools (standalone generation)
  tools: {
    run:     (req)  => ipcRenderer.invoke('tools:run', req),
    enhance: (req)  => ipcRenderer.invoke('tools:enhance', req),
    upload:  (path) => ipcRenderer.invoke('tools:upload', path),
    media:   ()     => ipcRenderer.invoke('tools:media'),
    pickImage: ()   => ipcRenderer.invoke('dialog:openImageFile'),
    pickAudio: ()   => ipcRenderer.invoke('dialog:openAudioFile'),
    onProgress: (cb) => {
      ipcRenderer.on('tools:progress', (_, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('tools:progress')
    },
  },

  // Media library upload from local path
  media: {
    upload: (filePath, opts) => ipcRenderer.invoke('media:uploadFile', filePath, opts),
    saveAs: (filepath, filename) => ipcRenderer.invoke('media:saveAs', filepath, filename),
  },

  // Director Cinema
  director: {
    pickImage:    ()          => ipcRenderer.invoke('dialog:openImageFile'),
    pickAudio:    ()          => ipcRenderer.invoke('dialog:openAudioFile'),
    uploadMedia:  (filePath, opts) => ipcRenderer.invoke('media:uploadFile', filePath, opts),
    getWorkflows: ()          => ipcRenderer.invoke('director:workflows'),
    enhance:      (req)       => ipcRenderer.invoke('director:enhance', req),
    generate: (params, onProgress) => {
      const listener = (_, data) => onProgress(data)
      ipcRenderer.on('director:progress', listener)
      return ipcRenderer.invoke('director:generate', params).finally(() => {
        ipcRenderer.removeListener('director:progress', listener)
      })
    },
  },

  // CreateReel — brief + reference images + vision LLM
  reel: {
    pickImages:      ()              => ipcRenderer.invoke('reel:pickImages'),
    pickAudio:       ()              => ipcRenderer.invoke('reel:pickAudio'),
    analyzeAudio:    (req)           => ipcRenderer.invoke('reel:analyzeAudio', req),
    copyReferenceFiles: (paths, catalogProjectId) =>
      ipcRenderer.invoke('reel:copyReferenceFiles', paths, catalogProjectId),
    saveReferenceBlob: (payload) =>
      ipcRenderer.invoke('reel:saveReferenceBlob', payload),
    readImageLocal:  (path)          => ipcRenderer.invoke('trailer:readImageLocal', path),
    fetchImageUrl:   (url)           => ipcRenderer.invoke('trailer:fetchImageUrl', url),
    projectStorage:  (projectId)     => ipcRenderer.invoke('reel:projectStorage', projectId),
    audioStreamUrl: (path)          => path
      ? `${BACKEND_ORIGIN}/api/reel/source?path=${encodeURIComponent(path)}`
      : null,
    generate: (params, onProgress) => {
      const listener = (_, data) => onProgress(data)
      ipcRenderer.on('reel:progress', listener)
      return ipcRenderer.invoke('reel:generate', params).finally(() => {
        ipcRenderer.removeListener('reel:progress', listener)
      })
    },
  },

  // Trailer Generator
  trailer: {
    pickAudio:       ()              => ipcRenderer.invoke('trailer:pickAudio'),
    analyze:         (req)           => ipcRenderer.invoke('trailer:analyze', req),
    readAudioBuffer: (path)          => ipcRenderer.invoke('trailer:readAudioBuffer', path),
    readImageLocal:  (path)          => ipcRenderer.invoke('trailer:readImageLocal', path),
    fetchImageUrl:   (url)           => ipcRenderer.invoke('trailer:fetchImageUrl', url),
    projectStorage:  (projectId)     => ipcRenderer.invoke('trailer:projectStorage', projectId),
    audioStreamUrl: (path)          => path
      ? `${BACKEND_ORIGIN}/api/trailer/source?path=${encodeURIComponent(path)}`
      : null,
    generate: (params, onProgress) => {
      const listener = (_, data) => onProgress(data)
      ipcRenderer.on('trailer:progress', listener)
      return ipcRenderer.invoke('trailer:generate', params).finally(() => {
        ipcRenderer.removeListener('trailer:progress', listener)
      })
    },
  },

  // Impostazioni — script modelli ComfyUI
  settings: {
    downloadComfyModelScript: (scriptId) =>
      ipcRenderer.invoke('settings:downloadComfyModelScript', scriptId),
  },

  // Shell utilities
  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    /** Percorso assoluto da File (drag-drop / input); Electron 32+ non espone più file.path. */
    pathFromFile: (file) => {
      if (!file) return null
      try {
        const p = webUtils.getPathForFile(file)
        if (p) return p
      } catch { /* ignore */ }
      return file.path || null
    },
  },

  // Native notifications (Electron Notification API, più affidabile su Windows)
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),

  /** Ascolta tutti i canali progress (pipeline, reel, trailer, …) per il banner attività globale. */
  activity: {
    onEvent: (cb) => {
      const channels = [
        'pipeline:progress',
        'reel:progress',
        'trailer:progress',
        'director:progress',
        'tools:progress',
        'frameCutOptimizer:progress',
      ]
      const handlers = channels.map((channel) => {
        const fn = (_, data) => cb(channel, data)
        ipcRenderer.on(channel, fn)
        return [channel, fn]
      })
      return () => {
        for (const [channel, fn] of handlers) {
          ipcRenderer.removeListener(channel, fn)
        }
      }
    },
  },

  // Obsidian vault + Docker
  obsidian: {
    status:       ()        => ipcRenderer.invoke('obsidian:status'),
    dockerStart:  ()        => ipcRenderer.invoke('obsidian:dockerStart'),
    dockerStop:   ()        => ipcRenderer.invoke('obsidian:dockerStop'),
    syncProject:  (req)     => ipcRenderer.invoke('obsidian:syncProject', req),
    search:       (req)     => ipcRenderer.invoke('obsidian:search', req),
    context:      (req)     => ipcRenderer.invoke('obsidian:context', req),
    openWeb:      (url)     => ipcRenderer.invoke('obsidian:openWeb', url),
    openFolder:   (p)       => ipcRenderer.invoke('shell:openPath', p),
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
