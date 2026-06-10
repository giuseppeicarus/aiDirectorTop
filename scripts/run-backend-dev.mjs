/**
 * Avvia il backend FastAPI in modalità dev usando il venv isolato se disponibile,
 * altrimenti usa il python di sistema. Risolve i conflitti di dipendenze.
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')

const VENV_PYTHON_WIN  = join(ROOT, 'venv', 'Scripts', 'python.exe')
const VENV_PYTHON_UNIX = join(ROOT, 'venv', 'bin', 'python')
const VENV_PYTHON = process.platform === 'win32' ? VENV_PYTHON_WIN : VENV_PYTHON_UNIX

const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python'

if (python === VENV_PYTHON) {
  console.log(`[backend] Usando venv: ${VENV_PYTHON}`)
} else {
  console.log('[backend] venv non trovato — usando python di sistema')
  console.log('[backend] Per isolare le dipendenze esegui: .\\scripts\\setup_dev_env.ps1')
}

const args = [
  '-m', 'uvicorn',
  'src.core.main:app',
  '--reload',
  '--reload-dir', 'src/core',
  '--reload-delay', '2',
  '--port', '8123',
  '--host', '127.0.0.1',
]

const proc = spawn(python, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
})

proc.on('error', (err) => {
  console.error(`[backend] Errore avvio: ${err.message}`)
  if (err.code === 'ENOENT') {
    console.error('[backend] Python non trovato. Installa Python 3.10+ o esegui setup_dev_env.ps1')
  }
  process.exit(1)
})

proc.on('exit', (code) => {
  process.exit(code ?? 0)
})
