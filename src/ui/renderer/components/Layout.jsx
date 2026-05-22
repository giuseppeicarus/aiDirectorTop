import { Outlet, NavLink, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import {
  Film, FolderOpen, Settings, Plus, Circle, Scissors, ListChecks, Zap, Wrench, LayoutDashboard,
  Image, GitBranch, Wand2, Package, Clapperboard, Tv, Instagram, BookOpen,
  ChevronDown, ChevronRight, Play, Music, Layers, Video,
  Image as ImageIcon,
} from 'lucide-react'
import { useConfigStore, usePipelineStore, useProjectStore } from '../stores'
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import GlobalActivityBanner from './GlobalActivityBanner'
import NewProjectTypeModal, { NEW_PROJECT_OPTIONS } from './NewProjectTypeModal'
import { useGlobalActivityBridge } from '../hooks/useGlobalActivityBridge'
import { fetchRecentNavItems, recentKindLabel, recentKindColor } from '../utils/sidebarRecent'

const TOOL_NAV = [
  { id: 'txt2img', label: 'Text → Image', Icon: Image },
  { id: 'txt2video', label: 'Text → Video', Icon: Film },
  { id: 'img2video', label: 'Image → Video', Icon: Play },
  { id: 'img_audio2video', label: 'Image + Audio → Video', Icon: Music },
]

const MEDIA_NAV = [
  { type: 'all', label: 'All', Icon: Layers, to: '/media' },
  { type: 'image', label: 'Image', Icon: ImageIcon, to: '/media?type=image' },
  { type: 'video', label: 'Video', Icon: Video, to: '/media?type=video' },
  { type: 'audio', label: 'Audio', Icon: Music, to: '/media?type=audio' },
]

const CONFIG_NAV = [
  { to: '/nodes', label: 'Nodi ComfyUI', Icon: Zap },
  { to: '/services', label: 'Servizi', Icon: Wrench },
  { to: '/models', label: 'Modelli', Icon: Package },
  { to: '/workflows', label: 'Workflow', Icon: GitBranch },
  { to: '/queue', label: 'Code & Monitor', Icon: ListChecks, pipelineDot: true },
  { to: '/obsidian', label: 'Obsidian Vault', Icon: BookOpen, accent: true },
  { to: '/settings', label: 'Impostazioni', Icon: Settings },
]

function navClass(isActive, accent) {
  return clsx(
    'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
    isActive
      ? accent ? 'bg-[#c9a84c]/15 text-[#c9a84c]' : 'bg-[#1a1a24] text-[#f0ede8]'
      : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]',
  )
}

function SidebarGroup({ title, open, onToggle, children }) {
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-[#555568] hover:text-[#9090a0] transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{title}</span>
      </button>
      {open && <div className="space-y-0.5 mt-0.5">{children}</div>}
    </div>
  )
}

