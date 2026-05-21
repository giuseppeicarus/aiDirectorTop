/**
 * Fetch API con retry — utile quando uvicorn --reload resetta la connessione.
 */
const API_BASE = 'http://127.0.0.1:8765/api'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    err instanceof TypeError
    || msg.includes('failed to fetch')
    || msg.includes('network')
    || msg.includes('connection')
    || msg.includes('reset')
  )
}

export async function waitForBackend(maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:8765/health', { cache: 'no-store' })
      if (r.ok) return true
    } catch {
      /* backend starting or reloading */
    }
    await sleep(400)
  }
  return false
}

export async function apiGet(path, { retries = 4, retryDelayMs = 500 } = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < retries - 1 && isRetryableError(err)) {
        await sleep(retryDelayMs * (attempt + 1))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export async function apiPost(path, body, options = {}) {
  const { retries = 3, retryDelayMs = 500 } = options
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      return await res.json()
    } catch (err) {
      lastErr = err
      if (attempt < retries - 1 && isRetryableError(err)) {
        await sleep(retryDelayMs * (attempt + 1))
        continue
      }
      throw err
    }
  }
  throw lastErr
}

export { API_BASE }
