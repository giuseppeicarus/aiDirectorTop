import { useCallback, useEffect, useState } from 'react'
import {
  BookOpen, ExternalLink, Loader2, RefreshCw, Play, Square,
  FolderOpen, Search, Link2,
} from 'lucide-react'
import clsx from 'clsx'

const api = () => window.studio?.obsidian

export default function ObsidianScreen() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [dockerBusy, setDockerBusy] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [hits, setHits] = useState([])
  const [syncPid, setSyncPid] = useState('')
  const [syncJid, setSyncJid] = useState('')
  const [syncKind, setSyncKind] = useState('reel')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api()?.status?.()
      setStatus(s || null)
    } catch (e) {
      setMsg(e?.message || 'Errore status Obsidian')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function dockerStart() {
    setDockerBusy(true)
    setMsg('')
    try {
      const r = await api()?.dockerStart?.()
      setMsg(r?.ok ? 'Container Obsidian avviato' : (r?.error || r?.output || 'Avvio fallito'))
      await refresh()
    } finally {
      setDockerBusy(false)
    }
  }

  async function dockerStop() {
    setDockerBusy(true)
    try {
      await api()?.dockerStop?.()
      setMsg('Container fermato')
      await refresh()
    } finally {
      setDockerBusy(false)
    }
  }

  function openWeb() {
    const url = status?.docker?.web_url || 'https://127.0.0.1:3001/'
    api()?.openWeb?.(url)
  }

  function openVaultFolder() {
    const p = status?.vault_path
    if (p) api()?.openFolder?.(p)
  }

  async function runSearch() {
    if (!searchQ.trim()) return
    const r = await api()?.search?.({ query: searchQ.trim(), limit: 15 })
    setHits(r?.hits || [])
  }

  async function runSync() {
    if (!syncPid.trim()) {
      setMsg('Inserisci project_id (cartella sotto projects/)')
      return
    }
    setDockerBusy(true)
    try {
      const r = await api()?.syncProject?.({
        project_id: syncPid.trim(),
        job_id: syncJid.trim() || undefined,
        pipeline_kind: syncKind,
      })
      setMsg(r?.ok ? `Sync OK — ${r.clips_synced ?? r.shots_synced ?? 0} elementi` : 'Sync fallita')
      await refresh()
    } catch (e) {
      setMsg(e?.message || 'Sync errore')
    } finally {
      setDockerBusy(false)
    }
  }

  const docker = status?.docker || {}
  const projects = status?.projects || []

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[#0a0a0f]">
      <header className="shrink-0 px-6 py-4 border-b border-[#252533]">
        <div className="flex items-center gap-3">
          <BookOpen className="text-[#c9a84c]" size={22} />
          <div>
            <h1 className="font-['Playfair_Display'] text-lg text-[#e8e4dd]">Obsidian Vault</h1>
            <p className="text-[10px] font-mono text-[#9090a8]">
              Single Source of Truth — prompt, seed, workflow, frame, audio, versioni clip, LTX
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="ml-auto p-2 rounded border border-[#32324a] text-[#9090a8] hover:text-[#c9a84c]"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-4xl">
        {msg && (
          <p className="text-[11px] font-mono text-[#c9a84c] px-3 py-2 rounded border border-[#c9a84c]/30 bg-[#c9a84c]/8">
            {msg}
          </p>
        )}

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4 space-y-3">
          <p className="text-[10px] font-mono text-[#555568] uppercase tracking-wider">Vault filesystem</p>
          <p className="text-[11px] font-mono text-[#e8e4dd] break-all">{status?.vault_path || '—'}</p>
          <p className="text-[10px] text-[#9090a8]">
            Sync automatico ad ogni checkpoint (trailer, reel, pipeline cinematic).
            Le note usano frontmatter YAML + wikilink per grafo e retrieval agent.
          </p>
          <button
            type="button"
            onClick={openVaultFolder}
            className="flex items-center gap-2 text-[10px] font-mono text-[#9090a8] hover:text-[#c9a84c]"
          >
            <FolderOpen size={12} /> Apri cartella vault
          </button>
        </section>

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4 space-y-3">
          <p className="text-[10px] font-mono text-[#555568] uppercase tracking-wider">Docker Obsidian (GUI)</p>
          <div className="flex flex-wrap gap-2 items-center">
            <span className={clsx(
              'text-[10px] font-mono px-2 py-0.5 rounded',
              docker.running ? 'bg-[#22c55e]/15 text-[#22c55e]' : 'bg-[#555568]/20 text-[#9090a8]',
            )}>
              {docker.docker_ok
                ? (docker.running ? 'Container attivo' : 'Container spento')
                : 'Docker non disponibile'}
            </span>
            <button
              type="button"
              onClick={dockerStart}
              disabled={dockerBusy || !docker.docker_ok}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-mono border border-[#32324a] text-[#c9a84c] hover:bg-[#c9a84c]/10 disabled:opacity-40"
            >
              {dockerBusy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              Avvia
            </button>
            <button
              type="button"
              onClick={dockerStop}
              disabled={dockerBusy || !docker.docker_ok}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-mono border border-[#32324a] text-[#9090a8] hover:text-[#e8e4dd] disabled:opacity-40"
            >
              <Square size={11} /> Stop
            </button>
            <button
              type="button"
              onClick={openWeb}
              disabled={!docker.web_url}
              className="flex items-center gap-1 px-3 py-1.5 rounded text-[10px] font-mono border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/10"
            >
              <ExternalLink size={11} /> Apri Obsidian (browser)
            </button>
          </div>
          <p className="text-[9px] font-mono text-[#555568]">
            Prima volta nel container: Open folder as vault → <span className="text-[#c9a84c]">/vault</span>
            {' '}(stesso path del backend). Richiede Docker Desktop, non installazione Windows.
          </p>
        </section>

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4 space-y-3">
          <p className="text-[10px] font-mono text-[#555568] uppercase tracking-wider">Sync manuale progetto</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              value={syncPid}
              onChange={e => setSyncPid(e.target.value)}
              placeholder="project_id (storage)"
              className="text-[11px] font-mono bg-[#0f0f18] border border-[#252533] rounded px-2 py-1.5 text-[#e8e4dd]"
            />
            <input
              value={syncJid}
              onChange={e => setSyncJid(e.target.value)}
              placeholder="job_id (trailer/reel)"
              className="text-[11px] font-mono bg-[#0f0f18] border border-[#252533] rounded px-2 py-1.5 text-[#e8e4dd]"
            />
            <select
              value={syncKind}
              onChange={e => setSyncKind(e.target.value)}
              className="text-[11px] font-mono bg-[#0f0f18] border border-[#252533] rounded px-2 py-1.5 text-[#e8e4dd]"
            >
              <option value="reel">reel</option>
              <option value="trailer">trailer</option>
              <option value="cinematic">cinematic</option>
            </select>
          </div>
          <button
            type="button"
            onClick={runSync}
            disabled={dockerBusy}
            className="text-[10px] font-mono text-[#c9a84c] hover:underline"
          >
            Sincronizza checkpoint → vault
          </button>
        </section>

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4 space-y-3">
          <p className="text-[10px] font-mono text-[#555568] uppercase tracking-wider flex items-center gap-1">
            <Search size={11} /> Retrieval (stili / agent)
          </p>
          <div className="flex gap-2">
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder="cerca nel vault…"
              className="flex-1 text-[11px] font-mono bg-[#0f0f18] border border-[#252533] rounded px-2 py-1.5"
            />
            <button type="button" onClick={runSearch} className="px-3 text-[10px] font-mono border border-[#32324a] rounded text-[#c9a84c]">
              Cerca
            </button>
          </div>
          {hits.length > 0 && (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {hits.map(h => (
                <li key={h.path} className="text-[10px] font-mono text-[#9090a8]">
                  <span className="text-[#c9a84c]">{h.path}</span>
                  <p className="truncate opacity-70">{h.excerpt}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
          <p className="text-[10px] font-mono text-[#555568] uppercase tracking-wider mb-2 flex items-center gap-1">
            <Link2 size={11} /> Progetti nel vault ({projects.length})
          </p>
          {projects.length === 0 ? (
            <p className="text-[10px] font-mono text-[#555568]">Nessun progetto sincronizzato ancora.</p>
          ) : (
            <ul className="space-y-1">
              {projects.map(p => (
                <li key={p.project_id} className="text-[11px] font-mono text-[#9090a8]">
                  {p.project_id}
                  {p.project_note && (
                    <span className="text-[#555568]"> → {p.project_note}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
