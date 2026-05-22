import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  LayoutDashboard, RefreshCw, Image as ImageIcon, Film, Music, Layers,
  GitBranch, Activity, CheckCircle, XCircle, Clock, ChevronLeft, ChevronRight,
  Zap, HardDrive,
} from 'lucide-react'
import clsx from 'clsx'
import { API_BASE } from '../utils/apiClient'
import { mediaFileUrl, mediaThumbUrl } from '../utils/mediaUrl'

const API = API_BASE
const CAROUSEL_MS = 5500

function StatCard({ label, value, sub, Icon, accent }) {
  return (
    <div className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-[#555568]">{label}</p>
          <p className={clsx('text-2xl font-[\'Playfair_Display\'] mt-1 tabular-nums', accent ? 'text-[#c9a84c]' : 'text-[#e8e4dd]')}>
            {value}
          </p>
          {sub && <p className="text-[10px] font-mono text-[#9090a8] mt-1">{sub}</p>}
        </div>
        {Icon && (
          <span className={clsx('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', accent ? 'bg-[#c9a84c]/15 text-[#c9a84c]' : 'bg-[#1e1e2a] text-[#9090a8]')}>
            <Icon size={18} />
          </span>
        )}
      </div>
    </div>
  )
}

function ServicePill({ name, ok, detail }) {
  return (
    <div
      className={clsx(
        'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono',
        ok ? 'border-[#22c55e]/30 bg-[#22c55e]/8 text-[#22c55e]' : 'border-[#ef4444]/30 bg-[#ef4444]/8 text-[#ef4444]',
      )}
    >
      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
      <span className="text-[#e8e4dd]">{name}</span>
      {detail && <span className="text-[#555568] truncate max-w-[120px]">{detail}</span>}
    </div>
  )
}

function MediaPreview({ item }) {
  const thumb = mediaThumbUrl(item.id)
  const file = mediaFileUrl(item.id)

  if (item.type === 'video') {
    return (
      <video
        src={file}
        className="w-full h-full object-cover"
        muted
        loop
        playsInline
        autoPlay
      />
    )
  }
  return (
    <img
      src={thumb || file}
      alt={item.filename}
      className="w-full h-full object-cover"
    />
  )
}

function RecentMediaCarousel({ items }) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)

  const len = items?.length ?? 0
  const current = len > 0 ? items[index % len] : null

  const next = useCallback(() => {
    if (len < 2) return
    setIndex(i => (i + 1) % len)
  }, [len])

  const prev = useCallback(() => {
    if (len < 2) return
    setIndex(i => (i - 1 + len) % len)
  }, [len])

  useEffect(() => {
    if (paused || len < 2) return
    const t = setInterval(next, CAROUSEL_MS)
    return () => clearInterval(t)
  }, [paused, len, next])

  if (!len) {
    return (
      <div className="rounded-xl border border-[#252533] bg-[#16161f] p-8 text-center text-[#555568] text-sm font-mono">
        Nessuna immagine o clip video recente — genera dalla pipeline, reel/trailer o Tools.
      </div>
    )
  }

  const typeLabel = current.type === 'video' ? 'Clip video' : 'Immagine'
  const prompt = current.generation_prompt || ''

  return (
    <article
      className="relative rounded-xl border border-[#c9a84c]/25 bg-[#16161f] overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <span className="text-[9px] font-mono uppercase px-2 py-0.5 rounded bg-[#07070d]/80 text-[#c9a84c] border border-[#c9a84c]/30">
          {typeLabel}
        </span>
        {paused && (
          <span className="text-[9px] font-mono px-2 py-0.5 rounded bg-[#07070d]/80 text-[#9090a8]">
            Pausa
          </span>
        )}
      </div>

      <div className="grid md:grid-cols-2 min-h-[280px]">
        <div className="relative bg-[#0a0a0f] min-h-[220px] md:min-h-[320px]">
          <MediaPreview item={current} />
          {len > 1 && (
            <>
              <button
                type="button"
                onClick={prev}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-[#07070d]/70 border border-[#252533] text-[#e8e4dd] flex items-center justify-center hover:border-[#c9a84c]"
                aria-label="Precedente"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                onClick={next}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-[#07070d]/70 border border-[#252533] text-[#e8e4dd] flex items-center justify-center hover:border-[#c9a84c]"
                aria-label="Successivo"
              >
                <ChevronRight size={16} />
              </button>
            </>
          )}
        </div>

        <div className="p-5 flex flex-col justify-between border-t md:border-t-0 md:border-l border-[#252533]">
          <div>
            <p className="text-[10px] font-mono text-[#c9a84c] uppercase tracking-wider mb-2">
              Ultime creazioni · {index + 1}/{len}
            </p>
            <h2 className="font-['Playfair_Display'] text-xl text-[#e8e4dd] leading-snug mb-2 line-clamp-2">
              {current.project_title}
            </h2>
            <p className="text-[10px] font-mono text-[#555568] mb-3">
              {current.filename}
              {current.shot_id ? ` · ${current.shot_id}` : ''}
              {current.frame_type ? ` · ${current.frame_type}` : ''}
            </p>
            <p className="text-[9px] font-mono uppercase tracking-wider text-[#555568] mb-1.5">
              Prompt di generazione
            </p>
            {prompt ? (
              <p className="text-xs font-mono text-[#e8e4dd] leading-relaxed line-clamp-[10] max-h-[220px] overflow-y-auto border-l-2 border-[#c9a84c]/40 pl-3 pr-1">
                {prompt}
              </p>
            ) : (
              <p className="text-xs font-mono text-[#555568] italic">
                Prompt non disponibile (asset precedente alla registrazione del testo).
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 mt-4 pt-4 border-t border-[#252533]">
            <Link
              to={current.type === 'video' ? '/media?type=video' : '/media?type=image'}
              className="text-[10px] font-mono text-[#c9a84c] hover:underline"
            >
              Apri in Media Library
            </Link>
            <span className="text-[#555568]">·</span>
            <span className="text-[10px] font-mono text-[#555568]">
              {current.width && current.height ? `${current.width}×${current.height}` : ''}
              {current.size_bytes ? ` · ${(current.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
            </span>
          </div>
        </div>
      </div>

      {len > 1 && (
        <div className="flex gap-1.5 px-4 py-3 border-t border-[#252533] bg-[#0f0f18] overflow-x-auto">
          {items.map((it, i) => (
            <button
              key={it.id}
              type="button"
              onClick={() => setIndex(i)}
              className={clsx(
                'shrink-0 w-14 h-10 rounded overflow-hidden border-2 transition-colors',
                i === index ? 'border-[#c9a84c]' : 'border-transparent opacity-60 hover:opacity-100',
              )}
            >
              {it.type === 'video' ? (
                <span className="w-full h-full flex items-center justify-center bg-[#1e1e2a] text-[#c9a84c]">
                  <Film size={14} />
                </span>
              ) : (
                <img src={mediaThumbUrl(it.id) || mediaFileUrl(it.id)} alt="" className="w-full h-full object-cover" />
              )}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}

export default function DashboardScreen() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API}/dashboard/overview`, { cache: 'no-store' })
      if (!res.ok) throw new Error(await res.text())
      setData(await res.json())
    } catch (e) {
      setError(e.message || 'Errore caricamento dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  const media = data?.media || {}
  const gen = data?.generation || {}
  const services = data?.services || {}
  const runs = data?.active_runs || []

  const comfyOnline = services.comfyui?.ok
  const llmModel = services.llm?.model || services.llm?.provider || '—'

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={20} className="text-[#c9a84c]" />
          <div>
            <h1 className="font-['Playfair_Display'] text-2xl text-[#e8e4dd]">Dashboard</h1>
            <p className="text-[10px] font-mono text-[#555568]">Panoramica studio · aggiornamento ogni 15s</p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono rounded border border-[#252533] text-[#9090a8] hover:border-[#c9a84c] hover:text-[#c9a84c]"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Aggiorna
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded border border-[#ef4444]/40 bg-[#ef4444]/10 text-sm text-[#ef4444] font-mono">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard
          label="Media totali"
          value={media.total ?? '—'}
          sub={`${media.images ?? 0} img · ${media.videos ?? 0} vid · ${media.audios ?? 0} audio`}
          Icon={Layers}
        />
        <StatCard
          label="Job ComfyUI"
          value={gen.comfyui_jobs_total ?? 0}
          sub={`${gen.comfyui_jobs_image ?? 0} image · ${gen.comfyui_jobs_video ?? 0} video`}
          Icon={Zap}
          accent
        />
        <StatCard
          label="Workflow"
          value={data?.workflows_count ?? '—'}
          sub={`${gen.tracked_workflows ?? 0} con statistiche timing`}
          Icon={GitBranch}
        />
        <StatCard
          label="Storage media"
          value={media.size_gb != null ? `${media.size_gb} GB` : '—'}
          sub={media.total ? `${media.total} file` : ''}
          Icon={HardDrive}
        />
      </div>

      <div className="mb-6">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-[#555568] mb-2">
          Ultime immagini e clip video
        </h2>
        <RecentMediaCarousel items={data?.recent_media} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
          <div className="flex items-center gap-2 mb-3">
            <Activity size={14} className="text-[#c9a84c]" />
            <h3 className="text-sm font-mono text-[#e8e4dd] uppercase tracking-wider">Servizi</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <ServicePill name="LLM" ok={services.llm?.ok} detail={llmModel} />
            <ServicePill
              name="ComfyUI"
              ok={comfyOnline}
              detail={comfyOnline ? `coda ${data?.queue_depth ?? 0}` : 'offline'}
            />
            <ServicePill name="DB" ok={services.database?.ok} />
            <ServicePill name="FFmpeg" ok={services.ffmpeg?.ok} />
            <ServicePill
              name="Storage"
              ok={services.storage?.ok}
              detail={services.storage?.free_gb != null ? `${services.storage.free_gb} GB liberi` : ''}
            />
          </div>
          {services.comfyui?.nodes?.length > 0 && (
            <div className="mt-3 space-y-1">
              {services.comfyui.nodes.map((n, i) => (
                <div key={i} className="text-[10px] font-mono text-[#9090a8] flex items-center gap-2">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', n.online ? 'bg-[#22c55e]' : 'bg-[#ef4444]')} />
                  {n.name} — coda {n.queue_depth ?? 0}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-[#252533] bg-[#16161f] p-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} className="text-[#c9a84c]" />
            <h3 className="text-sm font-mono text-[#e8e4dd] uppercase tracking-wider">Run live</h3>
            <span className="text-[10px] font-mono text-[#555568] ml-auto">{runs.length} attivi</span>
          </div>
          {runs.length === 0 ? (
            <p className="text-xs font-mono text-[#555568]">Nessuna pipeline in esecuzione.</p>
          ) : (
            <ul className="space-y-2 max-h-48 overflow-y-auto">
              {runs.map((run, i) => (
                <li
                  key={run.job_id || run.project_id || i}
                  className="text-xs font-mono p-2 rounded bg-[#0f0f18] border border-[#252533]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#e8e4dd] truncate">{run.title || run.project_title || run.project_id || 'Run'}</span>
                    <span className="text-[#c9a84c] shrink-0">
                      {Math.round((run.progress ?? 0) <= 1 ? (run.progress ?? 0) * 100 : run.progress)}%
                    </span>
                  </div>
                  <p className="text-[#555568] mt-0.5 truncate">
                    {run.kind || 'pipeline'} · {run.stage || run.status || '—'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-4">
        <div className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3 flex items-center gap-3">
          <ImageIcon size={16} className="text-[#3b82f6]" />
          <div>
            <p className="text-lg font-mono text-[#e8e4dd] tabular-nums">{media.images ?? 0}</p>
            <p className="text-[9px] font-mono text-[#555568] uppercase">Immagini</p>
          </div>
        </div>
        <div className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3 flex items-center gap-3">
          <Film size={16} className="text-[#c9a84c]" />
          <div>
            <p className="text-lg font-mono text-[#e8e4dd] tabular-nums">{media.videos ?? 0}</p>
            <p className="text-[9px] font-mono text-[#555568] uppercase">Video</p>
          </div>
        </div>
        <div className="rounded-lg border border-[#252533] bg-[#0f0f18] p-3 flex items-center gap-3">
          <Music size={16} className="text-[#a855f7]" />
          <div>
            <p className="text-lg font-mono text-[#e8e4dd] tabular-nums">{media.audios ?? 0}</p>
            <p className="text-[9px] font-mono text-[#555568] uppercase">Audio</p>
          </div>
        </div>
      </div>
    </div>
  )
}
