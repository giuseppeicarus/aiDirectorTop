/**
 * Converte eventi SSE/IPC in messaggi leggibili per il banner attività globale.
 */

const SOURCE_LABELS = {
  'pipeline:progress': 'Progetto',
  'reel:progress': 'CreateReel',
  'trailer:progress': 'Trailer',
  'director:progress': 'Director Cinema',
  'tools:progress': 'Tools',
  'frameCutOptimizer:progress': 'Frame Cut',
}

const LLM_ROLE_IT = {
  story_analyst: 'Analista storia',
  narrative_director: 'Regista narrativo',
  narrative_arc: 'Regista narrativo',
  cinematographer: 'Direttore della fotografia',
  prompt_engineer: 'Prompt engineer',
  prompt_generation: 'Prompt engineer',
  continuity_checker: 'Continuity',
  vision_analyst: 'Analista vision',
  story_analysis: 'Analisi storia',
  shot_list: 'Shot list',
}

function projectLabel(data) {
  const raw = data.title
    || data.project_title
    || data.catalog_project_id
    || data.storage_project_id
    || data.project_id
    || data.extra?.project_title
    || data.extra?.project_id
    || ''
  if (!raw) return ''
  const value = String(raw).trim()
  if (/^(reel|trailer)_standalone$/i.test(value)) return ''
  const s = value.replace(/^reel_|^trailer_/, '')
  return s.length > 40 ? `${s.slice(0, 37)}…` : s
}

function taskId(channel, data) {
  const base = data.job_id || data.project_id || data.storage_project_id
    || data.catalog_project_id || data.extra?.project_id || 'default'
  return `${channel}:${base}`
}

function activitySource(channel, data) {
  const label = SOURCE_LABELS[channel] || 'Studio'
  if (channel !== 'reel:progress' && channel !== 'trailer:progress') return label
  const title = projectLabel(data)
  return title ? `${channel === 'reel:progress' ? 'Reel' : 'Trailer'} · ${title}` : label
}

/** Percorso + query per aprire il dettaglio/run dalla notifica. */
export function buildActivityNavigation(channel, data) {
  if (!data || data.error) return null

  const jobId = data.job_id
  const catalogId = data.catalog_project_id
    || data.extra?.catalog_project_id
    || (channel === 'reel:progress' ? 'reel_standalone' : null)
    || (channel === 'trailer:progress' ? 'trailer_standalone' : null)

  if (channel === 'reel:progress' && jobId) {
    const cat = catalogId || 'reel_standalone'
    const path = cat === 'reel_standalone'
      ? '/createreel'
      : `/projects/${encodeURIComponent(cat)}/reel`
    return { path, search: `?job=${encodeURIComponent(jobId)}` }
  }

  if (channel === 'trailer:progress' && jobId) {
    const cat = catalogId || 'trailer_standalone'
    const path = cat === 'trailer_standalone'
      ? '/trailer'
      : `/projects/${encodeURIComponent(cat)}/trailer`
    return { path, search: `?job=${encodeURIComponent(jobId)}` }
  }

  if (channel === 'pipeline:progress') {
    const pid = data.project_id || data.extra?.project_id
    if (pid && pid !== '__library__') {
      return { path: `/projects/${encodeURIComponent(pid)}/pipeline` }
    }
  }

  if (channel === 'director:progress') {
    return { path: '/director' }
  }

  if (channel === 'tools:progress') {
    return { path: '/tools' }
  }

  return null
}

function withNav(channel, data, payload) {
  const nav = buildActivityNavigation(channel, data)
  if (!nav) return payload
  return {
    ...payload,
    nav,
    jobId: data.job_id,
    catalogProjectId: data.catalog_project_id,
  }
}

function clipTag(data) {
  const id = data.clip_id || data.shot_id
  if (!id) return ''
  const idx = data.clip_index
  const total = data.clip_total
  if (idx != null && total) return `clip ${idx}/${total}`
  return id
}

