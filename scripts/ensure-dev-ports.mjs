/**
 * Libera le porte dev prima di npm run dev (Windows).
 * 5300 = Vite, 8123 = uvicorn (dev:backend), 8765 = legacy backend.
 */
import { execSync } from 'node:child_process'

const PORTS = [5300, 8123, 8765]

function listeningPidsWin(port) {
  const pids = new Set()
  const portRe = new RegExp(`:${port}(\\s|$)`)
  try {
    const out = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    for (const line of out.split('\n')) {
      if (!line.includes('LISTENING')) continue
      const local = line.trim().split(/\s+/)[1] || ''
      if (!portRe.test(local)) continue
      const pid = line.trim().split(/\s+/).pop()
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid)
    }
  } catch {
    /* nessun listener */
  }
  return pids
}

function freePortWin(port) {
  const pids = listeningPidsWin(port)
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' })
      console.log(`[ensure-dev-ports] liberata :${port} (PID ${pid})`)
    } catch {
      /* già terminato */
    }
  }
}

function sleepMs(ms) {
  try {
    execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${ms}"`, {
      stdio: 'ignore',
    })
  } catch {
    /* ignore */
  }
}

if (process.platform === 'win32') {
  let killed = 0
  for (const port of PORTS) {
    const before = listeningPidsWin(port).size
    freePortWin(port)
    if (before > 0) killed += before
  }
  if (killed > 0) sleepMs(900)
} else {
  console.log('[ensure-dev-ports] skip (pulizia automatica solo Windows)')
}
