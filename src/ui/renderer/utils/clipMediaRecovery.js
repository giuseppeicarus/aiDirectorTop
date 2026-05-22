import {
  resolveBackendUrl,
  reelFrameClipUrl,
  trailerFrameClipUrl,
  clipReelStoryboardPreviewUrl,
  clipStoryboardPreviewUrl,
} from './mediaUrl'

/** Clip reel/trailer senza media locale ma possibile recovery ComfyUI/disco. */
export function clipNeedsMediaRecovery(c) {
  if (!c?.clip_id) return false
  if (c.clip_url) return false
  if (c.frame_url || c.hd_frame_ready) return true
  if (['generating', 'waiting'].includes(c.status)) return true
  if (c.status === 'storyboard' && !c.frame_url) return true
  return false
}

/**
 * Applica evento reconcile a una clip (storyboard_frame, frame_done, clip_done).
 * @param {'reel'|'trailer'} apiKind
 */
export function mergeClipRecoveryEvent(prevClip, ev, mediaProjectId, apiKind = 'reel') {
  if (!ev?.clip_id) return prevClip

  const frameClipUrl = apiKind === 'trailer' ? trailerFrameClipUrl : reelFrameClipUrl
  const storyboardPreview = apiKind === 'trailer'
    ? clipStoryboardPreviewUrl
    : clipReelStoryboardPreviewUrl

  if (ev.event === 'storyboard_frame') {
    const sbOk = ev.storyboard_ok !== false && !ev.storyboard_placeholder
    const framePayload = sbOk ? {
      storyboard_url: ev.url,
      storyboard_path: ev.path,
      storyboard_filename: ev.storyboard_filename,
      preview_url: ev.preview_url,
      storyboard_clip_url: ev.storyboard_clip_url,
    } : {}
    const sbUrl = sbOk
      ? storyboardPreview({ clip_id: ev.clip_id, ...framePayload }, mediaProjectId)
      : null
    return {
      ...prevClip,
      clip_id: ev.clip_id,
      status: sbOk ? 'storyboard' : 'storyboard_failed',
      storyboard_ok: sbOk,
      storyboard_placeholder: !sbOk,
      ...framePayload,
      storyboard_filename: sbOk ? (ev.storyboard_filename || `${ev.clip_id}_sb.png`) : undefined,
      frame_url: sbUrl,
      comfyuiPct: 0,
    }
  }

  if (ev.event === 'frame_done') {
    const frameUrl = resolveBackendUrl(ev.frame_url)
      || frameClipUrl(mediaProjectId, ev.clip_id)
    if (frameUrl) {
      return {
        ...prevClip,
        frame_url: frameUrl,
        first_frame_path: ev.path || prevClip.first_frame_path,
        hd_frame_ready: Boolean(ev.hd_frame_ready),
        clip_phase: ev.hd_frame_ready ? 'frame_gen' : prevClip.clip_phase,
        status: 'generating',
        comfyuiPct: 0,
      }
    }
  }

  if (ev.event === 'clip_done') {
    const clipUrl = resolveBackendUrl(ev.url) || ev.url
    return {
      ...prevClip,
      clip_id: ev.clip_id,
      status: 'done',
      clip_url: clipUrl,
      clip_path: ev.path || prevClip.clip_path,
      clip_phase: 'video_gen',
      comfyuiPct: 100,
      comfyuiMsg: ev.cached ? 'Recuperata (disco/ComfyUI)' : 'Completata',
    }
  }

  return prevClip
}
