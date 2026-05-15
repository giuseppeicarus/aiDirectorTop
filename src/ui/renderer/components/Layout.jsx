import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Film, FolderOpen, Settings, Plus, Circle, Scissors, ListChecks, Zap, Wrench, Image, GitBranch } from 'lucide-react'
import { useConfigStore, usePipelineStore } from '../stores'
import { useEffect } from 'react'
import clsx from 'clsx'

export default function Layout() {
  const { nodes, loadNodes } = useConfigStore()
  const { stage } = usePipelineStore()
  const navigate = useNavigate()
  const pipelineActive = !['idle', 'done', 'error'].includes(stage)

  useEffect(() => { loadNodes() }, [])

  const onlineCount = nodes.filter(n => n.online).length

  return (
    <div className="flex h-screen bg-[#0a0a0f] text-[#f0ede8] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-[#12121a] border-r border-[#2a2a38] flex flex-col shrink-0">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-[#2a2a38]">
          <div className="flex items-center gap-2">
            <Film className="text-[#c9a84c]" size={20} />
            <span className="font-['Playfair_Display'] text-sm font-semibold tracking-wide text-[#c9a84c]">
              CinematicAI
            </span>
          </div>
          <p className="text-[10px] text-[#9090a0] mt-1 ml-7">Studio</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          <button
            onClick={() => navigate('/projects/new')}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md
                       bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 text-[#c9a84c]
                       text-sm transition-colors mb-3"
          >
            <Plus size={15} />
            <span>Nuovo Progetto</span>
          </button>

          <NavLink to="/projects" end className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <FolderOpen size={15} />
            Progetti
          </NavLink>

          <NavLink to="/nodes" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <Zap size={15} />
            Nodi ComfyUI
          </NavLink>

          <NavLink to="/services" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <Wrench size={15} />
            Servizi
          </NavLink>

          <NavLink to="/workflows" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <GitBranch size={15} />
            Workflow
          </NavLink>

          <div className="my-2 border-t border-[#2a2a38]" />

          <NavLink to="/media" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <Image size={15} />
            Media Library
          </NavLink>

          <NavLink to="/frame-cut-optimizer" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <Scissors size={15} />
            Frame Cut
          </NavLink>

          <NavLink to="/queue" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors relative',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <ListChecks size={15} />
            Code & Monitor
            {pipelineActive && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[#c9a84c] animate-pulse" />
            )}
          </NavLink>

          <div className="my-2 border-t border-[#2a2a38]" />

          <NavLink to="/settings" className={({ isActive }) =>
            clsx('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              isActive ? 'bg-[#1a1a24] text-[#f0ede8]' : 'text-[#9090a0] hover:text-[#f0ede8] hover:bg-[#1a1a24]')
          }>
            <Settings size={15} />
            Impostazioni
          </NavLink>
        </nav>

        {/* Node status */}
        <div className="px-4 py-3 border-t border-[#2a2a38]">
          <div className="text-[10px] text-[#9090a0] mb-2 uppercase tracking-wider">ComfyUI Nodes</div>
          {nodes.length === 0 ? (
            <p className="text-[11px] text-[#9090a0]">Nessun nodo configurato</p>
          ) : (
            nodes.map((node) => (
              <div key={node.host + node.port} className="flex items-center gap-2 mb-1">
                <Circle
                  size={7}
                  className={node.online ? 'text-green-500 fill-green-500' : 'text-red-500 fill-red-500'}
                />
                <span className="text-[11px] text-[#9090a0] truncate">{node.name}</span>
                {node.online && node.queue_depth > 0 && (
                  <span className="text-[10px] text-[#c9a84c] ml-auto">{node.queue_depth}</span>
                )}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
