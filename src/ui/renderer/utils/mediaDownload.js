import { mediaFileUrl } from './mediaUrl'

/**
 * Scarica un item della Media Library (dialogo Salva con in Electron, altrimenti link HTTP).
 */
export async function downloadMediaItem(item) {
  if (!item?.id) return { ok: false, error: 'Media non valido' }

  const filename = item.filename || 'download'
  if (item.filepath && window.studio?.media?.saveAs) {
    const res = await window.studio.media.saveAs(item.filepath, filename)
    if (res?.saved) return { ok: true, path: res.path }
    if (res?.canceled) return { ok: false, canceled: true }
  }

  const url = mediaFileUrl(item.id)
  if (!url) return { ok: false, error: 'URL non disponibile' }

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return { ok: true }
}
