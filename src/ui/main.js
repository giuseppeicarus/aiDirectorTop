/**
 * CinematicAI Studio — Electron Main Process
 * Gestisce la finestra, il backend Python e i canali IPC.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const log = require('electron-log')
const { registerFrameCutOptimizerHandlers } = require('./ipc/frameCutOptimizer.ipc')

log.initialize()
log.transports.file.level = 'info'

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const BACKEND_PORT = 8765
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`

let mainWindow = null
let backendProcess = null

// ── Backend Python ────────────────────────────────────────────────────────────

function _findPythonExe() {
  const fs = require('fs')
  const candidates = process.platform === 'win32'
    ? [
        path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe'),
        'E:\\Programmi\\anaconda3\\python.exe',
        'python',
      ]
    : [
        path.join(__dirname, '..', '..', 'venv', 'bin', 'python'),
        'python3',
        'python',
      ]
  for (const c of candidates) {
    if (c === 'python' || c === 'python3') return c   // rely on PATH
    if (fs.existsSync(c)) return c
  }
  return 'python'
}

function startBackend() {
  const backendDir = isDev
    ? path.join(__dirname, '..', '..')
    : path.join(process.resourcesPath, 'backend')

  const exeName = process.platform === 'win32' ? 'cinematic_backend.exe' : 'cinematic_backend'
  const pythonExe = isDev
    ? _findPythonExe()
    : path.join(backendDir, 'cinematic_backend', exeName)

  const args = isDev
    ? ['-m', 'uvicorn', 'src.core.main:app', '--port', String(BACKEND_PORT), '--host', '127.0.0.1', '--workers', '1']
    : []

  log.info('Starting backend', { pythonExe, args, cwd: backendDir })

  backendProcess = spawn(pythonExe, args, {
    cwd: isDev ? path.join(__dirname, '..', '..') : backendDir,
    env: { ...process.env },
  })

  backendProcess.stdout.on('data', (d) => log.info('[backend]', d.toString().trim()))
  backendProcess.stderr.on('data', (d) => log.warn('[backend]', d.toString().trim()))
  backendProcess.on('error', (err) => log.error('[backend] spawn error', err.message))
  backendProcess.on('exit', (code) => log.info('Backend exited', { code }))
}

async function waitForBackend(maxMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${BACKEND_URL}/health`)
      if (r.ok) return true
    } catch { /* not ready yet */ }
    await new Promise(res => setTimeout(res, 400))
  }
  return false
}

