/**
 * TimelinePreview — canvas player che simula la timeline con transizioni WebGL.
 * Mostra le clip in sequenza (usando le immagini first frame / storyboard),
 * con le transizioni animate fra una clip e l'altra.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { Play, Pause, RotateCcw, Maximize2 } from 'lucide-react'
import clsx from 'clsx'
import { TransitionEngine, TRANSITIONS } from './TransitionEngine'
import { BACKEND_ORIGIN } from '../utils/mediaUrl'

function fmtTime(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function clipPreviewUrl(clip, projectId) {
  if (clip.image?.previewUrl) return clip.image.previewUrl
  if (clip.image?.mediaId) return `${BACKEND_ORIGIN}/api/media/thumb/${clip.image.mediaId}`
  return null
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return }
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

function drawPlaceholder(ctx, w, h, label, color = '#16161f') {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#252533'
  ctx.fillRect(0, 0, w, h)
  // gradient
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#1e1e2a')
  g.addColorStop(1, '#0f0f18')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // label
  ctx.fillStyle = '#555568'
  ctx.font = `bold ${Math.max(10, w / 12)}px "JetBrains Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label || '', w / 2, h / 2)
}

function drawImageFit(ctx, img, w, h) {
  if (!img) return
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
  const sw = img.naturalWidth * scale
  const sh = img.naturalHeight * scale
  const ox = (w - sw) / 2
  const oy = (h - sh) / 2
  ctx.drawImage(img, ox, oy, sw, sh)
}

export default function TimelinePreview({ clips, project }) {
  const canvasRef   = useRef(null)
  const engineRef   = useRef(null)
  const rafRef      = useRef(null)
  const stateRef    = useRef({ playing: false, time: 0, images: [] })
  const imagesRef   = useRef([]) // loaded Image objects per clip

  const [playing,    setPlaying]    = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [loading,    setLoading]    = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const ar = project?.aspectRatio || '16:9'
  const [arW, arH] = ar === '9:16' ? [9, 16] : ar === '1:1' ? [1, 1] : ar === '4:3' ? [4, 3] : ar === '21:9' ? [21, 9] : [16, 9]

  const totalDuration = (clips || []).reduce((s, c) => s + (c.duration || 3), 0)

  // Build timeline segments: each segment = { clipIdx, startTime, endTime, transId, transDuration }
  const segments = (() => {
    const segs = []
    let t = 0
    ;(clips || []).forEach((clip, i) => {
      const dur = clip.duration || 3
      const transId = clip.transition || 'cut'
      const transDur = TRANSITIONS[transId]?.duration || 0
      segs.push({ clipIdx: i, startTime: t, endTime: t + dur, transId, transDur })
      t += dur
    })
    return segs
  })()

  // Load images for all clips
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const projectId = project?.id || ''
    Promise.all((clips || []).map((clip, i) => {
      const src = clipPreviewUrl(clip, projectId)
      return src ? loadImage(src) : Promise.resolve(null)
    })).then(imgs => {
      if (!cancelled) {
        imagesRef.current = imgs
        setLoading(false)
        renderFrame(stateRef.current.time)
      }
    })
    return () => { cancelled = true }
  }, [clips?.map(c => c.id + (c.image?.previewUrl || '')).join(',')])

  const renderFrame = useCallback((time) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const w = canvas.width
    const h = canvas.height

    if (!clips?.length) {
      drawPlaceholder(ctx, w, h, 'Nessuna clip')
      return
    }

    // Find which segment we're in
    const t = Math.max(0, Math.min(time, totalDuration))
    const seg = segments.find(s => t >= s.startTime && t < s.endTime)
      || segments[segments.length - 1]
    if (!seg) return

    const localT = t - seg.startTime
    const clipDur = seg.endTime - seg.startTime
    const img = imagesRef.current[seg.clipIdx] || null

    // Check if we're in a transition zone (last transDur seconds of this clip)
    const transStartLocal = clipDur - seg.transDur
    const inTrans = seg.transDur > 0 && localT >= transStartLocal && seg.clipIdx < (clips.length - 1)

    if (inTrans) {
      // Transition: render via WebGL engine
      const nextIdx = seg.clipIdx + 1
      const nextImg = imagesRef.current[nextIdx] || null
      const transProgress = (localT - transStartLocal) / seg.transDur

      // WebGL engine on canvas
      if (!engineRef.current) engineRef.current = new TransitionEngine(canvas)
      const eng = engineRef.current

      // Create offscreen canvases for from/to frames if no real images
      const makeOffscreen = (idx) => {
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const cx = c.getContext('2d')
        const i = imagesRef.current[idx]
        if (i) drawImageFit(cx, i, w, h)
        else drawPlaceholder(cx, w, h, `Clip ${idx + 1}`)
        return c
      }

      const fromCanvas = makeOffscreen(seg.clipIdx)
      const toCanvas   = makeOffscreen(nextIdx)

      // Render single frame of the transition at given progress
      const prog = Math.max(0, Math.min(transProgress, 1))
      eng._renderFrame(seg.transId, fromCanvas, toCanvas, prog)
    } else {
      // Static frame: draw current clip image
      ctx.clearRect(0, 0, w, h)
      if (img) {
        drawImageFit(ctx, img, w, h)
      } else {
        drawPlaceholder(ctx, w, h, `Clip ${seg.clipIdx + 1}`)
      }

      // Overlay: clip info
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(0, h - 20, w, 20)
      ctx.fillStyle = '#c9a84c'
      ctx.font = `${Math.max(9, w / 28)}px "JetBrains Mono", monospace`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(`${seg.clipIdx + 1}/${clips.length}`, 6, h - 10)
      ctx.textAlign = 'right'
      ctx.fillStyle = '#9090a8'
      ctx.fillText(fmtTime(t), w - 6, h - 10)
    }
  }, [clips, segments, totalDuration])

  // Tick loop
  const tick = useCallback(() => {
    if (!stateRef.current.playing) return
    stateRef.current.time += 1 / 30  // ~30fps simulation
    if (stateRef.current.time >= totalDuration) {
      stateRef.current.time = totalDuration
      stateRef.current.playing = false
      setPlaying(false)
      setCurrentTime(totalDuration)
      renderFrame(totalDuration)
      return
    }
    setCurrentTime(stateRef.current.time)
    renderFrame(stateRef.current.time)
    rafRef.current = requestAnimationFrame(tick)
  }, [totalDuration, renderFrame])

  const play = useCallback(() => {
    if (stateRef.current.time >= totalDuration) stateRef.current.time = 0
    stateRef.current.playing = true
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }, [tick, totalDuration])

  const pause = useCallback(() => {
    stateRef.current.playing = false
    setPlaying(false)
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
  }, [])

  const reset = useCallback(() => {
    pause()
    stateRef.current.time = 0
    setCurrentTime(0)
    renderFrame(0)
  }, [pause, renderFrame])

  const seek = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const t = ratio * totalDuration
    stateRef.current.time = t
    setCurrentTime(t)
    renderFrame(t)
  }, [totalDuration, renderFrame])

  // Initial render
  useEffect(() => { renderFrame(0) }, [renderFrame])

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      engineRef.current?.destroy()
    }
  }, [])

  const progress = totalDuration > 0 ? currentTime / totalDuration : 0

  return (
    <div className={clsx(
      'rounded-xl border border-[#252533] bg-[#0f0f18] overflow-hidden flex flex-col',
      fullscreen && 'fixed inset-4 z-50 shadow-2xl',
    )}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#252533] shrink-0">
        <span className="text-[9px] font-mono text-[#9090a8] uppercase tracking-wider">
          Anteprima timeline
        </span>
        <div className="flex items-center gap-2">
          {loading && <span className="text-[8px] font-mono text-[#555568]">Caricamento…</span>}
          <span className="text-[9px] font-mono text-[#555568]">{clips?.length || 0} clip · {fmtTime(totalDuration)}</span>
          <button
            type="button"
            onClick={() => setFullscreen(v => !v)}
            className="text-[#555568] hover:text-[#9090a8] transition-colors"
            title={fullscreen ? 'Riduci' : 'Fullscreen'}
          >
            <Maximize2 size={11} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
        <canvas
          ref={canvasRef}
          width={fullscreen ? 640 : 320}
          height={fullscreen
            ? Math.round(640 * arH / arW)
            : Math.round(320 * arH / arW)}
          className="block"
          style={{
            maxWidth: '100%',
            maxHeight: fullscreen ? 'calc(100vh - 120px)' : 220,
            objectFit: 'contain',
          }}
        />
        {!playing && (
          <button
            type="button"
            onClick={play}
            className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/20 transition-colors group"
          >
            <div className="w-12 h-12 rounded-full bg-[#c9a84c]/90 flex items-center justify-center group-hover:bg-[#c9a84c] transition-colors">
              <Play size={20} className="text-black ml-1" />
            </div>
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="px-3 py-2 shrink-0 space-y-1.5">
        {/* Progress bar */}
        <div
          className="h-1.5 bg-[#252533] rounded-full cursor-pointer overflow-hidden"
          onClick={seek}
          role="presentation"
        >
          <div
            className="h-full bg-[#c9a84c] rounded-full transition-none"
            style={{ width: `${progress * 100}%` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={playing ? pause : play}
              disabled={!clips?.length}
              className="flex items-center justify-center w-6 h-6 rounded-full bg-[#c9a84c]/20 border border-[#c9a84c]/40 text-[#c9a84c] hover:bg-[#c9a84c]/30 disabled:opacity-40 transition-colors"
            >
              {playing ? <Pause size={9} /> : <Play size={9} className="ml-0.5" />}
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-[#555568] hover:text-[#9090a8] transition-colors"
            >
              <RotateCcw size={10} />
            </button>
          </div>
          <span className="text-[9px] font-mono text-[#555568] tabular-nums">
            {fmtTime(currentTime)} / {fmtTime(totalDuration)}
          </span>
        </div>
      </div>
    </div>
  )
}
