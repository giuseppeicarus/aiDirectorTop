/**
 * Percorsi assoluti da File (drag-drop / input) in Electron 32+.
 * `file.path` nel renderer è spesso vuoto — usare webUtils via preload.
 */

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

export function isImagePath(p) {
  return Boolean(p && IMAGE_EXT.test(p))
}

/** @param {File[]} files */
export function pathsFromFiles(files) {
  const resolver = window.studio?.shell?.pathFromFile
  const out = []
  for (const file of files) {
    if (!file) continue
    let p = null
    if (typeof resolver === 'function') {
      try {
        p = resolver(file)
      } catch {
        p = null
      }
    }
    if (!p && file.path) p = file.path
    if (p && isImagePath(p)) out.push(p)
  }
  return out
}

/** Salva File senza path assoluto (fallback base64 → main). */
export async function saveImageFileToStaging(file, catalogProjectId = 'reel_standalone') {
  const save = window.studio?.reel?.saveReferenceBlob
  if (!save || !(file instanceof File)) return null
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const res = await save({
    dataUrl,
    name: file.name || 'image.png',
    catalogProjectId,
  })
  return res?.path || null
}

/** @param {string[] | File[]} pathsOrFiles */
export async function resolveImagePaths(pathsOrFiles, catalogProjectId = 'reel_standalone') {
  if (!pathsOrFiles?.length) return []

  if (typeof pathsOrFiles[0] === 'string') {
    return pathsOrFiles.filter(isImagePath)
  }

  const files = [...pathsOrFiles]
  const resolved = []

  for (const file of files) {
    let p = pathsFromFiles([file])[0]
    if (!p) {
      p = await saveImageFileToStaging(file, catalogProjectId)
    }
    if (p && isImagePath(p)) resolved.push(p)
  }
  return resolved
}
