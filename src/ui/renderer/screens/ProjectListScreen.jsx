import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Film, Plus, Trash2, Play, Clock, Timer } from 'lucide-react'
import { useProjectStore } from '../stores'
import clsx from 'clsx'
import NewProjectTypeModal, { NEW_PROJECT_OPTIONS } from '../components/NewProjectTypeModal'
import ElegantLoader from '../components/ElegantLoader'

const STATUS_LABEL = {
  draft: 'Bozza',
  storyboard: 'Storyboard',
  generating: 'Generazione',
  done: 'Completato',
  error: 'Errore',
}
const STATUS_COLOR = {
  draft:       'text-[#9090a0]',
  storyboard:  'text-blue-400',
  generating:  'text-[#c9a84c]',
  done:        'text-green-400',
  error:       'text-red-400',
}

function fmtTime(sec) {
  if (!sec || sec <= 0) return null
  const m = Math.round(sec / 60)
  if (m < 1) return '< 1m'
  if (m < 60) return `~${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `~${h}h ${rm}m` : `~${h}h`
}

function calcGenEta(projectId, genInfo, genStats) {
  if (!genInfo || !genStats) return null
  const info = genInfo[projectId]
  if (!info) return null
  const best = genStats.best || {}
  const imgAvg = best.image
  const vidAvg = best.video
  if (!imgAvg && !vidAvg) return null
  const imgSec = imgAvg ? info.img_count * imgAvg : null
  const vidSec = vidAvg ? info.video_count * vidAvg : null
  return { imgSec, vidSec, totalSec: (imgSec || 0) + (vidSec || 0), imgCount: info.img_count, videoCount: info.video_count }
}

export default function ProjectListScreen() {
  const { projects, loading, loadProjects, deleteProject } = useProjectStore()
  const navigate = useNavigate()
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [genInfo, setGenInfo] = useState(null)
  const [genStats, setGenStats] = useState(null)

  function handleNewProjectType(optionId) {
    const opt = NEW_PROJECT_OPTIONS.find(o => o.id === optionId)
    if (!opt) return
    setNewProjectOpen(false)
    navigate(opt.to, opt.state ? { state: opt.state } : undefined)
  }

  useEffect(() => {
    loadProjects()
    Promise.all([
      window.studio?.project?.genInfo?.().catch(() => null),
      window.studio?.comfyui?.genStats?.().catch(() => null),
    ]).then(([gi, gs]) => {
      if (gi) setGenInfo(gi)
      if (gs) setGenStats(gs)
    })
  }, [])

  async function handleDeleteClick(e, project) {
    e.stopPropagation()
    try {
      const info = await window.studio.project.mediaCount(project.id)
      setDeleteConfirm({
        id: project.id,
        title: project.title,
        mediaCount: info.count,
        mediaSize: info.size_bytes,
      })
    } catch {
      setDeleteConfirm({ id: project.id, title: project.title, mediaCount: 0, mediaSize: 0 })
    }
  }

  async function confirmDelete(withMedia) {
    if (!deleteConfirm) return
    await deleteProject(deleteConfirm.id, withMedia)
    setDeleteConfirm(null)
  }

  if (loading) return (
    <div className="h-full flex items-center justify-center bg-[#0a0a0f]">
      <ElegantLoader messages={[
        'Caricamento della lista dei progetti...',
        'Sincronizzazione dello stato del database...',
        'Lettura delle statistiche di completamento...'
      ]} />
    </div>
  )

  return (
    <div className="p-8">
      <NewProjectTypeModal
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onSelect={handleNewProjectType}
      />
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-['Playfair_Display'] text-2xl text-[#f0ede8]">I tuoi Progetti</h1>
          <p className="text-sm text-[#9090a0] mt-1">{projects.length} progetto/i</p>
        </div>
        <button
          onClick={() => setNewProjectOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[#c9a84c] hover:bg-[#d4b55e]
                     text-[#0a0a0f] font-medium text-sm rounded-md transition-colors"
        >
          <Plus size={16} />
          Nuovo Progetto
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-[#9090a0]">
          <Film size={48} className="mb-4 opacity-30" />
          <p className="text-lg font-['Playfair_Display']">Nessun progetto ancora</p>
          <p className="text-sm mt-2">Crea il tuo primo video cinematografico</p>
          <button
            onClick={() => setNewProjectOpen(true)}
            className="mt-6 flex items-center gap-2 px-5 py-2.5 bg-[#c9a84c]/10
                       border border-[#c9a84c]/30 hover:bg-[#c9a84c]/20 text-[#c9a84c]
                       rounded-md transition-colors text-sm"
          >
            <Plus size={15} /> Crea progetto
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map(project => {
            const eta = calcGenEta(project.id, genInfo, genStats)
            const showEta = eta && project.status !== 'done'
            return (
            <div key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
              className="bg-[#12121a] border border-[#2a2a38] rounded-lg p-5 cursor-pointer
                         hover:border-[#c9a84c]/30 transition-colors group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="font-['Playfair_Display'] text-[#f0ede8] truncate">{project.title}</h3>
                  <span className={clsx('text-xs mt-0.5', STATUS_COLOR[project.status] || 'text-[#9090a0]')}>
                    {STATUS_LABEL[project.status] || project.status}
                  </span>
                </div>
                <button
                  onClick={(e) => handleDeleteClick(e, project)}
                  className="p-1.5 text-[#9090a0] hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <p className="text-xs text-[#9090a0] line-clamp-2 mb-4">{project.user_prompt}</p>

              <div className="flex items-center gap-2 text-[11px] text-[#9090a0] mb-2">
                <span className="capitalize">{project.genre}</span>
                <span>·</span>
                <Clock size={11} />
                <span>{project.duration_sec}s</span>
                <span>·</span>
                <span>{project.aspect_ratio}</span>
              </div>

              {showEta && (
                <div className="flex items-center gap-1.5 text-[11px] text-[#9090a0] mb-4 bg-[#0f0f18] rounded px-2 py-1.5 border border-[#1e1e2a]">
                  <Timer size={10} className="text-[#c9a84c] shrink-0" />
                  <span className="text-[#9090a0]">
                    {eta.imgCount} img
                    {eta.imgSec ? <span className="text-[#c9a84c] ml-0.5">{fmtTime(eta.imgSec)}</span> : null}
                    {' · '}
                    {eta.videoCount} video
                    {eta.vidSec ? <span className="text-[#c9a84c] ml-0.5">{fmtTime(eta.vidSec)}</span> : null}
                    {eta.totalSec > 0 && (
                      <span className="ml-1 text-[#555568]">= {fmtTime(eta.totalSec)}</span>
                    )}
                  </span>
                </div>
              )}
              {!showEta && <div className="mb-4" />}

              <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                <button
                  onClick={() => navigate(`/projects/${project.id}/storyboard`)}
                  className="flex-1 py-1.5 text-xs border border-[#2a2a38] hover:border-[#c9a84c]/40
                             rounded text-[#9090a0] hover:text-[#f0ede8] transition-colors"
                >
                  Storyboard
                </button>
                <button
                  onClick={() => navigate(`/projects/${project.id}/pipeline`)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#c9a84c]/10
                             hover:bg-[#c9a84c]/20 text-[#c9a84c] rounded transition-colors"
                >
                  <Play size={11} /> Genera
                </button>
              </div>
            </div>
          )})}

        </div>
      )}


      {deleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-[#0a0a0f] border border-[#2a2a38] rounded-xl p-7 w-[420px] shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="font-['Playfair_Display'] text-lg text-[#f0ede8] mb-2">
              Elimina progetto
            </h2>
            <p className="text-sm text-[#9090a0] mb-5">
              Stai eliminando <span className="text-[#e8e4dd] font-medium">"{deleteConfirm.title}"</span>.
              Questa azione non può essere annullata.
            </p>

            {deleteConfirm.mediaCount > 0 && (
              <div className="bg-[#16161f] border border-[#2a2a38] rounded-lg p-4 mb-5 text-sm text-[#9090a0]">
                Questo progetto ha{' '}
                <span className="text-[#c9a84c] font-medium">{deleteConfirm.mediaCount} media generati</span>
                {' '}({(deleteConfirm.mediaSize / 1024 / 1024).toFixed(1)} MB).
                <br />Vuoi eliminarli assieme al progetto?
              </div>
            )}

            <div className="flex flex-col gap-2">
              {deleteConfirm.mediaCount > 0 && (
                <button
                  onClick={() => confirmDelete(true)}
                  className="w-full py-2 rounded-md text-sm font-medium bg-red-500/15 hover:bg-red-500/25
                             text-red-400 border border-red-500/30 transition-colors"
                >
                  Elimina progetto + {deleteConfirm.mediaCount} media
                </button>
              )}
              <button
                onClick={() => confirmDelete(false)}
                className="w-full py-2 rounded-md text-sm font-medium bg-[#1e1e2a] hover:bg-[#252533]
                           text-[#e8e4dd] border border-[#252533] transition-colors"
              >
                {deleteConfirm.mediaCount > 0 ? 'Elimina solo il progetto' : 'Elimina progetto'}
              </button>
              <button
                onClick={() => setDeleteConfirm(null)}
                className="w-full py-2 rounded-md text-sm text-[#9090a0] hover:text-[#e8e4dd] transition-colors"
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
