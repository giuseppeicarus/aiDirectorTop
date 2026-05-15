/**
 * CinematicAI Studio — Electron Main Process
 * Gestisce la finestra, il backend Python e i canali IPC.
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
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

function startBackend() {
  const backendDir = isDev
    ? path.join(__dirname, '..', '..')
    : path.join(process.resourcesPath, 'backend')

  const exeName = process.platform === 'win32' ? 'cinematic_backend.exe' : 'cinematic_backend'
  const pythonExe = isDev
    ? (process.platform === 'win32' ? 'venv\\Scripts\\python.exe' : 'venv/bin/python')
    : path.join(backendDir, 'cinematic_backend', exeName)

  const args = isDev
    ? ['-m', 'uvicorn', 'src.core.main:app', '--port', String(BACKEND_PORT), '--host', '127.0.0.1']
    : []

  log.info('Starting backend', { pythonExe, args, cwd: backendDir })

  backendProcess = spawn(pythonExe, args, {
    cwd: isDev ? path.join(__dirname, '..', '..') : backendDir,
    env: { ...process.env },
  })

  backendProcess.stdout.on('data', (d) => log.info('[backend]', d.toString().trim()))
  backendProcess.stderr.on('data', (d) => log.warn('[backend]', d.toString().trim()))
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
    await mainWindow.loadURL('http://localhost:5173')
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
  ipcMain.handle('project:delete',  (_, id)          => apiCall('DELETE', `/api/projects/${id}`))
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

  // ── Workflow management ─────────────────────────────────────────────────────
  ipcMain.handle('workflow:list',   ()               => apiCall('GET',    '/api/workflows'))
  ipcMain.handle('workflow:get',    (_, id)          => apiCall('GET',    `/api/workflows/${id}`))
  ipcMain.handle('workflow:create', (_, data)        => apiCall('POST',   '/api/workflows', data))
  ipcMain.handle('workflow:save',   (_, id, data)    => apiCall('PUT',    `/api/workflows/${id}`, data))
  ipcMain.handle('workflow:delete', (_, id)          => apiCall('DELETE', `/api/workflows/${id}`))

  ipcMain.handle('backend:url',     ()               => BACKEND_URL)
  ipcMain.handle('shell:openPath',  (_, p)           => shell.openPath(p))

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

  // ── Frame Cut Optimizer ─────────────────────────────────────────────────────
  registerFrameCutOptimizerHandlers()
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  startBackend()
  registerIpcHandlers()

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
