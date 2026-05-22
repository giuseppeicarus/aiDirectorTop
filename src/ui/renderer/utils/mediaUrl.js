/**
 * URL backend per anteprime immagini/video (ComfyUI, trailer, tools, pipeline).
 * Usare sempre 127.0.0.1 — allineato a apiClient e CSP.
 */
import { BACKEND_ORIGIN } from './apiClient'

export { BACKEND_ORIGIN }

/** ID cartella per anteprime/API media (allineato al backend). */
export function resolveTrailerMediaProjectId(storageProjectId, jobId, catalogProjectId) {
  if (storageProjectId) return storageProjectId
  if (jobId) return `trailer_${jobId}`
  return catalogProjectId || 'trailer_standalone'
}

export function resolveReelMediaProjectId(storageProjectId, jobId, catalogProjectId) {
  if (storageProjectId) return storageProjectId
  if (jobId) return `reel_${jobId}`
  return catalogProjectId || 'reel_standalone'
}

export function reelStoryboardClipUrl(projectId, clipId) {
  if (!projectId || !clipId) return null
  return `${BACKEND_ORIGIN}/api/reel/storyboard-clip/${encodeURIComponent(projectId)}/${encodeURIComponent(clipId)}`
}

export function reelFrameClipUrl(projectId, clipId) {
  if (!projectId || !clipId) return null
  return `${BACKEND_ORIGIN}/api/reel/frames-clip/${encodeURIComponent(projectId)}/${encodeURIComponent(clipId)}`
}

/** Anteprima frame HD reel (dopo storyboard). */
export function clipReelFramePreviewUrl(clip, projectId) {
  if (!clip) return null
  const hdPhase = clip.clip_phase === 'frame_gen' || clip.clip_phase === 'video_gen'
  const hdReady = clip.hd_frame_ready || clip.status === 'done'
  if (!hdReady && !hdPhase) return null
  if (clip.first_frame_path) {
    const byPath = resolveBackendUrl(null, clip.first_frame_path)
    if (byPath) return byPath
  }
  if (clip.frame_url) {
    const resolved = resolveBackendUrl(clip.frame_url)
    if (resolved) return resolved
  }
  if (projectId && clip.clip_id && hdReady) {
    return reelFrameClipUrl(projectId, clip.clip_id)
  }
  return null
}

export function clipReelStoryboardPreviewUrl(clip, projectId) {
  if (!clip) return null
  if (clip.storyboard_placeholder === true || clip.storyboard_ok === false) return null
  if (clip.storyboard_path) {
    const byPath = resolveBackendUrl(null, clip.storyboard_path)
    if (byPath) return byPath
  }
  if (clip.preview_url) {
    const fromPreview = resolveBackendUrl(clip.preview_url)
    if (fromPreview) return fromPreview
  }
  // Non chiamare l'API finché non c'è un file atteso (evita 404 a raffica)
  const ready = clip.storyboard_ok === true
    || clip.status === 'storyboard'
    || clip.status === 'done'
    || Boolean(clip.storyboard_filename)
  if (!ready && clip.status === 'waiting') return null
  if (projectId && clip.clip_id) {
    const byClip = reelStoryboardClipUrl(projectId, clip.clip_id)
    if (byClip) return byClip
    const name = clip.storyboard_filename || `${clip.clip_id}_sb.png`
    return `${BACKEND_ORIGIN}/api/reel/storyboard/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`
  }
  return resolveBackendUrl(clip.storyboard_url)
}

/** Path assoluto o relativo → URL caricabile in <img> / <video>. */
export function resolveBackendUrl(relativeOrAbsolute, localPath) {
  if (relativeOrAbsolute) {
    if (
      relativeOrAbsolute.startsWith('http://')
      || relativeOrAbsolute.startsWith('https://')
    ) {
      return relativeOrAbsolute
    }
    let rel = relativeOrAbsolute.startsWith('/')
      ? relativeOrAbsolute
      : `/${relativeOrAbsolute}`
    // SSE reel può ancora inviare path /api/trailer/ — normalizza a /api/reel/
    if (rel.startsWith('/api/trailer/')) {
      rel = rel.replace('/api/trailer/', '/api/reel/')
    }
    return `${BACKEND_ORIGIN}${rel}`
  }
  if (localPath) {
    return `${BACKEND_ORIGIN}/api/reel/source?path=${encodeURIComponent(localPath)}`
  }
  return null
}

export function trailerFrameUrl(projectId, filename) {
  return `${BACKEND_ORIGIN}/api/trailer/frames/${encodeURIComponent(projectId)}/${encodeURIComponent(filename)}`
}