export default function Layout() {
  const { nodes, loadNodes } = useConfigStore()
  const { projects, loadProjects } = useProjectStore()
  const { stage } = usePipelineStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const pipelineActive = !['idle', 'done', 'error'].includes(stage)

  const [configOpen, setConfigOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [recentItems, setRecentItems] = useState([])
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  useGlobalActivityBridge()

  useEffect(() => {
    loadNodes()
    loadProjects()
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const items = await fetchRecentNavItems(3)
      if (!cancelled) setRecentItems(items)
    })()
    return () => { cancelled = true }
  }, [projects, location.pathname, location.search])

  const activeToolId = useMemo(() => {
    if (!location.pathname.startsWith('/tools')) return null
    const q = new URLSearchParams(location.search)
    return q.get('tool')
  }, [location.pathname, location.search])

  const configActive = CONFIG_NAV.some(
    (item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )
  const toolsActive =
    location.pathname.startsWith('/tools')
    || location.pathname === '/frame-cut-optimizer'
    || location.pathname.startsWith('/frame-cut-optimizer/')

  const mediaActive = location.pathname.startsWith('/media')

  useEffect(() => {
    setToolsOpen(toolsActive)
  }, [toolsActive])

  useEffect(() => {
    setConfigOpen(configActive)
  }, [configActive])

  const onlineCount = nodes.filter(n => n.online).length

  function handleNewProjectType(optionId) {
    const opt = NEW_PROJECT_OPTIONS.find(o => o.id === optionId)
    if (!opt) return
    setNewProjectOpen(false)
    navigate(opt.to, opt.state ? { state: opt.state } : undefined)
  }

  return (
    <div className="flex h-full bg-[#0a0a0f] text-[#f0ede8] overflow-hidden">
      <NewProjectTypeModal
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onSelect={handleNewProjectType}
      />
      <aside className="w-56 bg-[#12121a] border-r border-[#2a2a38] flex flex-col shrink-0">
        <div className="px-5 py-5 border-b border-[#2a2a38]">
          <div className="flex items-center gap-2">
            <Film className="text-[#c9a84c]" size={20} />
            <span className="font-['Playfair_Display'] text-sm font-semibold tracking-wide text-[#c9a84c]">
              CinematicAI
            </span>
          </div>
          <p className="text-[10px] text-[#9090a0] mt-1 ml-7">Studio</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          <NavLink to="/dashboard" className={({ isActive }) => navClass(isActive, true)}>
            <LayoutDashboard size={15} />
            Dashboard
          </NavLink>

          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md
                       bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 text-[#c9a84c]
                       text-sm transition-colors mb-2 mt-1"
          >
            <Plus size={15} />
            <span>Nuovo Progetto</span>
          </button>

          {/* ── Progetti ── */}
          <div className="mb-2">
            <div className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-[#555568]">
              Progetti
            </div>
            <NavLink to="/projects" end className={({ isActive }) => navClass(isActive)}>
              <FolderOpen size={15} />
              Tutti i progetti
            </NavLink>
            {recentItems.map((item) => {
              const pathOnly = item.path?.split('?')[0] || ''
              const jobId = item.path?.includes('job=')
                ? new URLSearchParams(item.path.split('?')[1] || '').get('job')
                : null
              const pathMatch = location.pathname === pathOnly
                || (item.kind === 'project' && location.pathname.startsWith(`${pathOnly}/`))
              const jobMatch = jobId && searchParams.get('job') === jobId
              return (
                <NavLink
                  key={`${item.kind}-${item.catalog_id}-${item.id}`}
                  to={item.path}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-1.5 pl-7 pr-2 py-1.5 rounded-md text-[12px] transition-colors min-w-0',
                      (isActive || pathMatch || jobMatch)
                        ? 'bg-[#1a1a24] text-[#c9a84c]'
                        : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]',
                    )
                  }
                  title={item.title}
                >
                  <span className={clsx('text-[8px] font-mono uppercase shrink-0', recentKindColor(item.kind))}>
                    {recentKindLabel(item.kind)}
                  </span>
                  <span className="truncate flex-1">{item.title}</span>
                </NavLink>
              )
            })}
            {recentItems.length === 0 && (
              <p className="pl-7 pr-2 py-1 text-[10px] text-[#555568]">Nessun lavoro recente</p>
            )}
          </div>

          <div className="my-2 border-t border-[#2a2a38]" />

          {/* ── App ── */}
          <div className="mb-2">
            <div className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-[#555568]">
              App
            </div>
            <NavLink
              to="/director"
              className={({ isActive }) => navClass(isActive || location.pathname.startsWith('/director'), true)}
            >
              <Clapperboard size={15} />
              Director Cinema
            </NavLink>
            <NavLink
              to="/trailer"
              className={({ isActive }) => navClass(
                isActive || (location.pathname.startsWith('/trailer') && !location.pathname.startsWith('/projects/')),
                true,
              )}
            >
              <Tv size={15} />
              Trailer Generator
            </NavLink>
            <NavLink
              to="/createreel"
              className={({ isActive }) => navClass(
                isActive || location.pathname.startsWith('/createreel') || location.pathname.endsWith('/reel'),
                true,
              )}
            >
              <Instagram size={15} />
              CreateReel
            </NavLink>
          </div>

          <div className="my-2 border-t border-[#2a2a38]" />

          {/* ── Tools ── */}
          <SidebarGroup
            title="Tools"
            open={toolsOpen}
            onToggle={() => setToolsOpen(v => !v)}
          >
            {TOOL_NAV.map(({ id, label, Icon }) => {
              const onToolsPage = location.pathname.startsWith('/tools')
              const active = onToolsPage && (activeToolId === id || (!activeToolId && id === 'txt2img'))
              return (
                <NavLink
                  key={id}
                  to={{ pathname: '/tools', search: `?tool=${id}` }}
                  className={navClass(active)}
                >
                  <Icon size={15} />
                  {label}
                </NavLink>
              )
            })}
            <NavLink to="/frame-cut-optimizer" className={({ isActive }) => navClass(isActive)}>
              <Scissors size={15} />
              Frame Cut
            </NavLink>
          </SidebarGroup>

          {/* ── Media Library ── */}
          <div className="mb-2 pt-1">
            <div className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-wider text-[#555568]">
              Media Library
            </div>
            {MEDIA_NAV.map(({ type, label, Icon, to }) => {
              const active = mediaActive && (
                type === 'all'
                  ? !searchParams.get('type') || searchParams.get('type') === 'all'
                  : searchParams.get('type') === type
              )
              return (
                <NavLink
                  key={type}
                  to={to}
                  className={({ isActive }) => navClass(isActive || active)}
                >
                  <Icon size={15} />
                  {label}
                </NavLink>
              )
            })}
          </div>

          <div className="my-2 border-t border-[#2a2a38]" />

          {/* ── Configurazione (ultima sezione) ── */}
          <SidebarGroup
            title="Configurazione"
            open={configOpen}
            onToggle={() => setConfigOpen(v => !v)}
          >
            {CONFIG_NAV.map(({ to, label, Icon, pipelineDot, accent }) => (
              <NavLink key={to} to={to} className={({ isActive }) => navClass(isActive, accent)}>
                <Icon size={15} />
                {label}
                {pipelineDot && pipelineActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#c9a84c] animate-pulse" />
                )}
              </NavLink>
            ))}
          </SidebarGroup>
        </nav>

        <div className="px-4 py-3 border-t border-[#2a2a38]">
          <div className="text-[10px] text-[#9090a0] mb-2 uppercase tracking-wider">
            ComfyUI Nodes {onlineCount > 0 && `(${onlineCount}/${nodes.length})`}
          </div>
          {nodes.length === 0 ? (
            <p className="text-[11px] text-[#9090a0]">Nessun nodo configurato</p>
          ) : (
            nodes.map((node) => (
              <div key={node.host + node.port} className="flex items-center gap-2 mb-1">
                <Circle
                  size={7}
                  className={node.online ? 'text-green-500 fill-green-500' : 'text-red-500 fill-red-500'}
                />
                <span className="text-[11px] text-[#9090a0] truncate">
                  {node.primary ? '★ ' : ''}{node.name}
                </span>
                {node.online && node.queue_depth > 0 && (
                  <span className="text-[10px] text-[#c9a84c] ml-auto">{node.queue_depth}</span>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <GlobalActivityBanner />
        <div className="flex-1 overflow-auto min-h-0">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
