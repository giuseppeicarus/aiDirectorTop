/**
 * Sorgenti immagine/audio per Tools: upload su Media Library + URL anteprima HTTP.
 */
import { mediaFileUrl, mediaThumbUrl } from './mediaUrl'

/** Normalizza risposta GET /api/media/ */
export function normalizeMediaList(data) {
  if (Array.isArray(data)) return data
  if (data?.items && Array.isArray(data.items)) return data.items
  if (data?.media && Array.isArray(data.media)) return data.media
  return []
}

export function mediaItemType(item) {
  return item?.type || item?.media_type || ''
}

export function buildToolsSourceFromMediaRecord(item) {
  if (!item) return null
  const id = item.id
  const filepath = item.filepath || item.path
  const filename = item.filename || item.name || 'media'
  const type = mediaItemType(item)
  const preview = id
    ? (type === 'image' ? (mediaThumbUrl(id) || mediaFileUrl(id)) : mediaFileUrl(id))
    : null
  return {
    path: filepath,
    name: filename,
    mediaId: id,
    type,
    preview,
  }
}

/** Carica file da disco nella libreria e restituisce sorgente con anteprima. */
export async function uploadDiskFileToToolsMedia(filePath, name, kind = 'image') {
  const upload = window.studio?.media?.upload ?? window.studio?.tools?.upload
  if (!upload) {
    throw new Error('Upload media non disponibile — riavvia l\'app')
  }
  const result = await upload(filePath, {
    projectId: '__library__',
    tags: `tools,${kind}`,
    description: `Tools — ${name || kind}`,
  })
  const src = buildToolsSourceFromMediaRecord(result)
  if (!src?.path) {
    throw new Error('Upload completato ma percorso file mancante')
  }
  return src
}
