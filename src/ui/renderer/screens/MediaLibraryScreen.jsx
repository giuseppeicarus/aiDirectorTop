import {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react'
import {
  Image as ImageIcon, Film, Music, Upload, Search, Trash2,
  ExternalLink, FolderOpen, X, ChevronDown, Eye, Layers,
  Tag, Info, Check, Loader2, RefreshCw, Grid2X2, LayoutList,
  Play, Volume2, ZoomIn, ArrowLeft, ArrowRight, Link2,
} from 'lucide-react'
import clsx from 'clsx'

const API = 'http://localhost:8765/api'

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPE_TABS = [
  { key: 'all',   label: 'Tutto',    Icon: Layers  },
  { key: 'image', label: 'Immagini', Icon: ImageIcon },
  { key: 'video', label: 'Video',    Icon: Film    },
  { key: 'audio', label: 'Audio',    Icon: Music   },
]

const SOURCE_OPTS = [
  { key: 'all',       label: 'Tutti i sorgenti' },
  { key: 'uploaded',  label: 'Caricati'         },
  { key: 'generated', label: 'Generati dalla pipeline' },
]

const SORT_OPTS = [
  { key: 'date_desc', label: 'Data ↓' },
  { key: 'date_asc',  label: 'Data ↑' },
  { key: 'name',      label: 'Nome'   },
  { key: 'size',      label: 'Dimensione' },
]

const ACCEPT_TYPES = 'image/*,video/*,audio/*'
const GRID_SIZES   = ['sm', 'md', 'lg']
const GRID_COLS    = { sm: 'grid-cols-6', md: 'grid-cols-4', lg: 'grid-cols-3' }
const THUMB_H      = { sm: 'h-24', md: 'h-40', lg: 'h-56' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1_073_741_824) return `${(n / 1_048_576).toFixed(1)} MB`
  return `${(n / 1_073_741_824).toFixed(2)} GB`
}

