import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import {
  Film, FolderOpen, Settings, Plus, Circle, Scissors, ListChecks, Zap, Wrench,
  Image, GitBranch, Wand2, Package, Clapperboard, Tv, Instagram, BookOpen,
  ChevronDown, ChevronRight, Play, Music,
} from 'lucide-react'
import { useConfigStore, usePipelineStore, useProjectStore } from '../stores'
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import GlobalActivityBanner from './GlobalActivityBanner'
import { useGlobalActivityBridge } from '../hooks/useGlobalActivityBridge'

const TOOL_NAV = [
  { id: 'txt2img', label: 'Text → Image', Icon: Image },
  { id: 'txt2video', label: 'Text → Video', Icon: Film },
  { id: 'img2video', label: 'Image → Video', Icon: Play },
  { id: 'img_audio2video', label: 'Image + Audio → Video', Icon: Music },
]

const CONFIG_NAV = [
  { to: '/nodes', label: 'Nodi ComfyUI', Icon: Zap },
  { to: '/services', label: 'Servizi', Icon: Wrench },
  { to: '/models', label: 'Modelli', Icon: Package },
  { to: '/workflows', label: 'Workflow', Icon: GitBranch },
  { to: '/queue', label: 'Code & Monitor', Icon: ListChecks, pipelineDot: true },
  { to: '/obsidian', label: 'Obsidian Vault', Icon: BookOpen, accent: true },
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
  const pipelineActive = !['idle', 'done', 'error'].includes(stage)

  const [configOpen, setConfigOpen] = useState(true)
  const [toolsOpen, setToolsOpen] = useState(true)

  useGlobalActivityBridge()

  useEffect(() => {
    loadNodes()
    loadProjects()
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  const recentProjects = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      const ta = new Date(a.updated_at || a.created_at || 0).getTime()
      const tb = new Date(b.updated_at || b.created_at || 0).getTime()
      return tb - ta
    })
    return sorted.slice(0, 3)
  }, [projects])

  const activeToolId = useMemo(() => {
    if (!location.pathname.startsWith('/tools')) return null
    const q = new URLSearchParams(location.search)
    return q.get('tool')
  }, [location.pathname, location.search])

  const configActive = CONFIG_NAV.some(
    (item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  )
  const toolsActive = location.pathname.startsWith('/tools')

  useEffect(() => {
    if (configActive) setConfigOpen(true)
  }, [configActive])

  useEffect(() => {
    if (toolsActive) setToolsOpen(true)
  }, [toolsActive])

  const onlineCount = nodes.filter(n => n.online).length

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-[#f0ede8] overflow-hidden">
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
          <button
            type="button"
            onClick={() => navigate('/projects/new')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md
                       bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 text-[#c9a84c]
                       text-sm transition-colors mb-2"
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
            {recentProjects.map((p) => (
              <NavLink
                key={p.id}
                to={`/projects/${p.id}`}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-md text-[12px] transition-colors truncate',
                    isActive
                      ? 'bg-[#1a1a24] text-[#c9a84c]'
                      : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]',
                  )
                }
                title={p.title}
              >
                <span className="truncate">{p.title || p.id}</span>
              </NavLink>
            ))}
            {recentProjects.length === 0 && (
              <p className="pl-7 pr-2 py-1 text-[10px] text-[#555568]">Nessun progetto</p>
            )}
          </div>

          <div className="my-2 border-t border-[#2a2a38]" />

          <NavLink to="/director" className={({ isActive }) => navClass(isActive, true)}>
            <Clapperboard size={15} />
            Director Cinema
          </NavLink>

          <NavLink to="/trailer" className={({ isActive }) => navClass(isActive, true)}>
            <Tv size={15} />
            Trailer Generator
          </NavLink>

          <NavLink to="/createreel" className={({ isActive }) => navClass(isActive, true)}>
            <Instagram size={15} />
            CreateReel
          </NavLink>

          <div className="my-2 border-t border-[#2a2a38]" />

          <NavLink to="/media" className={({ isActive }) => navClass(isActive)}>
            <Image size={15} />
            Media Library
          </NavLink>

          <NavLink to="/frame-cut-optimizer" className={({ isActive }) => navClass(isActive)}>
            <Scissors size={15} />
            Frame Cut
          </NavLink>

          {/* ── Configurazione ── */}
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

          {/* ── Tools ── */}
          <SidebarGroup
            title="Tools"
            open={toolsOpen}
            onToggle={() => setToolsOpen(v => !v)}
          >
            {TOOL_NAV.map(({ id, label, Icon }) => {
              const active = toolsActive && (activeToolId === id || (!activeToolId && id === 'txt2img'))
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
          </SidebarGroup>

          <div className="my-2 border-t border-[#2a2a38]" />

          <NavLink to="/settings" className={({ isActive }) => navClass(isActive)}>
            <Settings size={15} />
            Impostazioni
          </NavLink>
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