function parseReelTrailer(channel, data) {
  const src = SOURCE_LABELS[channel] || 'Generazione'
  const proj = projectLabel(data)
  const subject = channel === 'reel:progress' ? 'reel' : 'trailer'
  const projPart = proj ? ` del ${subject} ${proj}` : ''

  if (data.event === 'agent_progress' && data.msg) {
    const agent = data.agent_label || data.agent_role || 'Agente'
    const clip = clipTag(data)
    return `${agent}${clip ? ` — ${clip}` : ''}${projPart}: ${data.msg}`
  }

  if (data.event === 'clip_comfyui_progress') {
    const clip = clipTag(data)
    if (data.kind === 'frame') {
      const role = /last/i.test(String(data.msg || data.label || '')) ? 'last image' : 'first image'
      return `Generazione ${role}${clip ? ` — ${clip}` : ''}${projPart}`
    }
    if (data.kind === 'video') {
      return `Generazione clip video${clip ? ` — ${clip}` : ''}${projPart}`
    }
    if (data.kind === 'storyboard') {
      return `Generazione storyboard${clip ? ` — ${clip}` : ''}${projPart}`
    }
    return data.msg || `ComfyUI${clip ? ` — ${clip}` : ''}${projPart}`
  }

  if (data.event === 'audio_analysis_done') {
    return `Analisi audio completata${projPart} — ${data.sections ?? 0} sezioni, BPM ${data.bpm ?? '?'}`
  }

  if (data.phase === 'audio_analysis') {
    return `Analisi traccia audio (BPM, sezioni, mood)${projPart}`
  }

  if (data.event === 'progress' && data.msg) {
    return `${data.msg}${projPart}`
  }

  if (data.clip_phase === 'frame_gen' || data.event === 'frame_done' || data.event === 'frames_ready') {
    const clip = clipTag(data)
    const role = data.frame === 'last' || /last/i.test(String(data.msg || '')) ? 'last image' : 'first image'
    return `Generazione ${role}${clip ? ` — ${clip}` : ''}${projPart}`
  }

  if (data.clip_phase === 'video_gen' || data.event === 'clip_done') {
    const clip = clipTag(data)
    return `Generazione clip video${clip ? ` — ${clip}` : ''}${projPart}`
  }

  if (data.event === 'awaiting_storyboard_approval') {
    return `Storyboard pronto — revisione${projPart}`
  }

  if (data.msg) return `${data.msg}${projPart}`
  return `${src} in esecuzione${projPart}`
}

function parsePipeline(data) {
  const proj = projectLabel(data)
  const projPart = proj ? ` del progetto ${proj}` : ''
  const stage = data.stage || ''
  const msg = data.message || ''
  const shot = data.shot_id ? ` shot ${data.shot_id}` : ''

  if (data.event_type === 'llm_prompt' || data.event_type === 'llm_thinking') {
    const role = LLM_ROLE_IT[data.extra?.role] || data.extra?.label || LLM_ROLE_IT[stage] || 'Regia AI'
    const model = data.extra?.model ? ` (${data.extra.model})` : ''
    return `Regia AI — ${role}${model}${projPart}${msg ? `: ${msg}` : ''}`
  }

  if (stage === 'frame_gen') {
    const ftype = /last/i.test(msg) ? 'last image' : 'first image'
    return `Generazione ${ftype}${shot}${projPart}`
  }

  if (stage === 'video_gen') {
    return `Generazione clip video${shot}${projPart}`
  }

  if (stage === 'storyboard' || stage === 'story_analysis' || stage === 'narrative_arc'
    || stage === 'shot_list' || stage === 'prompt_generation' || stage === 'continuity_check') {
    const role = LLM_ROLE_IT[stage] || stage
    return `Regia AI — ${role}${projPart}${msg ? `: ${msg}` : ''}`
  }

  if (msg) return `${msg}${projPart}`
  return `Pipeline — ${stage}${projPart}`
}

