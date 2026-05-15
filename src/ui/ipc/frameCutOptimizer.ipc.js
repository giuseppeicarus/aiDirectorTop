'use strict'
/**
 * frameCutOptimizer.ipc.js
 * Registers all IPC handlers for the Frame Cut Optimizer module.
 * Call registerFrameCutOptimizerHandlers() once during app startup.
 *
 * Channels:
 *   frameCutOptimizer:analyze         → analyze transitions between clips
 *   frameCutOptimizer:apply           → trim + merge with analysis results
 *   frameCutOptimizer:merge           → direct merge without trim
 *   frameCutOptimizer:cancel          → cancel running job
 *   frameCutOptimizer:getSettings     → load persisted settings
 *   frameCutOptimizer:updateSettings  → save settings
 *   frameCutOptimizer:readFrame       → read a frame PNG as base64 data URL
 *   frameCutOptimizer:checkTools      → verify FFmpeg + FFprobe are available
 *   frameCutOptimizer:cleanupJob      → delete temp frames for a job
 */

const { ipcMain, app } = require('electron')
const path  = require('path')
const fs    = require('fs')
const log   = require('electron-log')

const { FrameCutOptimizerPipeline } = require('../video/FrameCutOptimizerPipeline')
const { VideoMergeService }         = require('../video/VideoMergeService')
const { FrameExtractorService }     = require('../video/FrameExtractorService')
const { DEFAULT_SETTINGS }          = require('../video/CutDecisionService')

// ── Settings persistence ───────────────────────────────────────────────────

function settingsPath() {
  return path.join(app.getPath('userData'), 'fco_settings.json')
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath())) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }
    }
  } catch (e) {
    log.warn('FCO: Settings load failed, using defaults:', e.message)
  }
  return { ...DEFAULT_SETTINGS }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (e) {
    log.error('FCO: Settings save failed:', e.message)
  }
}

// ── Active jobs ────────────────────────────────────────────────────────────

/** Map<jobId, FrameCutOptimizerPipeline> for cancellation */
const activePipelines = new Map()

// ── Registration ───────────────────────────────────────────────────────────

