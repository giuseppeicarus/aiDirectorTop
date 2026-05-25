import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle, Download, ImagePlus, Loader2, Pause, Play, PlayCircle, RefreshCw, Trash2,
  Upload, UserRound, Wand2, X, FolderOpen,
} from 'lucide-react'
import clsx from 'clsx'
import { BACKEND_ORIGIN } from '../utils/apiClient'
import ElegantLoader from '../components/ElegantLoader'

const API = `${BACKEND_ORIGIN}/api`
const MIN_IMAGES = 20
const PROFILES = [
  { key: 'Low', label: 'Low', hint: 'rapido e leggero' },
  { key: 'Medium', label: 'Medium', hint: 'bilanciato' },
  { key: 'High', label: 'High', hint: 'massima qualita' },
]
const CAPTION_MODES = [
  { key: 'mista', label: 'Mista' },
  { key: 'manuale', label: 'Manuale' },
  { key: 'auto', label: 'Auto' },
]
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'])

function filePreview(file) {
  return URL.createObjectURL(file)
}

function isImageFile(file) {
  if (/^image\//.test(file.type || '')) return true
  const ext = String(file.name || '').split('.').pop()?.toLowerCase()
  return Boolean(ext && IMAGE_EXTENSIONS.has(ext))
}

function statusTone(status) {
  if (status === 'completato') return 'text-[#22c55e] bg-[#22c55e]/10'
  if (status === 'in_creazione') return 'text-[#c9a84c] bg-[#c9a84c]/10'
  if (status === 'sospeso') return 'text-[#f59e0b] bg-[#f59e0b]/10'
  if (status === 'errore') return 'text-[#ef4444] bg-[#ef4444]/10'
  return 'text-[#9090a8] bg-[#252533]'
}

function CharacterCard({ character, onOpen, onDelete }) {
  return (
    <div className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
      <button type="button" onClick={() => onOpen(character.id)} className="block w-full aspect-[4/3] bg-[#0f0f18]">
        {character.preview_path ? (
          <img
            src={`${API}/reel/source?path=${encodeURIComponent(character.preview_path)}`}
            alt={character.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[#555568]">
            <UserRound size={34} />
          </div>
        )}
      </button>
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-[#e8e4dd] truncate">{character.name}</p>
          <span className={clsx('px-1.5 py-0.5 rounded text-[9px] font-mono', statusTone(character.status))}>
            {character.status}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-[#9090a8]">
          <span>{character.profile}</span>
          <span>{character.valid_image_count} foto valide</span>
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={() => onOpen(character.id)} className="flex-1 px-2 py-1.5 rounded bg-[#252533] text-xs text-[#e8e4dd]">
            Dettaglio
          </button>
          <button onClick={() => onDelete(character.id)} className="px-2 py-1.5 rounded bg-[#ef4444]/10 text-[#ef4444]">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

function ElegantImage({ src, alt, className }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="relative w-full h-full flex items-center justify-center bg-[#0f0f18] aspect-square overflow-hidden">
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0f0f18] z-10">
          <Loader2 size={16} className="text-[#c9a84c] animate-spin" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={clsx(
          className,
          "transition-all duration-500 w-full h-full object-cover",
          loaded ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-95 blur-sm"
        )}
      />
    </div>
  )
}


function DetailView({ record, onBack, onRefresh, onStart, onDelete }) {
  const [loras, setLoras] = useState([])
  const [loraError, setLoraError] = useState('')
  const [editedCaptions, setEditedCaptions] = useState({})
  const [saving, setSaving] = useState(false)
  const [checkpointsData, setCheckpointsData] = useState(null)
  const [zoomImgUrl, setZoomImgUrl] = useState(null)
  const [zoomStep, setZoomStep] = useState(null)

  const logsContainerRef = useRef(null)

  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight
    }
  }, [record?.logs])

  const [actionLoading, setActionLoading] = useState(false)
  const [exportingId, setExportingId] = useState(null)

  const handleExport = async (loraId) => {
    if (!loraId) return
    setExportingId(loraId)
    try {
      let targetDir = ''
      if (window.studio?.dialog?.openDirectory) {
        const result = await window.studio.dialog.openDirectory()
        if (result && !result.canceled && result.filePaths?.[0]) {
          targetDir = result.filePaths[0]
        } else {
          setExportingId(null)
          return
        }
      } else {
        const val = window.prompt("Inserisci percorso locale della cartella di destinazione (es. F:/ComfyUI/models/loras):")
        if (val !== null && val.trim()) {
          targetDir = val.trim()
        } else {
          setExportingId(null)
          return
        }
      }

      const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/loras/${encodeURIComponent(loraId)}/export?target_dir=${encodeURIComponent(targetDir)}`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        alert(data.message || 'LoRA esportato con successo!')
      } else {
        alert(data.detail || 'Impossibile esportare il LoRA')
      }
    } catch (e) {
      alert(`Errore di rete: ${e.message}`)
    } finally {
      setExportingId(null)
    }
  }

  const handlePause = async () => {
    setActionLoading(true)
    try {
      const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/pause`, {
        method: 'POST',
      })
      if (res.ok) {
        onRefresh()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.detail || 'Impossibile sospendere il training')
      }
    } catch {
      alert('Errore di rete durante la sospensione del training')
    } finally {
      setActionLoading(false)
    }
  }

  const handleResume = async () => {
    setActionLoading(true)
    try {
      const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/resume`, {
        method: 'POST',
      })
      if (res.ok) {
        onRefresh()
      } else {
        const err = await res.json().catch(() => ({}))
        alert(err.detail || 'Impossibile riprendere il training')
      }
    } catch {
      alert('Errore di rete durante la ripresa del training')
    } finally {
      setActionLoading(false)
    }
  }

  const [activeCaptionId, setActiveCaptionId] = useState(null)
  const [modalText, setModalText] = useState('')
  const [isModalMounted, setIsModalMounted] = useState(false)
  const [showModalAnim, setShowModalAnim] = useState(false)

  // Open modal
  const openModal = (imgId) => {
    setActiveCaptionId(imgId)
    setIsModalMounted(true)
    setTimeout(() => {
      setShowModalAnim(true)
    }, 10)
  }

  // Close modal
  const closeModal = () => {
    setShowModalAnim(false)
    setTimeout(() => {
      setIsModalMounted(false)
      setActiveCaptionId(null)
    }, 300) // matches transition duration
  }

  const handleSaveModal = () => {
    if (activeCaptionId) {
      setEditedCaptions(prev => ({ ...prev, [activeCaptionId]: modalText }))
    }
    closeModal()
  }

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      handleSaveModal()
    }
  }

  const [autoCaptioning, setAutoCaptioning] = useState(false)

  const handleAutoCaptionSingle = async () => {
    if (!activeCaptionId) return
    setAutoCaptioning(true)
    try {
      const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/images/${encodeURIComponent(activeCaptionId)}/autocaption`, {
        method: 'POST',
      })
      const data = await res.json()
      if (res.ok && data.caption) {
        setModalText(data.caption)
      } else {
        alert(data.detail || 'Errore durante la generazione automatica della caption')
      }
    } catch {
      alert('Errore di rete durante la generazione automatica')
    } finally {
      setAutoCaptioning(false)
    }
  }

  // Sync modal text on open
  useEffect(() => {
    if (activeCaptionId) {
      const img = record.images.find(i => i.id === activeCaptionId)
      if (img) {
        const currentVal = editedCaptions[img.id] !== undefined
          ? editedCaptions[img.id]
          : (img.manual_caption || img.auto_caption || '')
        setModalText(currentVal)
      }
    }
  }, [activeCaptionId, record.images, editedCaptions])

  const activeImg = activeCaptionId ? record.images.find(i => i.id === activeCaptionId) : null

  const isEditable = record.status !== 'in_creazione'
  const hasChanges = Object.keys(editedCaptions).length > 0

  const handleSaveCaptions = async () => {
    setSaving(true)
    try {
      const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captions: editedCaptions }),
      })
      if (res.ok) {
        setEditedCaptions({})
        onRefresh()
      } else {
        alert('Errore durante il salvataggio delle caption')
      }
    } catch {
      alert('Errore di rete durante il salvataggio')
    } finally {
      setSaving(false)
    }
  }

  const previewUrl = record?.preview_path
    ? `${API}/reel/source?path=${encodeURIComponent(record.preview_path)}`
    : null

  useEffect(() => {
    let cancelled = false
    async function loadLoras() {
      if (!record?.id) return
      setLoraError('')
      try {
        const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/loras`)
        const data = await res.json().catch(() => [])
        if (!cancelled) {
          if (res.ok) setLoras(Array.isArray(data) ? data : [])
          else {
            setLoras([])
            setLoraError(data.detail || 'Impossibile leggere i LoRA')
          }
        }
      } catch {
        if (!cancelled) {
          setLoras([])
          setLoraError('Impossibile leggere i LoRA')
        }
      }
    }
    loadLoras()
    return () => { cancelled = true }
  }, [record?.id, record?.config?.ai_toolkit?.lora_path])

  useEffect(() => {
    let cancelled = false
    async function loadCheckpoints() {
      if (!record?.id) return
      try {
        const res = await fetch(`${API}/characters/${encodeURIComponent(record.id)}/checkpoints`)
        if (res.ok && !cancelled) {
          const data = await res.json()
          setCheckpointsData(data)
        }
      } catch (err) {
        console.error("Errore caricamento checkpoint:", err)
      }
    }
    loadCheckpoints()
    // Poll more frequently if currently training
    let intervalId = null
    if (record?.status === 'in_creazione') {
      intervalId = setInterval(loadCheckpoints, 2000)
    }
    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [record?.id, record?.status, record?.progress])

  function formatBytes(size) {
    if (!Number.isFinite(size)) return '0 B'
    if (size >= 1024 * 1024 * 1024) return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`
    if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${size} B`
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-6 py-4 border-b border-[#252533] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <UserRound className="text-[#c9a84c]" size={20} />
          <div>
            <h1 className="font-['Playfair_Display'] text-xl text-[#e8e4dd]">{record.name}</h1>
            <p className="text-[10px] font-mono text-[#9090a8]">
              {record.profile} · {record.valid_image_count} immagini valide · {new Date(record.created_at).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          {/* Pausa — visibile solo durante il training */}
          {record.status === 'in_creazione' && (
            <button
              onClick={handlePause}
              disabled={actionLoading}
              title="Sospendi training"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#f59e0b]/10 text-[#f59e0b] text-xs font-semibold hover:bg-[#f59e0b]/25 border border-[#f59e0b]/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading ? <Loader2 size={13} className="animate-spin" /> : <Pause size={13} />}
              Pausa
            </button>
          )}
          {/* Riprendi — visibile solo quando sospeso */}
          {record.status === 'sospeso' && (
            <button
              onClick={handleResume}
              disabled={actionLoading}
              title="Riprendi training"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#22c55e]/10 text-[#22c55e] text-xs font-semibold hover:bg-[#22c55e]/25 border border-[#22c55e]/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {actionLoading ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
              Riprendi
            </button>
          )}
          <button onClick={onBack} className="px-3 py-1.5 rounded border border-[#252533] text-xs text-[#9090a8]">Lista</button>
          <button onClick={onRefresh} className="px-3 py-1.5 rounded border border-[#252533] text-xs text-[#9090a8]">
            <RefreshCw size={13} />
          </button>
          <button onClick={() => onDelete(record.id)} className="px-3 py-1.5 rounded bg-[#ef4444]/10 text-xs text-[#ef4444]">
            Elimina
          </button>
        </div>
      </header>

      <div className={clsx("flex-1 p-6 grid grid-cols-[minmax(0,1fr)_320px] gap-5", record.status === 'in_creazione' ? "overflow-hidden min-h-0" : "overflow-y-auto")}>
        <section className={clsx("space-y-4", record.status === 'in_creazione' && "h-full flex flex-col space-y-0 gap-4 min-h-0")}>
          <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
            <div className="flex items-center justify-between mb-2">
              <span className={clsx('px-2 py-1 rounded text-[10px] font-mono', statusTone(record.status))}>{record.status}</span>
              {record.status !== 'in_creazione' && (
                <div className="flex gap-2">
                  {hasChanges && (
                    <button
                      onClick={handleSaveCaptions}
                      disabled={saving}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#22c55e]/15 text-[#22c55e] text-xs font-semibold hover:bg-[#22c55e]/25 transition"
                    >
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
                      Salva Caption
                    </button>
                  )}
                  <button
                    onClick={() => onStart(record.id)}
                    disabled={hasChanges}
                    title={hasChanges ? "Salva le modifiche prima di avviare" : "Avvia creazione"}
                    className={clsx(
                      "flex items-center gap-2 px-3 py-1.5 rounded text-xs transition",
                      hasChanges
                        ? "bg-[#c9a84c]/5 text-[#c9a84c]/30 cursor-not-allowed border border-[#c9a84c]/10"
                        : "bg-[#c9a84c]/15 text-[#c9a84c] hover:bg-[#c9a84c]/25"
                    )}
                  >
                    <Play size={13} /> Avvia creazione
                  </button>
                </div>
              )}
            </div>
            <div className="h-2 rounded-full bg-[#0f0f18] overflow-hidden">
              <div className="h-full bg-[#c9a84c]" style={{ width: `${record.progress || 0}%` }} />
            </div>
            {record.error && (
              <p className="mt-3 text-xs font-mono text-[#ef4444]">{record.error}</p>
            )}
          </div>

          {/* Pipeline Addestramento Live & Checkpoint */}
          {record.status !== 'bozza' && checkpointsData && checkpointsData.checkpoints && checkpointsData.checkpoints.length > 0 && (
            <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
              <div className="flex items-center justify-between mb-3 border-b border-[#252533] pb-2">
                <h2 className="text-xs font-mono uppercase tracking-wider text-[#9090a8] flex items-center gap-1.5">
                  <Wand2 size={13} className="text-[#c9a84c]" />
                  Pipeline Checkpoint Live
                </h2>
                {checkpointsData.current_step > 0 && (
                  <span className="text-[10px] font-mono text-[#c9a84c] bg-[#c9a84c]/10 px-2 py-0.5 rounded font-bold">
                    Step {checkpointsData.current_step} / {checkpointsData.total_steps}
                  </span>
                )}
              </div>
              
              <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin">
                {checkpointsData.checkpoints.map((cp, idx) => {
                  const prevStep = idx === 0 ? 0 : checkpointsData.checkpoints[idx-1].step;
                  const isCurrent = checkpointsData.current_step >= prevStep && checkpointsData.current_step < cp.step && record.status === 'in_creazione';
                  
                  return (
                    <div key={cp.step} className={clsx(
                      "flex-shrink-0 w-44 rounded-lg border p-3 flex flex-col justify-between transition-all duration-300",
                      cp.exists 
                        ? "border-[#c9a84c]/50 bg-[#1e1e2a]/40 shadow-[0_2px_8px_rgba(201,168,76,0.05)]" 
                        : isCurrent
                          ? "border-[#c9a84c] bg-[#c9a84c]/5 shadow-[0_0_12px_rgba(201,168,76,0.15)] animate-pulse"
                          : "border-[#252533] bg-[#0f0f18] opacity-50"
                    )}>
                      <div>
                        <div className="flex items-center justify-between gap-1.5 mb-2">
                          <span className={clsx(
                            "text-[10px] font-mono font-bold px-1.5 py-0.5 rounded",
                            cp.exists
                              ? "text-[#22c55e] bg-[#22c55e]/10"
                              : isCurrent
                                ? "text-[#c9a84c] bg-[#c9a84c]/10 animate-pulse"
                                : "text-[#555568] bg-[#252533]"
                          )}>
                            Step {cp.step}
                          </span>
                          {cp.exists && (
                            <span className="text-[8px] font-mono text-[#22c55e]">Pronto</span>
                          )}
                          {isCurrent && (
                            <span className="text-[8px] font-mono text-[#c9a84c] animate-pulse">In corso</span>
                          )}
                        </div>
                        
                        {/* Sample Image Preview */}
                        <div className="aspect-square rounded bg-black/40 overflow-hidden border border-[#252533]/80 relative group mb-3 flex items-center justify-center">
                          {cp.sample_url ? (
                            <>
                              <img 
                                src={cp.sample_url} 
                                alt={`Sample step ${cp.step}`} 
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105 cursor-pointer"
                                onClick={() => { setZoomImgUrl(cp.sample_url); setZoomStep(cp.step); }}
                              />
                              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center cursor-pointer" onClick={() => { setZoomImgUrl(cp.sample_url); setZoomStep(cp.step); }}>
                                <span className="text-[9px] font-mono text-white bg-black/80 px-2 py-1 rounded">Zoom</span>
                              </div>
                            </>
                          ) : (
                            <div className="text-[10px] font-mono text-[#555568] text-center p-2">
                              {isCurrent ? (
                                <div className="flex flex-col items-center gap-1.5">
                                  <Loader2 size={14} className="animate-spin text-[#c9a84c]" />
                                  <span>Addestramento...</span>
                                </div>
                              ) : (
                                "Non ancora creato"
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between gap-1 border-t border-[#252533]/50 pt-2 mt-1">
                        <span className="text-[8px] font-mono text-[#9090a8] truncate max-w-[70px]">
                          {cp.exists ? formatBytes(cp.size_bytes) : "In attesa"}
                        </span>
                        <div className="flex gap-1">
                          {cp.exists && cp.lora_id ? (
                            <>
                              <button
                                onClick={() => handleExport(cp.lora_id)}
                                disabled={exportingId === cp.lora_id}
                                className="p-1 rounded bg-[#3b82f6]/20 text-[#3b82f6] hover:bg-[#3b82f6] hover:text-white transition disabled:opacity-50"
                                title="Esporta in locale"
                              >
                                {exportingId === cp.lora_id ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <FolderOpen size={11} />
                                )}
                              </button>
                              <a
                                href={`${API}/characters/${encodeURIComponent(record.id)}/loras/${encodeURIComponent(cp.lora_id)}/download`}
                                className="p-1 rounded bg-[#c9a84c]/20 text-[#c9a84c] hover:bg-[#c9a84c] hover:text-black transition"
                                title="Scarica checkpoint"
                              >
                                <Download size={11} />
                              </a>
                            </>
                          ) : (
                            <>
                              <span className="p-1 text-[#32324a] cursor-not-allowed">
                                <FolderOpen size={11} />
                              </span>
                              <span className="p-1 text-[#32324a] cursor-not-allowed">
                                <Download size={11} />
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className={clsx("rounded-lg border border-[#252533] bg-[#16161f] p-4", record.status === 'in_creazione' && "flex-1 flex flex-col min-h-0")}>
            <h2 className="text-xs font-mono uppercase tracking-wider text-[#9090a8] mb-3">Log processo</h2>
            <div
              ref={logsContainerRef}
              className={clsx("overflow-y-auto space-y-1", record.status === 'in_creazione' ? "flex-1 min-h-0" : "max-h-52")}
            >
              {(record.logs || []).map((line, idx) => (
                <p key={`${idx}-${line}`} className="text-[11px] font-mono text-[#9090a8]">{line}</p>
              ))}
            </div>
          </div>

          {record.status !== 'in_creazione' && (
            <div className="grid grid-cols-5 gap-2">
              {record.images.map(img => (
                <div key={img.id} className={clsx('rounded border bg-[#0f0f18] overflow-hidden flex flex-col', img.valid && !img.duplicate ? 'border-[#252533]' : 'border-[#ef4444]/50')}>
                  <div className="aspect-square overflow-hidden">
                    <ElegantImage src={`${API}/reel/source?path=${encodeURIComponent(img.filepath)}`} alt={img.filename} />
                  </div>
                  {isEditable ? (
                    <button
                      type="button"
                      onClick={() => openModal(img.id)}
                      className="w-full text-left bg-[#0f0f18] hover:bg-[#1e1e2a] border-t border-[#252533] p-2 text-[10px] text-[#e8e4dd] min-h-12 flex flex-col justify-between group transition duration-200"
                    >
                      <span className="line-clamp-2 text-[#e8e4dd] font-mono leading-tight">
                        {editedCaptions[img.id] !== undefined ? editedCaptions[img.id] : (img.manual_caption || img.auto_caption || 'Clicca per aggiungere caption...')}
                      </span>
                      <span className="mt-1 text-[8px] text-[#9090a8] group-hover:text-[#c9a84c] flex items-center gap-1 self-end transition">
                        <Wand2 size={9} /> modifica
                      </span>
                    </button>
                  ) : (
                    <p className="px-1.5 py-1 text-[8px] font-mono text-[#9090a8] truncate" title={img.final_caption || img.error || ''}>
                      {img.duplicate ? 'duplicata' : img.valid ? (img.final_caption || 'caption vuota') : img.error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className={clsx("space-y-4", record.status === 'in_creazione' && "h-full overflow-y-auto")}>
          <div className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
            <div className="aspect-[4/3] bg-[#0f0f18] flex items-center justify-center">
              {previewUrl ? <img src={previewUrl} alt={record.name} className="w-full h-full object-cover" /> : <UserRound size={42} className="text-[#555568]" />}
            </div>
            <div className="p-3 space-y-1 text-[11px] font-mono text-[#9090a8]">
              <p>Profilo: {record.profile}</p>
              <p>Caption: {record.caption_mode}</p>
              <p>Media ID: {record.media_item_id || 'non pubblicato'}</p>
            </div>
          </div>

          <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-mono uppercase tracking-wider text-[#9090a8]">LoRA</h2>
              <span className="text-[10px] font-mono text-[#555568]">{loras.length}</span>
            </div>
            {loraError && <p className="text-[11px] font-mono text-[#ef4444]">{loraError}</p>}
            {!loraError && loras.length === 0 && (
              <p className="text-[11px] font-mono text-[#555568]">
                Nessun LoRA disponibile per questo personaggio.
              </p>
            )}
            <div className="space-y-2">
              {loras.map(lora => (
                <div key={lora.id} className="rounded border border-[#252533] bg-[#0f0f18] p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] text-[#e8e4dd] truncate" title={lora.filename}>{lora.filename}</p>
                      <p className="mt-1 text-[9px] font-mono text-[#9090a8]">
                        {formatBytes(lora.size_bytes)}{lora.primary ? ' · principale' : ''}
                      </p>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => handleExport(lora.id)}
                        disabled={exportingId === lora.id}
                        className="p-1.5 rounded bg-[#3b82f6]/15 text-[#3b82f6] hover:bg-[#3b82f6] hover:text-white transition disabled:opacity-50"
                        title="Esporta in locale"
                      >
                        {exportingId === lora.id ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <FolderOpen size={13} />
                        )}
                      </button>
                      <a
                        href={`${API}/characters/${encodeURIComponent(record.id)}/loras/${encodeURIComponent(lora.id)}/download`}
                        className="p-1.5 rounded bg-[#c9a84c]/15 text-[#c9a84c] hover:bg-[#c9a84c] hover:text-black transition"
                        title="Scarica LoRA"
                      >
                        <Download size={13} />
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {isModalMounted && activeImg && (
        <div
          onClick={handleBackdropClick}
          className={clsx(
            "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md transition-opacity duration-300 ease-out",
            showModalAnim ? "opacity-100" : "opacity-0"
          )}
        >
          <div
            className={clsx(
              "bg-[#16161f] border border-[#32324a] rounded-xl overflow-hidden max-w-lg w-full shadow-2xl flex flex-col transform transition-all duration-300 ease-out",
              showModalAnim ? "scale-100 opacity-100" : "scale-95 opacity-0"
            )}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[#252533] flex items-center justify-between bg-[#0f0f18]">
              <span className="text-xs font-mono uppercase tracking-wider text-[#9090a8]">Modifica Caption</span>
              <button onClick={closeModal} className="text-[#9090a8] hover:text-white transition">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 flex flex-col gap-4 bg-[#16161f]">
              {/* Image Preview */}
              <div className="aspect-[4/3] max-h-60 rounded bg-black/40 overflow-hidden border border-[#252533] flex items-center justify-center">
                <img
                  src={`${API}/reel/source?path=${encodeURIComponent(activeImg.filepath)}`}
                  alt={activeImg.filename}
                  className="max-w-full max-h-full object-contain"
                />
              </div>

              {/* Textarea */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-mono text-[#9090a8] uppercase">Caption del Personaggio</label>
                  <button
                    type="button"
                    onClick={handleAutoCaptionSingle}
                    disabled={autoCaptioning}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#c9a84c]/10 hover:bg-[#c9a84c]/20 border border-[#c9a84c]/20 text-[#c9a84c] text-[10px] font-mono font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {autoCaptioning ? (
                      <>
                        <Loader2 size={10} className="animate-spin" />
                        Generazione...
                      </>
                    ) : (
                      <>
                        <Wand2 size={10} />
                        AutoCaption LLM
                      </>
                    )}
                  </button>
                </div>
                <textarea
                  value={modalText}
                  onChange={e => setModalText(e.target.value)}
                  disabled={autoCaptioning}
                  rows={4}
                  placeholder="Descrivi i dettagli fisici, espressioni, o abbigliamento per coerenza..."
                  className="w-full bg-[#0f0f18] border border-[#252533] rounded-lg p-3 text-sm text-[#e8e4dd] focus:outline-none focus:border-[#c9a84c] transition resize-none font-mono leading-relaxed disabled:opacity-60"
                  autoFocus
                />
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-[#252533] flex justify-end gap-2 bg-[#0f0f18]">
              <button
                onClick={closeModal}
                disabled={autoCaptioning}
                className="px-3 py-1.5 rounded border border-[#252533] text-xs text-[#9090a8] hover:bg-[#252533]/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveModal}
                disabled={autoCaptioning}
                className="px-4 py-1.5 rounded bg-[#c9a84c] text-black text-xs font-semibold hover:bg-[#e6c46a] transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Salva
              </button>
            </div>
          </div>
        </div>
      )}

      {zoomImgUrl && (
        <div
          onClick={() => { setZoomImgUrl(null); setZoomStep(null); }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md transition-opacity duration-200"
        >
          <div 
            onClick={e => e.stopPropagation()}
            className="relative max-w-3xl max-h-[85vh] overflow-hidden rounded-xl border border-[#32324a] bg-[#16161f] shadow-2xl flex flex-col"
          >
            <div className="flex items-center justify-between px-4 py-2 bg-[#0f0f18] border-b border-[#252533]">
              <span className="text-xs font-mono text-[#c9a84c] uppercase font-bold">Immagine di Prova — Step {zoomStep}</span>
              <button onClick={() => { setZoomImgUrl(null); setZoomStep(null); }} className="text-[#9090a8] hover:text-white transition">
                <X size={16} />
              </button>
            </div>
            <div className="p-4 flex items-center justify-center bg-[#16161f] overflow-auto">
              <img 
                src={zoomImgUrl} 
                alt={`Campione step ${zoomStep}`} 
                className="max-w-full max-h-[70vh] object-contain rounded-lg shadow-inner" 
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function CreateCharacterScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [characters, setCharacters] = useState([])
  const [record, setRecord] = useState(null)
  const [mode, setMode] = useState(id ? 'detail' : 'list')
  const [name, setName] = useState('')
  const [profile, setProfile] = useState('Low')
  const [captionMode, setCaptionMode] = useState('mista')
  const [files, setFiles] = useState([])
  const [captions, setCaptions] = useState({})
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [captionRecommendation, setCaptionRecommendation] = useState(null)
  const [captionConfirmed, setCaptionConfirmed] = useState(false)
  const [uploadNotice, setUploadNotice] = useState('')
  const fileRef = useRef(null)

  const validLocalCount = files.length
  const canSubmit = Boolean(name.trim()) && validLocalCount >= MIN_IMAGES && !creating
  const needsAutoCaption = captionMode === 'auto' || (captionMode === 'mista' && files.some((_, idx) => !(captions[idx] || '').trim()))
  const disabledReason = !name.trim()
    ? 'Inserisci il nome del personaggio.'
    : validLocalCount < MIN_IMAGES
      ? `Servono almeno ${MIN_IMAGES} immagini accettate. Accettate ora: ${validLocalCount}.`
      : ''

  const loadList = useCallback(async () => {
    const res = await fetch(`${API}/characters/`)
    const data = await res.json().catch(() => [])
    setCharacters(Array.isArray(data) ? data : [])
  }, [])

  const loadDetail = useCallback(async (charId = id) => {
    if (!charId) return
    const res = await fetch(`${API}/characters/${encodeURIComponent(charId)}`)
    if (res.ok) {
      const data = await res.json()
      setRecord(data)
      setMode('detail')
    }
  }, [id])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => {
    if (id) {
      setRecord(null)
      loadDetail(id)
    }
    else setMode('list')
  }, [id, loadDetail])

  useEffect(() => {
    if (!record || record.status !== 'in_creazione') return
    const timer = setInterval(() => loadDetail(record.id), 1200)
    return () => clearInterval(timer)
  }, [record?.id, record?.status, loadDetail])

  function addFiles(nextFiles) {
    const all = Array.from(nextFiles || [])
    const incoming = all.filter(isImageFile)
    const rejected = all.length - incoming.length
    setFiles(prev => {
      const seen = new Set(prev.map(f => `${f.file.name}:${f.file.size}`))
      const accepted = incoming.filter(f => !seen.has(`${f.name}:${f.size}`))
      const duplicates = incoming.length - accepted.length
      setUploadNotice([
        accepted.length ? `${accepted.length} immagini aggiunte.` : '',
        duplicates ? `${duplicates} duplicate ignorate.` : '',
        rejected ? `${rejected} file non immagine ignorati.` : '',
      ].filter(Boolean).join(' '))
      return [...prev, ...accepted.map(f => ({ file: f, preview: filePreview(f) }))]
    })
  }

  useEffect(() => {
    setCaptionConfirmed(false)
    setCaptionRecommendation(null)
  }, [captionMode, files.length])

  async function createCharacter(forceConfirmed = false) {
    if (!canSubmit) {
      setError(`Servono almeno ${MIN_IMAGES} immagini valide prima di avviare la creazione.`)
      return
    }
    if (needsAutoCaption && !captionConfirmed && !forceConfirmed) {
      setCreating(true)
      setError(null)
      try {
        const res = await fetch(`${API}/characters/caption-provider/recommendation`)
        const data = await res.json().catch(() => ({}))
        setCaptionRecommendation(data)
        if (!res.ok || !data.available) {
          setError(data.reason || data.detail || 'Nessun provider vision disponibile per caption automatiche.')
        }
      } catch {
        setError('Impossibile leggere il provider vision consigliato.')
      } finally {
        setCreating(false)
      }
      return
    }
    setCreating(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('name', name.trim())
      fd.append('profile', profile)
      fd.append('caption_mode', captionMode)
      fd.append('captions_json', JSON.stringify(files.map((_, idx) => captions[idx] || '')))
      files.forEach(item => fd.append('files', item.file))
      const res = await fetch(`${API}/characters/`, { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status === 'errore') {
        throw new Error(data.detail || data.error || 'Creazione personaggio fallita')
      }
      setName('')
      setFiles([])
      setCaptions({})
      setCaptionConfirmed(false)
      setCaptionRecommendation(null)
      navigate(`/characters/${data.id}`)
    } catch (e) {
      setError(e.message)
    } finally {
      setCreating(false)
      loadList()
    }
  }

  async function deleteCharacter(charId) {
    if (!confirm('Disattivare questo personaggio e rimuoverlo dai Media?')) return
    await fetch(`${API}/characters/${encodeURIComponent(charId)}`, { method: 'DELETE' })
    setCharacters(prev => prev.filter(c => c.id !== charId))
    if (record?.id === charId) {
      setRecord(null)
      navigate('/characters')
    }
  }

  async function startCharacter(charId) {
    const res = await fetch(`${API}/characters/${encodeURIComponent(charId)}/start`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.detail || 'Impossibile avviare la creazione')
      return
    }
    loadDetail(charId)
  }

  if (mode === 'detail') {
    if (!record) {
      return (
        <div className="h-full flex flex-col bg-[#0a0a0f]">
          <header className="px-6 py-4 border-b border-[#252533] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <UserRound className="text-[#c9a84c] shrink-0" size={20} />
              <h1 className="font-['Playfair_Display'] text-xl text-[#e8e4dd]">Caricamento Personaggio…</h1>
            </div>
            <button onClick={() => navigate('/characters')} className="px-3 py-1.5 rounded border border-[#252533] text-xs text-[#9090a8]">Lista</button>
          </header>
          <div className="flex-1 flex items-center justify-center">
            <ElegantLoader messages={[
              'Caricamento del profilo personaggio...',
              'Analisi delle immagini e validazione del dataset...',
              'Caricamento delle caption associate...',
              'Verifica dello stato di creazione del LoRA...'
            ]} />
          </div>
        </div>
      )
    }
    return (
      <DetailView
        record={record}
        onBack={() => navigate('/characters')}
        onRefresh={() => loadDetail(record.id)}
        onStart={startCharacter}
        onDelete={deleteCharacter}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <UserRound size={22} className="text-[#c9a84c]" />
          <div>
            <h1 className="font-['Playfair_Display'] text-2xl text-[#e8e4dd]">Create Personaggio</h1>
            <p className="text-[11px] font-mono text-[#9090a8]">Dataset foto, caption, profilo e pubblicazione automatica nei Media.</p>
          </div>
        </div>
        <button onClick={() => setMode(mode === 'create' ? 'list' : 'create')} className="px-3 py-1.5 rounded bg-[#c9a84c]/15 text-[#c9a84c] text-xs">
          {mode === 'create' ? 'Lista' : 'Nuovo personaggio'}
        </button>
      </header>

      {mode !== 'create' ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {characters.map(character => (
            <CharacterCard key={character.id} character={character} onOpen={(charId) => navigate(`/characters/${charId}`)} onDelete={deleteCharacter} />
          ))}
          {!characters.length && (
            <div className="col-span-full rounded-lg border border-dashed border-[#32324a] py-16 text-center text-[#555568]">
              Nessun personaggio creato.
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-5">
          <section className="space-y-4">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Nome personaggio"
              className="w-full bg-[#16161f] border border-[#252533] rounded px-3 py-2 text-sm text-[#e8e4dd]"
            />

            <div
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); addFiles(e.dataTransfer.files) }}
              className="rounded-lg border-2 border-dashed border-[#32324a] bg-[#16161f] p-5"
            >
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => addFiles(e.target.files)} />
              <button onClick={() => fileRef.current?.click()} className="flex items-center gap-2 px-3 py-2 rounded bg-[#252533] text-sm text-[#e8e4dd]">
                <Upload size={14} /> Carica foto
              </button>
              <p className="mt-2 text-[10px] font-mono text-[#9090a8]">
                Minimo {MIN_IMAGES} immagini valide. Duplicati e immagini non valide vengono escluse dal backend.
              </p>
              {uploadNotice && (
                <p className="mt-2 text-[10px] font-mono text-[#c9a84c]">{uploadNotice}</p>
              )}
            </div>

            <div className="grid grid-cols-4 gap-2">
              {files.map((item, idx) => (
                <div key={`${item.file.name}-${idx}`} className="rounded-lg border border-[#252533] bg-[#16161f] overflow-hidden">
                  <div className="relative aspect-square">
                    <img src={item.preview} alt={item.file.name} className="w-full h-full object-cover" />
                    <button onClick={() => setFiles(prev => prev.filter((_, i) => i !== idx))} className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white">
                      <X size={10} />
                    </button>
                  </div>
                  <textarea
                    value={captions[idx] || ''}
                    onChange={e => setCaptions(prev => ({ ...prev, [idx]: e.target.value }))}
                    rows={2}
                    placeholder="Caption manuale"
                    className="w-full bg-[#0f0f18] border-t border-[#252533] p-1.5 text-[10px] text-[#e8e4dd] resize-none"
                  />
                </div>
              ))}
              {!files.length && (
                <div className="col-span-full py-14 rounded-lg border border-dashed border-[#32324a] text-center text-[#555568]">
                  <ImagePlus size={28} className="mx-auto mb-2" />
                  Trascina o carica foto del personaggio.
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-4">
            <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
              <h2 className="text-xs font-mono uppercase text-[#9090a8] mb-3">Profilo</h2>
              <div className="space-y-2">
                {PROFILES.map(p => (
                  <button key={p.key} onClick={() => setProfile(p.key)} className={clsx('w-full text-left px-3 py-2 rounded border', profile === p.key ? 'border-[#c9a84c] bg-[#c9a84c]/10 text-[#c9a84c]' : 'border-[#252533] text-[#9090a8]')}>
                    <span className="block text-sm">{p.label}</span>
                    <span className="block text-[10px] font-mono">{p.hint}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
              <h2 className="text-xs font-mono uppercase text-[#9090a8] mb-3">Caption</h2>
              <select value={captionMode} onChange={e => setCaptionMode(e.target.value)} className="w-full bg-[#0f0f18] border border-[#252533] rounded px-2 py-2 text-sm text-[#e8e4dd]">
                {CAPTION_MODES.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
              <p className="mt-2 text-[10px] font-mono text-[#555568]">
                Mista usa caption manuali dove presenti e genera automaticamente quelle mancanti.
              </p>
              {needsAutoCaption && captionRecommendation && (
                <div className="mt-3 rounded border border-[#32324a] bg-[#0f0f18] p-3">
                  <p className="text-[10px] font-mono uppercase text-[#9090a8]">Provider vision consigliato</p>
                  <p className="mt-1 text-xs text-[#e8e4dd]">
                    {captionRecommendation.provider} · {captionRecommendation.model}
                  </p>
                  <p className="mt-1 text-[10px] font-mono text-[#9090a8]">
                    Ruolo: {captionRecommendation.role}
                  </p>
                  <p className="mt-2 text-[10px] font-mono text-[#555568]">
                    {captionRecommendation.reason}
                  </p>
                  {captionRecommendation.warning && (
                    <p className="mt-2 text-[10px] font-mono text-[#f59e0b]">{captionRecommendation.warning}</p>
                  )}
                  {captionRecommendation.available && (
                    <button
                      onClick={() => {
                        setCaptionConfirmed(true)
                        createCharacter(true)
                      }}
                      className="mt-3 w-full rounded bg-[#c9a84c]/15 px-3 py-2 text-xs text-[#c9a84c]"
                    >
                      Conferma e genera caption LLM
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-[#252533] bg-[#16161f] p-4">
              <div className="flex items-center justify-between text-xs font-mono mb-2">
                <span className="text-[#9090a8]">Immagini caricate</span>
                <span className={validLocalCount >= MIN_IMAGES ? 'text-[#22c55e] font-bold' : 'text-[#ef4444] font-bold'}>
                  {validLocalCount} / {MIN_IMAGES}
                </span>
              </div>
              {/* Progress bar */}
              <div className="h-1.5 rounded-full bg-[#0f0f18] overflow-hidden mb-3">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${validLocalCount >= MIN_IMAGES ? 'bg-[#22c55e]' : 'bg-[#c9a84c]'}`}
                  style={{ width: `${Math.min(100, (validLocalCount / MIN_IMAGES) * 100)}%` }}
                />
              </div>
              {validLocalCount > 0 && validLocalCount < MIN_IMAGES && (
                <p className="mb-3 text-[10px] font-mono text-[#f59e0b]">
                  Aggiungi ancora {MIN_IMAGES - validLocalCount} foto per sbloccare la creazione.
                </p>
              )}
              {error && <p className="mb-3 text-xs font-mono text-[#ef4444]">{error}</p>}
              <button
                onClick={() => createCharacter()}
                disabled={!canSubmit}
                className={clsx('w-full flex items-center justify-center gap-2 rounded px-3 py-2 text-sm transition-colors', canSubmit ? 'bg-[#c9a84c] text-black hover:bg-[#e6c46a]' : 'bg-[#252533] text-[#555568] cursor-not-allowed')}
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {creating ? 'Creazione in corso…' : 'Crea personaggio'}
              </button>
              {!canSubmit && disabledReason && (
                <p className="mt-2 flex gap-1.5 text-[10px] font-mono text-[#9090a8]">
                  <AlertCircle size={12} className="shrink-0 mt-0.5" /> {disabledReason}
                </p>
              )}
            </div>

          </aside>
        </div>
      )}
    </div>
  )
}