function parseTools(data) {
  const proj = projectLabel(data)
  const projPart = proj ? ` — progetto ${proj}` : ''
  if (data.msg) return `${data.msg}${projPart}`
  if (data.kind === 'image') return `Generazione immagine${projPart}`
  if (data.kind === 'video') return `Generazione video${projPart}`
  return `Tools — generazione in corso${projPart}`
}

function parseDirector(data) {
  const proj = projectLabel(data)
  const projPart = proj ? ` del progetto ${proj}` : ''
  if (data.msg) return `${data.msg}${projPart}`
  if (data.event === 'frame') return `Generazione frame${projPart}`
  return `Director Cinema — generazione${projPart}`
}

function parseFrameCut(data) {
  if (data.msg) return data.msg
  if (data.phase) return `Frame Cut — ${data.phase}`
  return 'Frame Cut — elaborazione in corso'
}

/**
 * @returns {{ id: string, clear?: boolean, active?: boolean, message?: string, source?: string, kind?: string, pct?: number }}
 */
export function parseGlobalActivity(channel, data) {
  const id = taskId(channel, data)

  if (!data) return { id, clear: true }
  if (data.error) return { id, clear: true }
  if (data.done || data.stopped || data.terminal === true) return { id, clear: true }
  if (data.event === 'assembly_done' || data.event === 'generation_complete') return { id, clear: true }
  if (data.event === 'awaiting_storyboard_approval') {
    return withNav(channel, data, {
      id,
      active: true,
      kind: 'pause',
      source: activitySource(channel, data),
      message: parseReelTrailer(channel, data),
      pct: data.pct != null ? Math.round(data.pct * 100) : undefined,
    })
  }

  let message = ''
  let kind = 'work'

  if (channel === 'pipeline:progress') {
    if (['done', 'error', 'idle'].includes(data.stage)) return { id, clear: true }
    message = parsePipeline(data)
    kind = data.event_type?.startsWith('llm') || ['story_analysis', 'narrative_arc', 'shot_list', 'prompt_generation', 'continuity_check'].includes(data.stage)
      ? 'llm'
      : (data.stage === 'frame_gen' ? 'image' : data.stage === 'video_gen' ? 'video' : 'work')
    const pct = data.total_progress != null ? Math.round(data.total_progress * 100) : undefined
    return withNav(channel, data, {
      id,
      active: true,
      message,
      source: SOURCE_LABELS[channel],
      kind,
      pct,
    })
  }

  if (channel === 'reel:progress' || channel === 'trailer:progress') {
    message = parseReelTrailer(channel, data)
    kind = data.event === 'agent_progress' || data.agent_role ? 'llm'
      : data.kind === 'video' || data.clip_phase === 'video_gen' ? 'video'
        : data.kind === 'frame' || data.clip_phase === 'frame_gen' ? 'image'
          : 'work'
    const pct = data.pct != null ? Math.round(data.pct * 100) : undefined
    return withNav(channel, data, {
      id,
      active: true,
      message,
      source: activitySource(channel, data),
      kind,
      pct,
    })
  }

  if (channel === 'director:progress') {
    message = parseDirector(data)
    return withNav(channel, data, {
      id, active: true, message, source: SOURCE_LABELS[channel], kind: 'work',
      pct: data.pct != null ? Math.round(data.pct * 100) : undefined,
    })
  }

  if (channel === 'tools:progress') {
    if (data.done) return { id, clear: true }
    message = parseTools(data)
    return withNav(channel, data, {
      id, active: true, message, source: SOURCE_LABELS[channel], kind: data.kind === 'video' ? 'video' : 'image',
    })
  }

  if (channel === 'frameCutOptimizer:progress') {
    if (data.done || data.status === 'done') return { id, clear: true }
    message = parseFrameCut(data)
    return withNav(channel, data, { id, active: true, message, source: SOURCE_LABELS[channel], kind: 'work' })
  }

  if (data.msg || data.message) {
    return withNav(channel, data, {
      id,
      active: true,
      message: data.msg || data.message,
      source: SOURCE_LABELS[channel] || 'Studio',
      kind: 'work',
    })
  }

  return { id, clear: true }
}
