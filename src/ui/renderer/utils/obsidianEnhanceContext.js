/**
 * Contesto project_context per Migliora prompt + memoria Obsidian (project_id).
 */

export function directorVaultProjectId(localProjectId) {
  if (!localProjectId) return ''
  return `director_cinema_${localProjectId}`
}

export function buildReelEnhanceContext(description, config, directorNarrative, projectId = '', clipId = '') {
  const dn = directorNarrative || {}
  return {
    project_id: projectId || '',
    clip_id: clipId || undefined,
    brief: (description || '').trim(),
    style: config?.style,
    director_narrative: dn.narrative_arc || dn.logline || '',
    visual_theme: dn.visual_theme || '',
    logline: dn.logline || '',
    mood: dn.mood || '',
  }
}

export function buildTrailerEnhanceContext({
  config,
  mediaProjectId,
  clipId = '',
  directorNarrative = null,
  dopPlans = null,
  brief = '',
}) {
  const dn = directorNarrative || {}
  const style = config?.style || ''
  return {
    project_id: mediaProjectId || '',
    clip_id: clipId || undefined,
    brief: brief || style,
    style,
    director_narrative: dn.narrative_arc || dn.logline || '',
    visual_theme: dn.visual_theme || '',
    logline: dn.logline || '',
    mood: dn.mood || '',
    dop_plans_count: Array.isArray(dopPlans) ? dopPlans.length : 0,
  }
}

export function buildDirectorCinemaEnhanceContext(project, clip = null) {
  if (!project?.id) {
    return {
      brief: project?.globalPrompt || '',
      style: project?.name || '',
    }
  }
  const projectId = directorVaultProjectId(project.id)
  return {
    project_id: projectId,
    clip_id: clip?.id,
    brief: project.globalPrompt || '',
    style: project.name || '',
    description: project.name,
    shot_type: clip?.prompt ? 'director_clip' : undefined,
    emotion: project.mode,
    aspect_ratio: project.aspectRatio,
    resolution: `${project.width}x${project.height}`,
  }
}

/** Scrive brief + clip nel vault prima di enhance (Director Cinema). */
export async function syncDirectorProjectToVault(project, backendOrigin) {
  const projectId = directorVaultProjectId(project?.id)
  if (!projectId || !backendOrigin) return
  try {
    await fetch(`${backendOrigin}/api/obsidian/sync/director`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, project }),
    })
  } catch {
    /* vault opzionale */
  }
}