function fmtDur(sec) {
  if (!sec) return null
  if (sec < 60) return `${Math.round(sec)}s`
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`
}

function fileType(mimeOrExt) {
  const s = (mimeOrExt || '').toLowerCase()
  if (s.startsWith('image') || /\.(jpg|jpeg|png|webp|gif|bmp|tiff?)$/.test(s)) return 'image'
  if (s.startsWith('video') || /\.(mp4|mov|avi|mkv|webm|wmv)$/.test(s)) return 'video'
  if (s.startsWith('audio') || /\.(mp3|wav|m4a|ogg|flac|aac)$/.test(s)) return 'audio'
  return null
}

function sortItems(items, sortKey) {
  const arr = [...items]
  switch (sortKey) {
    case 'date_asc':  return arr.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    case 'name':      return arr.sort((a, b) => a.filename.localeCompare(b.filename))
    case 'size':      return arr.sort((a, b) => b.size_bytes - a.size_bytes)
    default:          return arr.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
}

// ── MediaCard ─────────────────────────────────────────────────────────────────

function MediaCard({ item, thumbSize, onDelete, onPreview, onAssign }) {
  const isImage = item.type === 'image'
  const isVideo = item.type === 'video'
  const isAudio = item.type === 'audio'
  const h = THUMB_H[thumbSize]
  const tags = (() => { try { return JSON.parse(item.tags || '[]') } catch { return [] } })()

  return (
    <div className="group relative rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--bg2)] hover:border-[var(--gold)]/40 transition-colors">
      {/* Thumbnail */}
      <div className={clsx('relative overflow-hidden bg-[var(--bg3)] flex items-center justify-center', h)}>
        {isImage && (
          <img
            src={`${API}/media/thumb/${item.id}`}
            alt={item.filename}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={e => { e.currentTarget.style.display = 'none' }}
          />
        )}
        {isVideo && (
          <div className="flex flex-col items-center gap-1">
            <Film size={28} className="text-[var(--gold)] opacity-50" />
            {item.duration_sec && (
              <span className="text-[10px] text-[var(--text3)] font-mono">{fmtDur(item.duration_sec)}</span>
            )}
          </div>
        )}
        {isAudio && (
          <div className="flex flex-col items-center gap-1">
            <Volume2 size={28} className="text-[var(--gold)] opacity-50" />
            {item.duration_sec && (
              <span className="text-[10px] text-[var(--text3)] font-mono">{fmtDur(item.duration_sec)}</span>
            )}
          </div>
        )}

        {/* Source badge */}
        <span className={clsx(
          'absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded font-mono',
          item.source === 'uploaded'
            ? 'bg-blue-500/20 text-blue-400'
            : 'bg-[var(--gold)]/15 text-[var(--gold)]'
        )}>
          {item.source === 'uploaded' ? 'upload' : 'gen'}
        </span>

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <ActionBtn icon={Eye}        title="Preview"           onClick={() => onPreview(item)} />
          <ActionBtn icon={Link2}      title="Usa nel progetto"  onClick={() => onAssign(item)} gold />
          <ActionBtn icon={Trash2}     title="Elimina"           onClick={() => onDelete(item.id)} danger />
        </div>
      </div>

      {/* Info */}
      <div className="px-2 py-1.5">
        <p className="text-[10px] text-[var(--text)] truncate font-mono" title={item.filename}>
          {item.filename}
        </p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-[9px] text-[var(--text3)] truncate max-w-[70%]">
            {item.project_title !== '__library__' ? item.project_title : 'Libreria'}
          </span>
          <span className="text-[9px] text-[var(--text3)] font-mono shrink-0">{fmtBytes(item.size_bytes)}</span>
        </div>
        {item.width > 0 && (
          <p className="text-[9px] text-[var(--text3)] font-mono">{item.width}×{item.height}</p>
        )}
        {tags.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {tags.slice(0, 3).map(t => (
              <span key={t} className="text-[8px] px-1 py-0.5 rounded-sm bg-[var(--bg3)] text-[var(--text3)]">{t}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ActionBtn({ icon: Icon, title, onClick, gold, danger }) {
  return (
    <button
      title={title}
      onClick={e => { e.stopPropagation(); onClick() }}
      className={clsx(
        'p-1.5 rounded-lg bg-black/40 transition-colors',
        gold   ? 'text-[var(--gold)] hover:bg-[var(--gold)]/20' :
        danger ? 'text-[var(--text2)] hover:text-[var(--red)] hover:bg-red-500/20' :
                 'text-[var(--text2)] hover:text-[var(--text)] hover:bg-white/10'
      )}
    >
      <Icon size={13} />
    </button>
  )
}

// ── Upload progress toasts ────────────────────────────────────────────────────

function UploadToasts({ uploads }) {
  if (!uploads.length) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2 w-64">
      {uploads.map(u => (
        <div key={u.id} className="bg-[var(--bg2)] border border-[var(--border)] rounded-lg px-3 py-2.5 shadow-xl">
          <div className="flex items-center gap-2 mb-1.5">
            {u.status === 'uploading'
              ? <Loader2 size={12} className="text-[var(--gold)] animate-spin shrink-0" />
              : u.status === 'done'
              ? <Check size={12} className="text-[var(--green)] shrink-0" />
              : <X size={12} className="text-[var(--red)] shrink-0" />
            }
            <span className="text-[11px] text-[var(--text)] truncate">{u.filename}</span>
          </div>
          {u.status === 'uploading' && (
            <div className="h-0.5 rounded-full bg-[var(--bg3)] overflow-hidden">
              <div className="h-full bg-[var(--gold)] animate-pulse rounded-full w-2/3" />
            </div>
          )}
          {u.error && <p className="text-[10px] text-[var(--red)] mt-0.5">{u.error}</p>}
        </div>
      ))}
    </div>
  )
}

// ── Preview modal ─────────────────────────────────────────────────────────────

function PreviewModal({ item, allItems, onClose, onNavigate }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft')  onNavigate(-1)
      if (e.key === 'ArrowRight') onNavigate(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate])

  if (!item) return null
  const tags = (() => { try { return JSON.parse(item.tags || '[]') } catch { return [] } })()

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative max-w-5xl w-full max-h-[90vh] flex gap-4" onClick={e => e.stopPropagation()}>
        {/* Media */}
        <div className="flex-1 flex items-center justify-center rounded-xl overflow-hidden bg-black min-h-0">
          {item.type === 'image' && (
            <img
              src={`${API}/media/file/${item.id}`}
              alt={item.filename}
              className="max-w-full max-h-[80vh] object-contain"
            />
          )}
          {item.type === 'video' && (
            <video
              src={`${API}/media/file/${item.id}`}
              controls
              autoPlay
              className="max-w-full max-h-[80vh]"
            />
          )}
          {item.type === 'audio' && (
            <div className="flex flex-col items-center gap-4 p-8">
              <Volume2 size={48} className="text-[var(--gold)] opacity-50" />
              <audio src={`${API}/media/file/${item.id}`} controls autoPlay className="w-full" />
            </div>
          )}
        </div>

        {/* Info sidebar */}
        <div className="w-52 shrink-0 bg-[var(--bg1)] rounded-xl p-4 flex flex-col gap-3 overflow-y-auto">
          <p className="text-xs text-[var(--text)] font-mono break-all leading-snug">{item.filename}</p>
          <div className="space-y-1.5 text-[11px]">
            <InfoRow label="Tipo"     val={item.type} />
            <InfoRow label="Sorgente" val={item.source} />
            <InfoRow label="Progetto" val={item.project_title !== '__library__' ? item.project_title : 'Libreria'} />
            {item.width > 0 && <InfoRow label="Dimensioni" val={`${item.width}×${item.height}`} />}
            {item.duration_sec && <InfoRow label="Durata" val={fmtDur(item.duration_sec)} />}
            <InfoRow label="Peso" val={fmtBytes(item.size_bytes)} />
          </div>
          {tags.length > 0 && (
            <div>
              <p className="text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1.5">Tag</p>
              <div className="flex flex-wrap gap-1">
                {tags.map(t => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg3)] text-[var(--text2)]">{t}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Nav arrows */}
        <button
          onClick={() => onNavigate(-1)}
          className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <button
          onClick={() => onNavigate(1)}
          className="absolute right-[220px] top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <ArrowRight size={18} />
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1.5 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

function InfoRow({ label, val }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[var(--text3)] w-20 shrink-0">{label}</span>
      <span className="text-[var(--text2)] break-all">{val || '—'}</span>
    </div>
  )
}

// ── Assign panel ──────────────────────────────────────────────────────────────

function AssignPanel({ item, onClose, onDone }) {
  const [projects,  setProjects]  = useState([])
  const [shots,     setShots]     = useState([])
  const [projectId, setProjectId] = useState('')
  const [shotId,    setShotId]    = useState('')
  const [slot,      setSlot]      = useState('first_frame')
  const [loading,   setLoading]   = useState(false)
  const [result,    setResult]    = useState(null)

  // Determine available slot types based on media type
  const slotOptions = item?.type === 'video'
    ? [{ key: 'clip', label: 'Clip video' }]
    : item?.type === 'image'
    ? [{ key: 'first_frame', label: 'First Frame' }, { key: 'last_frame', label: 'Last Frame' }]
    : []

  useEffect(() => {
    fetch(`${API}/projects/`).then(r => r.json())
      .then(d => setProjects(Array.isArray(d) ? d : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!projectId) { setShots([]); return }
    fetch(`${API}/media/shots/${projectId}`).then(r => r.json())
      .then(d => setShots(d.shots || []))
      .catch(() => setShots([]))
  }, [projectId])

  async function assign() {
    if (!projectId || !shotId || !slot) return
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch(`${API}/media/${item.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, shot_id: shotId, slot }),
      }).then(r => r.json())
      setResult(res)
      if (res.ok) setTimeout(onDone, 1500)
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-[var(--bg1)] border border-[var(--border)] rounded-xl p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text)]">Usa nel progetto</h3>
          <button onClick={onClose} className="text-[var(--text3)] hover:text-[var(--text)]"><X size={14} /></button>
        </div>

        {/* File info */}
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg bg-[var(--bg3)]">
          {item.type === 'image' ? <ImageIcon size={14} className="text-[var(--gold)] shrink-0" /> :
           item.type === 'video' ? <Film size={14} className="text-[var(--gold)] shrink-0" /> :
           <Music size={14} className="text-[var(--gold)] shrink-0" />}
          <span className="text-xs text-[var(--text)] truncate font-mono">{item.filename}</span>
        </div>

        <div className="space-y-3">
          {/* Project */}
          <div>
            <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Progetto</label>
            <select
              value={projectId}
              onChange={e => { setProjectId(e.target.value); setShotId('') }}
              className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
            >
              <option value="">Seleziona progetto...</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
          </div>

          {/* Slot */}
          {slotOptions.length > 0 && (
            <div>
              <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Slot</label>
              <div className="flex gap-1.5">
                {slotOptions.map(s => (
                  <button
                    key={s.key}
                    onClick={() => setSlot(s.key)}
                    className={clsx(
                      'flex-1 py-1.5 text-xs rounded border transition-colors',
                      slot === s.key
                        ? 'border-[var(--gold)] bg-[var(--gold)]/10 text-[var(--gold)]'
                        : 'border-[var(--border)] text-[var(--text2)] hover:border-[var(--gold)]/40'
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Shot picker */}
          {projectId && (
            <div>
              <label className="block text-[10px] text-[var(--text3)] uppercase tracking-wider mb-1">Shot</label>
              {shots.length === 0 ? (
                <p className="text-xs text-[var(--text3)] py-2">Nessuno shot trovato — avvia prima la pipeline</p>
              ) : (
                <select
                  value={shotId}
                  onChange={e => setShotId(e.target.value)}
                  className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded px-3 py-2 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none max-h-24"
                >
                  <option value="">Seleziona shot...</option>
                  {shots.map(s => (
                    <option key={s.shot_id} value={s.shot_id}>
                      {s.shot_id} — {(s.scene_description || '').slice(0, 50)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {result && (
          <div className={clsx(
            'mt-3 px-3 py-2 rounded text-xs',
            result.ok
              ? 'bg-[var(--green)]/10 text-[var(--green)]'
              : 'bg-[var(--red)]/10 text-[var(--red)]'
          )}>
            {result.ok ? `✓ Assegnato a ${result.shot_id} (${result.slot})` : result.error}
          </div>
        )}

        <button
          onClick={assign}
          disabled={!projectId || !shotId || !slot || loading}
          className="w-full mt-4 flex items-center justify-center gap-2 py-2 text-xs rounded bg-[var(--gold)]/20 hover:bg-[var(--gold)]/30 text-[var(--gold)] disabled:opacity-40 transition-colors"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
          {loading ? 'Assegnazione...' : 'Assegna'}
        </button>
      </div>
    </div>
  )
}

// ── Drop overlay ──────────────────────────────────────────────────────────────

function DropOverlay({ visible }) {
  if (!visible) return null
  return (
    <div className="absolute inset-0 z-30 bg-[var(--gold)]/10 border-2 border-dashed border-[var(--gold)] rounded-xl flex items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center gap-3">
        <Upload size={40} className="text-[var(--gold)]" />
        <p className="text-lg font-display text-[var(--gold)]">Rilascia per caricare</p>
        <p className="text-sm text-[var(--text2)]">Immagini · Video · Audio</p>
      </div>
    </div>
  )
}

// ── Storage stats bar ─────────────────────────────────────────────────────────

function StatsBar({ stats }) {
  if (!stats) return null
  return (
    <div className="flex items-center gap-5 px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg2)] text-[11px]">
      <StatItem label="Totale" val={stats.total} />
      <div className="w-px h-4 bg-[var(--border)]" />
      <StatItem label="Immagini" val={stats.images} Icon={ImageIcon} />
      <StatItem label="Video"    val={stats.videos} Icon={Film}      />
      <StatItem label="Audio"    val={stats.audios || 0} Icon={Music}  />
      <div className="w-px h-4 bg-[var(--border)] ml-auto" />
      <span className="text-[var(--gold)] font-mono">{stats.size_gb || '0'} GB usati</span>
    </div>
  )
}

function StatItem({ label, val, Icon }) {
  return (
    <div className="flex items-center gap-1.5">
      {Icon && <Icon size={11} className="text-[var(--text3)]" />}
      <span className="text-[var(--text2)] font-mono">{val}</span>
      <span className="text-[var(--text3)]">{label}</span>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function MediaLibraryScreen() {
  const [items,      setItems]      = useState([])
  const [stats,      setStats]      = useState(null)
  const [loading,    setLoading]    = useState(false)
  const [typeFilter, setTypeFilter] = useState('all')
  const [srcFilter,  setSrcFilter]  = useState('all')
  const [sort,       setSort]       = useState('date_desc')
  const [search,     setSearch]     = useState('')
  const [gridSize,   setGridSize]   = useState('md')
  const [dragging,   setDragging]   = useState(false)
  const [uploads,    setUploads]    = useState([])    // [{id, filename, status, error}]
  const [preview,    setPreview]    = useState(null)  // item
  const [assignItem, setAssignItem] = useState(null)
  const [page,       setPage]       = useState(1)
  const PER_PAGE = 60

  const dropRef  = useRef(null)
  const fileRef  = useRef(null)
  let   dragCounter = useRef(0)

  // ── Data loading ────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [itemsRes, statsRes] = await Promise.all([
        fetch(`${API}/media?limit=500`).then(r => r.json()),
        fetch(`${API}/media/stats`).then(r => r.json()),
      ])
      setItems(Array.isArray(itemsRes) ? itemsRes : (itemsRes.items || []))
      setStats(statsRes)
    } catch { setItems([]) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // ── Filtering / sorting ─────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let arr = items
    if (typeFilter !== 'all') arr = arr.filter(i => i.type === typeFilter)
    if (srcFilter  !== 'all') arr = arr.filter(i => (i.source || 'generated') === srcFilter)
    if (search) {
      const q = search.toLowerCase()
      arr = arr.filter(i =>
        i.filename.toLowerCase().includes(q) ||
        (i.project_title || '').toLowerCase().includes(q) ||
        (i.tags || '').toLowerCase().includes(q)
      )
    }
    return sortItems(arr, sort)
  }, [items, typeFilter, srcFilter, search, sort])

  const paginated = filtered.slice(0, page * PER_PAGE)
  const hasMore   = paginated.length < filtered.length

  // ── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete(id) {
    if (!confirm('Eliminare questo file dal database e dal disco?')) return
    await fetch(`${API}/media/${id}`, { method: 'DELETE' })
    setItems(prev => prev.filter(i => i.id !== id))
    if (preview?.id === id) setPreview(null)
  }

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function uploadFiles(files) {
    const validFiles = Array.from(files).filter(f => {
      const t = fileType(f.type || f.name)
      return t !== null
    })
    if (!validFiles.length) return

    for (const file of validFiles) {
      const uploadId = Math.random().toString(36).slice(2)
      setUploads(prev => [...prev, { id: uploadId, filename: file.name, status: 'uploading' }])
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`${API}/media/upload`, { method: 'POST', body: fd }).then(r => r.json())
        if (res.id) {
          setItems(prev => [res, ...prev])
          setUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'done' } : u))
        } else {
          throw new Error(res.detail || 'Upload fallito')
        }
      } catch (e) {
        setUploads(prev => prev.map(u => u.id === uploadId ? { ...u, status: 'error', error: e.message } : u))
      } finally {
        setTimeout(() => setUploads(prev => prev.filter(u => u.id !== uploadId)), 4000)
      }
    }
    load() // refresh stats
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────────

  function onDragEnter(e) {
    e.preventDefault()
    dragCounter.current++
    setDragging(true)
  }
  function onDragLeave(e) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragging(false)
  }
  function onDragOver(e) { e.preventDefault() }
  function onDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragging(false)
    uploadFiles(e.dataTransfer.files)
  }

  // ── Preview navigation ───────────────────────────────────────────────────────

  function navigatePreview(delta) {
    if (!preview) return
    const idx = filtered.findIndex(i => i.id === preview.id)
    const next = filtered[(idx + delta + filtered.length) % filtered.length]
    if (next) setPreview(next)
  }

  // ── Type counts ──────────────────────────────────────────────────────────────

  const counts = useMemo(() => ({
    all:   items.length,
    image: items.filter(i => i.type === 'image').length,
    video: items.filter(i => i.type === 'video').length,
    audio: items.filter(i => i.type === 'audio').length,
  }), [items])

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-5 h-full flex flex-col overflow-hidden relative"
      ref={dropRef}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DropOverlay visible={dragging} />

      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <ImageIcon size={18} className="text-[var(--gold)]" />
          <h1 className="font-display text-xl text-[var(--text)]">Media Library</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="p-1.5 rounded border border-[var(--border)] text-[var(--text3)] hover:text-[var(--gold)] hover:border-[var(--gold)]/40 transition-colors"
            title="Aggiorna"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-3 py-1.5 text-xs rounded bg-[var(--gold)]/15 hover:bg-[var(--gold)]/25 text-[var(--gold)] transition-colors"
          >
            <Upload size={13} /> Carica file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT_TYPES}
            multiple
            className="hidden"
            onChange={e => { uploadFiles(e.target.files); e.target.value = '' }}
          />
        </div>
      </div>

      {/* Stats bar */}
      <div className="mb-4 shrink-0">
        <StatsBar stats={stats} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4 shrink-0 flex-wrap gap-y-2">
        {/* Type tabs */}
        <div className="flex gap-0.5 bg-[var(--bg2)] rounded-lg p-0.5 border border-[var(--border)]">
          {TYPE_TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => { setTypeFilter(key); setPage(1) }}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors',
                typeFilter === key
                  ? 'bg-[var(--gold)] text-black font-medium'
                  : 'text-[var(--text2)] hover:text-[var(--text)]'
              )}
            >
              <Icon size={11} />
              {label}
              <span className={clsx(
                'text-[9px] font-mono',
                typeFilter === key ? 'opacity-70' : 'text-[var(--text3)]'
              )}>
                {counts[key]}
              </span>
            </button>
          ))}
        </div>

        {/* Source filter */}
        <select
          value={srcFilter}
          onChange={e => { setSrcFilter(e.target.value); setPage(1) }}
          className="bg-[var(--bg2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
        >
          {SOURCE_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-32 max-w-60">
          <Search size={11} className="absolute left-2.5 top-2 text-[var(--text3)]" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Cerca file, progetto, tag..."
            className="w-full bg-[var(--bg2)] border border-[var(--border)] rounded pl-7 pr-3 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none font-mono"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-2 text-[var(--text3)] hover:text-[var(--text)]">
              <X size={11} />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Sort */}
          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="bg-[var(--bg2)] border border-[var(--border)] rounded px-2.5 py-1.5 text-xs text-[var(--text)] focus:border-[var(--gold)] outline-none"
          >
            {SORT_OPTS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>

          {/* Grid size */}
          <div className="flex gap-0.5 bg-[var(--bg2)] rounded border border-[var(--border)] p-0.5">
            {GRID_SIZES.map(s => (
              <button
                key={s}
                onClick={() => setGridSize(s)}
                className={clsx(
                  'px-2 py-1 rounded text-[10px] transition-colors',
                  gridSize === s ? 'bg-[var(--bg3)] text-[var(--text)]' : 'text-[var(--text3)] hover:text-[var(--text2)]'
                )}
              >
                {s === 'sm' ? 'S' : s === 'md' ? 'M' : 'L'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results count */}
      <div className="text-[11px] text-[var(--text3)] mb-3 shrink-0">
        {loading ? 'Caricamento...' : `${filtered.length} file ${search ? `per "${search}"` : ''}`}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto pr-1">
        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <ImageIcon size={48} className="text-[var(--text3)] opacity-20 mb-4" />
            <p className="text-[var(--text3)] text-sm mb-2">Nessun file trovato</p>
            <p className="text-[var(--text3)] text-xs opacity-60">
              Trascina file qui o usa "Carica file" per aggiungere media
            </p>
          </div>
        )}

        {paginated.length > 0 && (
          <div className={clsx('grid gap-2', GRID_COLS[gridSize])}>
            {paginated.map(item => (
              <MediaCard
                key={item.id}
                item={item}
                thumbSize={gridSize}
                onDelete={handleDelete}
                onPreview={setPreview}
                onAssign={setAssignItem}
              />
            ))}
          </div>
        )}

        {hasMore && (
          <button
            onClick={() => setPage(p => p + 1)}
            className="w-full mt-4 py-2 text-xs text-[var(--text3)] hover:text-[var(--gold)] border border-[var(--border)] rounded-lg transition-colors"
          >
            Carica altri ({filtered.length - paginated.length})
          </button>
        )}
      </div>

      {/* Drag hint */}
      {!dragging && items.length === 0 && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-3 opacity-20">
            <Upload size={48} className="text-[var(--text3)]" />
            <p className="text-[var(--text3)]">Trascina file qui per iniziare</p>
          </div>
        </div>
      )}

      {/* Modals */}
      {preview && (
        <PreviewModal
          item={preview}
          allItems={filtered}
          onClose={() => setPreview(null)}
          onNavigate={navigatePreview}
        />
      )}
      {assignItem && (
        <AssignPanel
          item={assignItem}
          onClose={() => setAssignItem(null)}
          onDone={() => setAssignItem(null)}
        />
      )}

      {/* Upload toasts */}
      <UploadToasts uploads={uploads} />
    </div>
  )
}