// ── Window ────────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5300')
    mainWindow.webContents.openDevTools()
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../../dist-renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers() {

  // Proxy generico verso il backend FastAPI
  async function apiCall(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    }
    if (body) opts.body = JSON.stringify(body)
    const r = await fetch(`${BACKEND_URL}${path}`, opts)
    if (!r.ok) {
      const err = await r.text()
      throw new Error(err)
    }
    return r.json()
  }

  ipcMain.handle('project:create',  (_, data)       => apiCall('POST', '/api/projects/', data))
  ipcMain.handle('project:list',    ()               => apiCall('GET',  '/api/projects/'))
  ipcMain.handle('project:get',     (_, id)          => apiCall('GET',  `/api/projects/${id}`))
  ipcMain.handle('project:delete',      (_, id, deleteMedia = false) => apiCall('DELETE', `/api/projects/${id}?delete_media=${deleteMedia}`))
  ipcMain.handle('project:media-count', (_, id)                      => apiCall('GET',    `/api/projects/${id}/media-count`))
  ipcMain.handle('project:storyboard', async (_, id) => {
    try { return await apiCall('GET', `/api/projects/${id}/storyboard`) }
    catch { return null }
  })

  ipcMain.handle('llm:health',      ()               => apiCall('GET',  '/api/llm/health'))
  ipcMain.handle('comfyui:nodes',   ()               => apiCall('GET',  '/api/comfyui/nodes'))

  ipcMain.handle('config:get',      ()               => apiCall('GET',  '/health')) // placeholder

  // Pipeline con SSE → converte in eventi IPC
  // Usa http.request (nessun body timeout, adatto a stream lunghi con LLM lenti)
  ipcMain.handle('pipeline:run', (event, req) => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(req)
      const options = {
        hostname: '127.0.0.1',   // IPv4 esplicito — evita ECONNRESET su Windows con localhost→IPv6
        port: BACKEND_PORT,
        path: '/api/pipeline/run',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }

      const request = http.request(options, (res) => {
        // Disabilita qualsiasi idle timeout sul socket (LLM può impiegare minuti)
        res.socket && res.socket.setTimeout(0)

        let buf = ''
        res.setEncoding('utf8')

        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (!event.sender.isDestroyed()) event.sender.send('pipeline:progress', data)
              } catch { /* SSE line non valida */ }
            }
            // righe ": heartbeat" vengono ignorate silenziosamente
          }
        })

        res.on('end', () => resolve({ done: true }))
        res.on('error', reject)
      })

      request.on('error', reject)
      request.on('socket', (socket) => socket.setTimeout(0))  // nessun timeout sul socket

      // Abort se la finestra viene chiusa durante l'esecuzione
      event.sender.once('destroyed', () => request.destroy())

      request.write(body)
      request.end()
    })
  })

  ipcMain.handle('pipeline:state',  (_, id)          => apiCall('GET',    `/api/pipeline/${id}/state`))
  ipcMain.handle('pipeline:reset',  (_, id)          => apiCall('DELETE', `/api/pipeline/${id}/state`))
  ipcMain.handle('pipeline:stop',      (_, id)          => apiCall('POST',   `/api/pipeline/${id}/stop`))
  ipcMain.handle('pipeline:pause',     (_, id)          => apiCall('POST',   `/api/pipeline/${id}/pause`))
  ipcMain.handle('pipeline:resume',    (_, id)          => apiCall('POST',   `/api/pipeline/${id}/resume`))
  ipcMain.handle('pipeline:resetFrom', (_, id, stage)   => apiCall('DELETE', `/api/pipeline/${id}/state/from/${stage}`))

  ipcMain.handle('pipeline:thumbnails', (event, req) => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ width: req.width, height: req.height })
      const options = {
        hostname: '127.0.0.1',
        port: BACKEND_PORT,
        path: `/api/pipeline/${req.project_id}/thumbnails`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }
      const request = http.request(options, (res) => {
        res.socket && res.socket.setTimeout(0)
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (!event.sender.isDestroyed()) event.sender.send('pipeline:thumbnail-progress', data)
              } catch {}
            }
          }
        })
        res.on('end', () => resolve({ done: true }))
        res.on('error', reject)
      })
      request.on('error', reject)
      request.on('socket', (socket) => socket.setTimeout(0))
      event.sender.once('destroyed', () => request.destroy())
      request.write(body)
      request.end()
    })
  })

  // ── Workflow management ─────────────────────────────────────────────────────
  ipcMain.handle('workflow:list',   ()               => apiCall('GET',    '/api/workflows'))
  ipcMain.handle('workflow:get',    (_, id)          => apiCall('GET',    `/api/workflows/${id}`))
  ipcMain.handle('workflow:create', (_, data)        => apiCall('POST',   '/api/workflows', data))
  ipcMain.handle('workflow:save',   (_, id, data)    => apiCall('PUT',    `/api/workflows/${id}`, data))
  ipcMain.handle('workflow:delete', (_, id)          => apiCall('DELETE', `/api/workflows/${id}`))
  ipcMain.handle('workflow:export-json', async (_, id, json) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Esporta workflow per ComfyUI',
      defaultPath: `${id}.json`,
      filters: [{ name: 'ComfyUI Workflow JSON', extensions: ['json'] }],
    })
    if (canceled || !filePath) return { saved: false }
    require('fs').writeFileSync(filePath, json, 'utf-8')
    return { saved: true, path: filePath }
  })

  ipcMain.handle('backend:url',     ()               => BACKEND_URL)
  ipcMain.handle('shell:openPath',  (_, p)           => shell.openPath(p))

  // ── Tools ───────────────────────────────────────────────────────────────────
  ipcMain.handle('tools:run', (event, req) => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(req)
      const options = {
        hostname: '127.0.0.1', port: BACKEND_PORT,
        path: '/api/tools/run', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }
      const request = http.request(options, (res) => {
        res.socket && res.socket.setTimeout(0)

        // Se il backend restituisce un errore HTTP, manda un evento error al renderer
        if (res.statusCode !== 200) {
          let errBody = ''
          res.on('data', c => errBody += c)
          res.on('end', () => {
            let msg = `Backend error ${res.statusCode}`
            try { const j = JSON.parse(errBody); msg = j.detail || j.error || msg } catch {}
            if (!event.sender.isDestroyed()) event.sender.send('tools:progress', { error: msg })
            resolve({ done: true })
          })
          return
        }

        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (!event.sender.isDestroyed()) event.sender.send('tools:progress', data)
              } catch {}
            }
          }
        })
        res.on('end', () => resolve({ done: true }))
        res.on('error', reject)
      })
      request.on('error', (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('tools:progress', { error: err.message })
        resolve({ done: true })
      })
      request.on('socket', (s) => s.setTimeout(0))
      event.sender.once('destroyed', () => request.destroy())
      request.write(body); request.end()
    })
  })

  ipcMain.handle('tools:enhance', (_, req) => apiCall('POST', '/api/tools/enhance-prompt', req))
  ipcMain.handle('tools:media', async () => {
    const data = await apiCall('GET', '/api/media/')
    if (Array.isArray(data)) return data
    if (data?.items && Array.isArray(data.items)) return data.items
    return []
  })

  // ── Director Cinema ─────────────────────────────────────────────────────────
  ipcMain.handle('director:workflows', () => apiCall('GET', '/api/workflows').then(m =>
    (m.workflows || []).filter(w => ['director', 'img2video', 'img2video_lastframe', 'img_audio2video'].includes(w.type))
  ))
  ipcMain.handle('director:enhance', (_, req) => apiCall('POST', '/api/director/enhance', req))
  ipcMain.handle('director:generate', (event, params) => {
    return new Promise((resolve) => {
      const body = JSON.stringify(params)
      const options = {
        hostname: '127.0.0.1', port: BACKEND_PORT,
        path: '/api/director/generate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }
      const request = http.request(options, (res) => {
        res.socket && res.socket.setTimeout(0)
        if (res.statusCode !== 200) {
          let errBody = ''
          res.on('data', c => errBody += c)
          res.on('end', () => {
            let msg = `Backend error ${res.statusCode}`
            try { const j = JSON.parse(errBody); msg = j.detail || j.error || msg } catch {}
            if (!event.sender.isDestroyed()) event.sender.send('director:progress', { error: msg })
            resolve({ done: true })
          })
          return
        }
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                if (!event.sender.isDestroyed()) event.sender.send('director:progress', data)
              } catch {}
            }
          }
        })
        res.on('end', () => resolve({ done: true }))
        res.on('error', () => resolve({ done: true }))
      })
      request.on('error', (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('director:progress', { error: err.message })
        resolve({ done: true })
      })
      request.on('socket', (s) => s.setTimeout(0))
      event.sender.once('destroyed', () => request.destroy())
      request.write(body); request.end()
    })
  })

  // ── Trailer Generator ────────────────────────────────────────────────────────
  ipcMain.handle('trailer:pickAudio', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'] }],
    })
    if (canceled || !filePaths.length) return null
    const fs = require('fs')
    const stat = fs.statSync(filePaths[0])
    return { path: filePaths[0], name: path.basename(filePaths[0]), size: stat.size }
  })

  ipcMain.handle('trailer:analyze', (_, req) => apiCall('POST', '/api/trailer/analyze', req))

  ipcMain.handle('trailer:projectStorage', (_, projectId) =>
    apiCall('GET', `/api/trailer/storage/${encodeURIComponent(projectId || 'trailer_standalone')}`),
  )

  ipcMain.handle('trailer:fetchImageUrl', async (_, url) => {
    const http = require('http')
    const https = require('https')
    try {
      if (!url || typeof url !== 'string') {
        return { ok: false, error: 'URL mancante' }
      }
      const parsed = new URL(url)
      const client = parsed.protocol === 'https:' ? https : http
      const buf = await new Promise((resolve, reject) => {
        const req = client.get(url, (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`))
            res.resume()
            return
          }
          const chunks = []
          res.on('data', c => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks)))
        })
        req.on('error', reject)
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')) })
      })
      if (!buf || buf.length < 80) {
        return { ok: false, error: 'Immagine vuota o troppo piccola' }
      }
      const ext = (parsed.pathname.split('.').pop() || 'png').toLowerCase().split('?')[0]
      const mime = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
      }[ext] || 'image/png'
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      log.error('trailer:fetchImageUrl', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('trailer:readImageLocal', async (_, filePath) => {
    const fs = require('fs')
    const nodePath = require('path')
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'File immagine non trovato' }
      }
      const buf = fs.readFileSync(filePath)
      if (buf.length < 80) {
        return { ok: false, error: 'File immagine troppo piccolo' }
      }
      const ext = nodePath.extname(filePath).toLowerCase()
      const mime = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
      }[ext] || 'image/png'
      return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    } catch (err) {
      log.error('trailer:readImageLocal', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('trailer:readAudioBuffer', async (_, filePath) => {
    const fs = require('fs')
    try {
      const buf = fs.readFileSync(filePath)
      // Return base64 string — binary Buffers can lose their backing ArrayBuffer
      // when serialized through contextBridge; base64 strings are always safe.
      return { ok: true, b64: buf.toString('base64'), size: buf.length }
    } catch (err) {
      log.error('trailer:readAudioBuffer', err.message)
      return { ok: false, error: err.message }
    }
  })

  const isTrailerSseTerminal = (data) => {
    if (!data || typeof data !== 'object') return false
    if (data.done || data.error || data.terminal === true) return true
    // Pausa normale: storyboard pronto, approvazione utente
    if (data.event === 'awaiting_storyboard_approval') return true
    return false
  }

  ipcMain.handle('trailer:generate', (event, params) => {
    return new Promise((resolve) => {
      const body = JSON.stringify(params)
      const options = {
        hostname: '127.0.0.1', port: BACKEND_PORT,
        path: '/api/trailer/generate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }
      const request = http.request(options, (res) => {
        res.socket && res.socket.setTimeout(0)
        if (res.statusCode !== 200) {
          let errBody = ''
          res.on('data', c => errBody += c)
          res.on('end', () => {
            let msg = `Backend error ${res.statusCode}`
            try { const j = JSON.parse(errBody); msg = j.detail || j.error || msg } catch {}
            if (!event.sender.isDestroyed()) event.sender.send('trailer:progress', { error: msg })
            resolve({ done: true })
          })
          return
        }
        let buf = ''
        let streamTerminal = false
        res.setEncoding('utf8')
        const flushSseLine = (line) => {
          if (!line.startsWith('data: ')) return
          try {
            const data = JSON.parse(line.slice(6))
            if (isTrailerSseTerminal(data)) streamTerminal = true
            if (!event.sender.isDestroyed()) event.sender.send('trailer:progress', data)
          } catch {}
        }
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) flushSseLine(line)
        })
        res.on('end', () => {
          if (buf.trim()) flushSseLine(buf.trim())
          if (!streamTerminal && !event.sender.isDestroyed()) {
            event.sender.send('trailer:progress', {
              error: 'Connessione al backend interrotta (riavvio server?). Riprendi il job dalla lista.',
            })
          }
          resolve({ done: true })
        })
        res.on('error', (err) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('trailer:progress', { error: err.message || 'Errore di rete' })
          }
          resolve({ done: true })
        })
      })
      request.on('error', (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('trailer:progress', { error: err.message })
        resolve({ done: true })
      })
      request.on('socket', (s) => s.setTimeout(0))
      event.sender.once('destroyed', () => request.destroy())
      request.write(body); request.end()
    })
  })

  const isReelSseTerminal = (data) => {
    if (!data || typeof data !== 'object') return false
    if (data.done || data.error || data.terminal === true) return true
    if (data.event === 'awaiting_storyboard_approval') return true
    return false
  }

  function reelStagedReferencesDir(catalogProjectId = 'reel_standalone') {
    const os = require('os')
    const nodePath = require('path')
    const safeId = String(catalogProjectId || 'reel_standalone').replace(/[^a-zA-Z0-9_-]/g, '_')
    return nodePath.join(os.homedir(), '.cinematic-studio', 'projects', safeId, 'references', 'staged')
  }

  ipcMain.handle('reel:copyReferenceFiles', async (_, paths, catalogProjectId) => {
    const fs = require('fs')
    const nodePath = require('path')
    const refDir = reelStagedReferencesDir(catalogProjectId)
    fs.mkdirSync(refDir, { recursive: true })
    const out = []
    const list = Array.isArray(paths) ? paths : []
    let idx = 0
    for (const raw of list) {
      if (!raw || typeof raw !== 'string') continue
      try {
        if (!fs.existsSync(raw)) {
          log.warn('reel:copyReferenceFiles missing', raw)
          continue
        }
        const ext = nodePath.extname(raw).toLowerCase() || '.png'
        const dest = nodePath.join(refDir, `ref_${Date.now()}_${idx}${ext}`)
        fs.copyFileSync(raw, dest)
        out.push(dest)
        idx += 1
      } catch (err) {
        log.warn('reel:copyReferenceFiles failed', raw, err.message)
      }
    }
    return { paths: out, dir: refDir }
  })

  ipcMain.handle('reel:saveReferenceBlob', async (_, payload) => {
    const fs = require('fs')
    const nodePath = require('path')
    try {
      const dataUrl = payload?.dataUrl || ''
      const comma = dataUrl.indexOf(',')
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
      const buf = Buffer.from(b64, 'base64')
      if (buf.length < 80) {
        return { ok: false, error: 'Immagine troppo piccola' }
      }
      const name = String(payload?.name || 'image.png').replace(/[^\w.\-]+/g, '_')
      const ext = nodePath.extname(name).toLowerCase() || '.png'
      const refDir = reelStagedReferencesDir(payload?.catalogProjectId)
      fs.mkdirSync(refDir, { recursive: true })
      const dest = nodePath.join(refDir, `ref_${Date.now()}${ext}`)
      fs.writeFileSync(dest, buf)
      return { ok: true, path: dest }
    } catch (err) {
      log.error('reel:saveReferenceBlob', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('reel:pickImages', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Immagini di riferimento',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    return canceled ? [] : filePaths
  })

  ipcMain.handle('reel:projectStorage', (_, projectId) =>
    apiCall('GET', `/api/reel/storage/${encodeURIComponent(projectId || 'reel_standalone')}`),
  )

  ipcMain.handle('reel:generate', (event, params) => {
    return new Promise((resolve) => {
      const body = JSON.stringify(params)
      const options = {
        hostname: '127.0.0.1', port: BACKEND_PORT,
        path: '/api/reel/generate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 0,
      }
      const request = http.request(options, (res) => {
        res.socket && res.socket.setTimeout(0)
        if (res.statusCode !== 200) {
          let errBody = ''
          res.on('data', c => { errBody += c })
          res.on('end', () => {
            let msg = `Backend error ${res.statusCode}`
            try { const j = JSON.parse(errBody); msg = j.detail || j.error || msg } catch {}
            if (!event.sender.isDestroyed()) event.sender.send('reel:progress', { error: msg })
            resolve({ done: true })
          })
          return
        }
        let buf = ''
        let streamTerminal = false
        res.setEncoding('utf8')
        const flushSseLine = (line) => {
          if (!line.startsWith('data: ')) return
          try {
            const data = JSON.parse(line.slice(6))
            if (isReelSseTerminal(data)) streamTerminal = true
            if (!event.sender.isDestroyed()) event.sender.send('reel:progress', data)
          } catch {}
        }
        res.on('data', (chunk) => {
          buf += chunk
          const lines = buf.split('\n'); buf = lines.pop()
          for (const line of lines) flushSseLine(line)
        })
        res.on('end', () => {
          if (buf.trim()) flushSseLine(buf.trim())
          if (!streamTerminal && !event.sender.isDestroyed()) {
            event.sender.send('reel:progress', {
              error: 'Connessione al backend interrotta. Riprendi il job dalla lista.',
            })
          }
          resolve({ done: true })
        })
      })
      request.on('error', (err) => {
        if (!event.sender.isDestroyed()) event.sender.send('reel:progress', { error: err.message })
        resolve({ done: true })
      })
      request.on('socket', (s) => s.setTimeout(0))
      event.sender.once('destroyed', () => request.destroy())
      request.write(body); request.end()
    })
  })

  async function uploadFileToMedia(filePath, opts = {}) {
    const fs = require('fs')
    const FormData = require('form-data')
    const form = new FormData()
    form.append('file', fs.createReadStream(filePath))
    form.append('project_id', opts.projectId || '__library__')
    form.append('tags', opts.tags || '')
    form.append('description', opts.description || '')
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: BACKEND_PORT,
        path: '/api/media/upload',
        method: 'POST',
        headers: form.getHeaders(),
      }
      const req = http.request(options, (res) => {
        let data = ''
        res.on('data', (d) => { data += d })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (res.statusCode >= 400) {
              reject(new Error(parsed.detail || data || `HTTP ${res.statusCode}`))
            } else {
              resolve(parsed)
            }
          } catch (e) {
            reject(e)
          }
        })
      })
      req.on('error', reject)
      form.pipe(req)
    })
  }

  ipcMain.handle('media:uploadFile', (_, filePath, opts) => uploadFileToMedia(filePath, opts))

  ipcMain.handle('media:saveAs', async (_, filepath, filename) => {
    const fs = require('fs')
    const nodePath = require('path')
    if (!filepath || !fs.existsSync(filepath)) {
      return { saved: false, error: 'File non trovato su disco' }
    }
    const ext = nodePath.extname(filename || filepath).replace('.', '').toLowerCase()
    const filters = ext
      ? [{ name: ext.toUpperCase(), extensions: [ext] }]
      : [{ name: 'Tutti i file', extensions: ['*'] }]
    const { canceled, filePath: dest } = await dialog.showSaveDialog(mainWindow, {
      title: 'Scarica media',
      defaultPath: filename || nodePath.basename(filepath),
      filters,
    })
    if (canceled || !dest) return { saved: false, canceled: true }
    try {
      fs.copyFileSync(filepath, dest)
      return { saved: true, path: dest }
    } catch (err) {
      return { saved: false, error: err.message }
    }
  })
  ipcMain.handle('tools:upload', (_, filePath) =>
    uploadFileToMedia(filePath, { tags: 'tools' }),
  )

  ipcMain.handle('dialog:openImageFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    })
    if (canceled || !filePaths.length) return null
    return { path: filePaths[0], name: path.basename(filePaths[0]) }
  })

  ipcMain.handle('dialog:openAudioFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'] }],
    })
    if (canceled || !filePaths.length) return null
    return { path: filePaths[0], name: path.basename(filePaths[0]) }
  })

  // ── Native dialogs ──────────────────────────────────────────────────────────
  ipcMain.handle('dialog:openVideoFiles', async () => {
    return dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mxf'] }],
    })
  })

  ipcMain.handle('dialog:saveVideoFile', async (_, { defaultName = 'output.mp4' } = {}) => {
    return dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv'] }],
    })
  })

  // ── Native notifications ────────────────────────────────────────────────────
  ipcMain.handle('notify', (_, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show()
    }
  })

  // ── Frame Cut Optimizer ─────────────────────────────────────────────────────
  registerFrameCutOptimizerHandlers()
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor')

app.whenReady().then(async () => {
  registerIpcHandlers()

  // In dev mode, check if backend is already running (manually started uvicorn)
  // to avoid double-spawning. In production always spawn.
  let backendAlreadyUp = false
  if (isDev) {
    try {
      const r = await fetch(`${BACKEND_URL}/health`)
      backendAlreadyUp = r.ok
    } catch { /* not running yet */ }
  }

  if (!backendAlreadyUp) {
    startBackend()
  } else {
    log.info('Backend already running — skipping spawn')
  }

  log.info('Waiting for backend...')
  const ready = await waitForBackend()
  if (!ready) log.warn('Backend did not start in time — UI will show connection error')

  await createWindow()
})

app.on('window-all-closed', () => {
  if (backendProcess) backendProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('before-quit', () => {
  if (backendProcess) backendProcess.kill()
})