function registerFrameCutOptimizerHandlers() {

  // ── Settings ─────────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:getSettings', () => loadSettings())

  ipcMain.handle('frameCutOptimizer:updateSettings', (_, updates) => {
    const merged = { ...loadSettings(), ...updates }
    saveSettings(merged)
    log.info('FCO: Settings updated')
    return merged
  })

  // ── Tool check ────────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:checkTools', async (_, { ffmpegPath, ffprobePath } = {}) => {
    const ffmpeg  = ffmpegPath  || 'ffmpeg'
    const ffprobe = ffprobePath || 'ffprobe'
    const { spawn } = require('child_process')

    async function checkTool(bin, testArgs) {
      return new Promise(resolve => {
        const proc = spawn(bin, testArgs, { windowsHide: true })
        proc.on('error', () => resolve({ available: false, path: bin }))
        proc.on('close', code => resolve({ available: code === 0 || code === 1, path: bin }))
      })
    }

    const [ffmpegOk, ffprobeOk] = await Promise.all([
      checkTool(ffmpeg,  ['-version']),
      checkTool(ffprobe, ['-version']),
    ])

    return { ffmpeg: ffmpegOk, ffprobe: ffprobeOk }
  })

  // ── Analysis ──────────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:analyze', async (event, { clips, settings: overrides }) => {
    if (!clips || clips.length < 2) {
      throw new Error('Seleziona almeno 2 clip per analizzare le transizioni')
    }

    const settings  = { ...loadSettings(), ...overrides }
    const jobId     = crypto.randomUUID()
    const pipeline  = new FrameCutOptimizerPipeline(
      settings.ffmpegPath  || 'ffmpeg',
      settings.ffprobePath || 'ffprobe',
    )

    activePipelines.set(jobId, pipeline)
    log.info('FCO: Analysis started', { jobId, clips: clips.length })

    try {
      const transitions = await pipeline.analyzeClips(
        jobId,
        clips,
        settings,
        progress => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('frameCutOptimizer:progress', progress)
          }
        },
      )
      log.info('FCO: Analysis complete', { jobId, transitions: transitions.length })
      return { jobId, transitions, settings }
    } catch (e) {
      log.error('FCO: Analysis failed', { jobId, error: e.message })
      throw e
    } finally {
      activePipelines.delete(jobId)
    }
  })

  // ── Apply + merge ─────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:apply', async (event, {
    clips, transitions, outputPath, settings: overrides
  }) => {
    if (!clips || clips.length < 1) throw new Error('Nessuna clip da processare')
    if (!outputPath) throw new Error('Path di output non specificato')

    const settings = { ...loadSettings(), ...overrides }
    const jobId    = crypto.randomUUID()
    const pipeline = new FrameCutOptimizerPipeline(
      settings.ffmpegPath  || 'ffmpeg',
      settings.ffprobePath || 'ffprobe',
    )

    activePipelines.set(jobId, pipeline)
    log.info('FCO: Apply+merge started', { jobId, clips: clips.length, outputPath })

    try {
      const result = await pipeline.applyAndMerge(
        jobId,
        clips,
        transitions,
        outputPath,
        settings,
        progress => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('frameCutOptimizer:progress', progress)
          }
        },
      )
      log.info('FCO: Apply+merge complete', { jobId, output: result })
      return { jobId, outputPath: result }
    } catch (e) {
      log.error('FCO: Apply+merge failed', { jobId, error: e.message })
      throw e
    } finally {
      activePipelines.delete(jobId)
    }
  })

  // ── Direct merge ──────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:merge', async (event, {
    clips, outputPath, settings: overrides
  }) => {
    if (!clips || clips.length < 2) throw new Error('Almeno 2 clip per il merge')
    if (!outputPath) throw new Error('Path di output non specificato')

    const settings = { ...loadSettings(), ...overrides }
    const jobId    = crypto.randomUUID()
    const merger   = new VideoMergeService(
      settings.ffmpegPath  || 'ffmpeg',
      settings.ffprobePath || 'ffprobe',
    )

    log.info('FCO: Direct merge started', { jobId, clips: clips.length })

    const sendProg = (stage, progress, message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('frameCutOptimizer:progress', { job_id: jobId, stage, progress, message })
      }
    }

    sendProg('merging', 0, 'Unione clip in corso...')
    try {
      await merger.mergeClips(clips, outputPath, settings)
      sendProg('completed', 1, `Merge completato: ${path.basename(outputPath)}`)
      return { jobId, outputPath }
    } catch (e) {
      log.error('FCO: Direct merge failed', { error: e.message })
      throw e
    }
  })

  // ── Cancel ────────────────────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:cancel', (_, { jobId }) => {
    const pipeline = activePipelines.get(jobId)
    if (pipeline) {
      pipeline.cancel(jobId)
      activePipelines.delete(jobId)
      log.info('FCO: Job cancelled', { jobId })
      return { cancelled: true, jobId }
    }
    return { cancelled: false, jobId }
  })

  // ── Frame preview (base64 data URL) ───────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:readFrame', (_, framePath) => {
    if (!framePath) return null
    // Prevent path traversal: only allow temp dir and data dir
    const normalized = path.normalize(framePath)
    const allowed = [
      path.join(require('os').tmpdir(), 'fco_jobs'),
      app.getPath('userData'),
    ]
    const isSafe = allowed.some(base => normalized.startsWith(base))
    if (!isSafe) {
      log.warn('FCO: Blocked frame read outside allowed paths', { framePath })
      return null
    }
    try {
      const data = fs.readFileSync(normalized)
      return `data:image/png;base64,${data.toString('base64')}`
    } catch { return null }
  })

  // ── Cleanup temp frames ───────────────────────────────────────────────────

  ipcMain.handle('frameCutOptimizer:cleanupJob', (_, { jobId }) => {
    // Sub-job directories are named jobId_pair0, jobId_pair1, etc.
    const extractor = new FrameExtractorService()
    let cleaned = 0
    // Clean up to 50 pairs (unlikely to exceed this)
    for (let i = 0; i < 50; i++) {
      const dir = extractor.jobDir(`${jobId}_pair${i}`)
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true })
          cleaned++
        }
      } catch { /* ignore */ }
    }
    return { cleaned }
  })

  log.info('FCO: IPC handlers registered')
}

module.exports = { registerFrameCutOptimizerHandlers }