export function trailerClipUrl(projectId, filename) {
  return `${BACKEND_ORIGIN}/api/trailer/clips/${encodeURIComponent(projectId)}/${encodeURIComponent(filename)}`
}

export function trailerStoryboardUrl(projectId, filename) {
  if (!projectId || !filename) return null
  return `${BACKEND_ORIGIN}/api/trailer/storyboard/${encodeURIComponent(projectId)}/${encodeURIComponent(filename)}`
}

/** URL stabile per clip — il backend risolve il file su disco per clip_id. */
export function trailerStoryboardClipUrl(projectId, clipId) {
  if (!projectId || !clipId) return null
  return `${BACKEND_ORIGIN}/api/trailer/storyboard-clip/${encodeURIComponent(projectId)}/${encodeURIComponent(clipId)}`
}

/** URL anteprima storyboard: filename canonico → clip API → path disco. */
export function clipStoryboardPreviewUrl(clip, projectId) {
  if (!clip) return null

  if (projectId && clip.clip_id) {
    const byClip = trailerStoryboardClipUrl(projectId, clip.clip_id)
    if (byClip) return byClip
    const canonicalName = clip.storyboard_filename || `${clip.clip_id}_sb.png`
    const byName = trailerStoryboardUrl(projectId, canonicalName)
    if (byName) return byName
  }

  if (clip.storyboard_clip_url) {
    const fromClipRoute = resolveBackendUrl(clip.storyboard_clip_url)
    if (fromClipRoute) return fromClipRoute
  }

  if (clip.storyboard_path) {
    const byPath = resolveBackendUrl(null, clip.storyboard_path)
    if (byPath) return byPath
  }

  if (clip.preview_url) {
    const fromPreview = resolveBackendUrl(clip.preview_url)
    if (fromPreview) return fromPreview
  }

  const fromApi = resolveBackendUrl(clip.storyboard_url)
  if (fromApi) return fromApi

  const name = clip.storyboard_filename
    || (clip.storyboard_path && String(clip.storyboard_path).replace(/\\/g, '/').split('/').pop())
  if (name && projectId) return trailerStoryboardUrl(projectId, name)

  if (clip.frame_url) return clip.frame_url
  return null
}

export function trailerFrameClipUrl(projectId, clipId) {
  if (!projectId || !clipId) return null
  return `${BACKEND_ORIGIN}/api/trailer/frames-clip/${encodeURIComponent(projectId)}/${encodeURIComponent(clipId)}`
}

/** Anteprima frame HD (fase ComfyUI) — solo se c'è un path/URL noto (evita 404 su frames-clip vuoto). */
export function clipFramePreviewUrl(clip, projectId) {
  if (!clip) return null
  if (clip.first_frame_path) {
    const byPath = resolveBackendUrl(null, clip.first_frame_path)
    if (byPath) return byPath
  }
  if (clip.frame_url) {
    const resolved = resolveBackendUrl(clip.frame_url)
    if (resolved) return resolved
  }
  if (projectId && clip.clip_id && (clip.status === 'done' || clip.hd_frame_ready)) {
    return trailerFrameClipUrl(projectId, clip.clip_id)
      || trailerFrameUrl(projectId, `${clip.clip_id}_first.png`)
  }
  return null
}

export function toolsOutputUrl(filename) {
  return `${BACKEND_ORIGIN}/api/tools/output/${encodeURIComponent(filename)}`
}

export function mediaFileUrl(mediaId) {
  if (!mediaId) return null
  return `${BACKEND_ORIGIN}/api/media/file/${mediaId}`
}

export function mediaThumbUrl(mediaId) {
  if (!mediaId) return null
  return `${BACKEND_ORIGIN}/api/media/thumb/${mediaId}`
}

export function pipelineFrameUrl(projectId, filename) {
  return `${BACKEND_ORIGIN}/api/pipeline/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(filename)}`
}

export function pipelineClipUrl(projectId, filename) {
  return `${BACKEND_ORIGIN}/api/pipeline/${encodeURIComponent(projectId)}/clips/${encodeURIComponent(filename)}`
}

/** Path assoluto su disco → URL HTTP servito dal backend (solo basename). */
export function artifactServeUrl(projectId, artifactPath, kind = 'frame') {
  if (!artifactPath || !projectId) return null
  const name = String(artifactPath).replace(/\\/g, '/').split('/').pop()
  if (!name) return null
  return kind === 'clip' ? pipelineClipUrl(projectId, name) : pipelineFrameUrl(projectId, name)
}
