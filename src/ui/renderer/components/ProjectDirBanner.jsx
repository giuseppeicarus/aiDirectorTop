import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, Copy, Check } from 'lucide-react'
import clsx from 'clsx'

async function copyToClipboard(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Mostra ID cartella progetto (storage) e percorso su disco.
 * Clic sul nome cartella → copia negli appunti.
 */
export default function ProjectDirBanner({
  storageProjectId,
  jobId,
  projectDir,
  className = '',
  storageApi = 'trailer',
}) {
  const [dir, setDir] = useState(projectDir || null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (projectDir) setDir(projectDir)
  }, [projectDir])

  useEffect(() => {
    if (!storageProjectId || dir) return undefined
    let cancelled = false
    const fetchStorage = storageApi === 'reel'
      ? window.studio?.reel?.projectStorage?.(storageProjectId)
      : window.studio?.trailer?.projectStorage?.(storageProjectId)
    fetchStorage
      ?.then((r) => {
        if (!cancelled && r?.project_dir) setDir(r.project_dir)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [storageProjectId, dir, storageApi])

  const handleCopyId = useCallback(async () => {
    if (!storageProjectId) return
    const ok = await copyToClipboard(storageProjectId)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }, [storageProjectId])

  if (!storageProjectId && !dir) return null

  return (
    <div className={clsx(
      'flex flex-col gap-2 px-3 py-2 rounded-lg border border-[#32324a] bg-[#0f0f18] text-[10px] font-mono',
      className,
    )}>
      <div className="flex flex-wrap items-center gap-3">
        {storageProjectId && (
          <button
            type="button"
            onClick={handleCopyId}
            title="Clicca per copiare il nome cartella"
            className="group flex items-center gap-1.5 text-left rounded px-1 -mx-1
                       hover:bg-[#c9a84c]/10 transition-colors cursor-pointer"
          >
            <span className="text-[#9090a8]">Cartella progetto: </span>
            <code className="text-[#c9a84c] group-hover:text-[#e6c46a]">{storageProjectId}</code>
            {copied ? (
              <Check size={11} className="text-[#22c55e] shrink-0" />
            ) : (
              <Copy size={11} className="text-[#555568] group-hover:text-[#c9a84c] shrink-0" />
            )}
            {copied && (
              <span className="text-[#22c55e] text-[9px]">Copiato</span>
            )}
          </button>
        )}
        {jobId && (
          <span className="text-[#e8e4dd]">
            <span className="text-[#9090a8]">Job: </span>
            <code className="text-[#c9a84c]">{jobId}</code>
          </span>
        )}
      </div>
      {dir && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[#9090a8] shrink-0">Percorso:</span>
          <code className="text-[#c9a84c] break-all flex-1 min-w-0">{dir}</code>
          <button
            type="button"
            onClick={() => window.studio?.shell?.openPath?.(dir)}
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-[#32324a] text-[#c9a84c]
                       hover:bg-[#c9a84c]/10 transition-colors"
          >
            <FolderOpen size={11} /> Apri cartella
          </button>
        </div>
      )}
    </div>
  )
}
