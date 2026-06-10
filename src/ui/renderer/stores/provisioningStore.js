import { create } from 'zustand'
import { API_BASE } from '../utils/apiClient'

const API = `${API_BASE}/provisioning`
const LOCAL_PATH_KEY = 'provisioning_local_path'

export const useProvisioningStore = create((set, get) => ({
  // ── Terminal output (persiste cross-navigazione) ───────────────────────────
  termLines:       [],
  termPct:         0,
  running:         false,
  currentProgress: null,
  report:          null,
  activeMode:      null,   // 'ssh' | 'local' — quale modo ha avviato il job corrente

  // ── Local path (persistito in localStorage) ───────────────────────────────
  localPath: localStorage.getItem(LOCAL_PATH_KEY) || '',

  setLocalPath: (path) => {
    set({ localPath: path })
    localStorage.setItem(LOCAL_PATH_KEY, path)
  },

  clearOutput: () => set({ termLines: [], termPct: 0, report: null, currentProgress: null }),

  // ── startStream — gira fuori dal lifecycle React ───────────────────────────
  startStream: (url, body, mode) => {
    if (get().running) return
    set({ termLines: [], termPct: 0, running: true, currentProgress: null, report: null, activeMode: mode })

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
      .then(async resp => {
        const reader = resp.body.getReader()
        const dec    = new TextDecoder()
        let buf      = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const parts = buf.split('\n\n'); buf = parts.pop() || ''

          for (const part of parts) {
            const line = part.trim()
            if (!line.startsWith('data:')) continue
            try {
              const ev = JSON.parse(line.slice(5).trim())

              if (ev.tag === 'PROGRESS' && ev.extra) {
                set({ currentProgress: ev.extra })
              } else if (['DONE', 'SKIP', 'ERROR'].includes(ev.tag)) {
                set({ currentProgress: null })
              }

              if (ev.tag !== 'PROGRESS') {
                set(s => ({ termLines: [...s.termLines, ev] }))
              }

              if (ev.pct != null) set({ termPct: ev.pct })

              if (ev.type === 'complete' || ev.type === 'error') {
                set({ running: false, currentProgress: null })
                if (ev.report) set({ report: ev.report })
                if (ev.type === 'complete') set({ termPct: 1 })
              }
            } catch {}
          }
        }
        set({ running: false })
      })
      .catch(e => {
        set(s => ({
          termLines: [...s.termLines, { text: `Errore connessione: ${e}`, tag: 'ERROR' }],
          running: false,
        }))
      })
  },
}))
