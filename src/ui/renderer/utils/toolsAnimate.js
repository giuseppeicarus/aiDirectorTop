/**
 * Passa un'immagine dalla Media Library (o galleria Tools) al tool img2video.
 */
import { buildToolsSourceFromMediaRecord } from './toolsMediaSource'

const STORAGE_KEY = 'cinematic:tools:img2video-source'

export function imageSourceFromMediaItem(item) {
  if (!item?.filepath && !item?.path) return null
  return buildToolsSourceFromMediaRecord(item)
}

export function setPendingImg2Video(source) {
  if (!source?.path) return
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(source))
  } catch {
    /* quota / private mode */
  }
}

export function consumePendingImg2Video() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)
    return JSON.parse(raw)
  } catch {
    return null
  }
}
