'use strict'
/**
 * FrameCutOptimizerPipeline
 * Orchestrator: extracts frames, analyzes similarity/motion, decides cuts,
 * applies trims, and merges clips into a final output.
 *
 * All methods emit progress events via the onProgress callback:
 *   { job_id, stage, progress, message }
 *
 * Stages: extracting_frames | analyzing_similarity | analyzing_motion |
 *         deciding_cuts | trimming | merging | completed | failed
 */

const path = require('path')
const fs   = require('fs')

const { FrameExtractorService }       = require('./FrameExtractorService')
const { FrameSimilarityService }      = require('./FrameSimilarityService')
const { MotionAnalysisService }       = require('./MotionAnalysisService')
const { CutDecisionService }          = require('./CutDecisionService')
const { FfmpegTrimService }           = require('./FfmpegTrimService')
const { VideoMergeService }           = require('./VideoMergeService')
const { LlmCinematicSupervisorService } = require('./LlmCinematicSupervisorService')

class FrameCutOptimizerPipeline {
  constructor(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe') {
    this.extractor  = new FrameExtractorService(ffmpegPath, ffprobePath)
    this.similarity = new FrameSimilarityService(ffmpegPath)
    this.motion     = new MotionAnalysisService(ffmpegPath)
    this.decision   = new CutDecisionService()
    this.trimmer    = new FfmpegTrimService(ffmpegPath, ffprobePath)
    this.merger     = new VideoMergeService(ffmpegPath, ffprobePath)
    this.supervisor = new LlmCinematicSupervisorService(false)
    this._cancelled = new Set()
  }

  /** Cancel a running job by ID. */
  cancel(jobId) {
    this._cancelled.add(jobId)
  }

  _checkCancelled(jobId) {
    if (this._cancelled.has(jobId)) {
      this._cancelled.delete(jobId)
      throw new Error('Job cancelled by user')
    }
  }

  // ── Phase 1: Analysis ──────────────────────────────────────────────────────

  /**
   * Analyze all consecutive transitions in a clip list.
   * Returns an array of transition objects (one per consecutive pair).
   */
  async analyzeClips(jobId, clips, settings, onProgress) {
    if (clips.length < 2) throw new Error('Need at least 2 clips to analyze transitions')

    const n           = settings.framesToAnalyze || 12
    const threshold   = settings.duplicateSimilarityThreshold || 0.965
    const motionThr   = settings.staticMotionThreshold || 0.015
    const transitions = []
    const total       = clips.length - 1

    for (let i = 0; i < total; i++) {
      this._checkCancelled(jobId)

      const pairNum = `${i + 1}/${total}`
      const subJobId = `${jobId}_pair${i}`

      emit(onProgress, jobId, 'extracting_frames', i / total,
        `Estrazione frame: transizione ${pairNum}`)

      const { framesA, framesB, infoA, infoB } =
        await this.extractor.extractJobFrames(subJobId, clips[i], clips[i + 1], n)

      this._checkCancelled(jobId)
      emit(onProgress, jobId, 'analyzing_similarity', i / total,
        `Analisi similarità: transizione ${pairNum}`)

      const simResult = await this.similarity.analyzePairs(framesA, framesB, threshold)

      this._checkCancelled(jobId)
      emit(onProgress, jobId, 'analyzing_motion', i / total,
        `Analisi movimento: transizione ${pairNum}`)

      // Reuse pre-loaded thumbnails from similarity analysis
      const [motionA, motionB] = await Promise.all([
        this.motion.analyzeMotion(framesA, motionThr, simResult._thumbsA),
        this.motion.analyzeMotion(framesB, motionThr, simResult._thumbsB),
      ])

      this._checkCancelled(jobId)
      emit(onProgress, jobId, 'deciding_cuts', i / total,
        `Decisione taglio: transizione ${pairNum}`)

      let cut = this.decision.decide(simResult, motionB, motionA, infoA, infoB, settings)

      // Optional LLM override
      const firstActiveIdx = cut.clip_b_trim_start_frames
      const override = await this.supervisor.supervise({
        framePathLastA:        framesA[framesA.length - 1],
        framePathFirstActiveB: framesB[firstActiveIdx] ?? framesB[0],
        similarityResult:      simResult,
        motionResult:          { a: motionA, b: motionB },
        cutDecision:           cut,
      })
      if (override) {
        if (override.override_trim_b != null) cut.clip_b_trim_start_frames = override.override_trim_b
        if (override.override_trim_a != null) cut.clip_a_trim_end_frames   = override.override_trim_a
        if (override.cinematic_reason)        cut.reason += ` [LLM: ${override.cinematic_reason}]`
      }

      // Sanitize _thumbsA/_thumbsB (Buffer array) before returning to IPC — not serializable
      delete simResult._thumbsA
      delete simResult._thumbsB

      // Max similarity across all pairs for the UI table
      const maxSim = simResult.pairs.reduce((m, p) => Math.max(m, p.similarity), 0)
      const staticBCount = motionB.filter(m => m.is_static).length

      transitions.push({
        index:        i,
        clip_a:       path.basename(clips[i]),
        clip_b:       path.basename(clips[i + 1]),
        clip_a_path:  clips[i],
        clip_b_path:  clips[i + 1],
        info_a:       infoA,
        info_b:       infoB,
        max_similarity:    Math.round(maxSim * 1000) / 1000,
        static_b_frames:   staticBCount,
        similarity:   simResult,
        motion_a:     motionA,
        motion_b:     motionB,
        cut_decision: cut,
        previews: {
          last_frame_a:     framesA[framesA.length - 1],
          first_frame_b:    framesB[0],
          first_active_b:   framesB[firstActiveIdx] ?? framesB[0],
          job_dir:          this.extractor.jobDir(subJobId),
        },
      })
    }

    emit(onProgress, jobId, 'analyzing_similarity', 1.0,
      `Analisi completata: ${transitions.length} transizioni`)

    return transitions
  }

  // ── Phase 2: Apply trims + merge ───────────────────────────────────────────

  /**
   * Apply cut decisions to each clip then concatenate into a single output file.
   * Cleans up intermediate trimmed clips on completion.
   */
  async applyAndMerge(jobId, clips, transitions, outputPath, settings, onProgress) {
    const total = clips.length
    const trimmedPaths = []
    const trimOpts = {
      codec:    settings.outputCodec || 'libx264',
      crf:      settings.crf ?? 18,
      preset:   settings.preset || 'medium',
      audioCdc: settings.audioCodec || 'aac',
    }

    // ── Trim each clip ─────────────────────────────────────────────────────
    for (let i = 0; i < clips.length; i++) {
      this._checkCancelled(jobId)
      emit(onProgress, jobId, 'trimming', i / total, `Trim clip ${i + 1}/${total}`)

      // Clip i: may trim end (A side) AND start (B side) depending on surrounding transitions
      const tBefore = transitions.find(t => t.index === i - 1) // trim end of clip i (it's the A clip)
      const tAfter  = transitions.find(t => t.index === i)     // trim start of clip i (it's the B clip)

      const trimStart = tAfter  ? tAfter.cut_decision.clip_b_trim_start_frames : 0
      const trimEnd   = tBefore ? tBefore.cut_decision.clip_a_trim_end_frames  : 0

      // Use fps from whichever transition has this clip's info
      const fps = (tAfter?.info_b ?? tBefore?.info_a)?.fps ?? 24

      const ext     = path.extname(clips[i]) || '.mp4'
      const tmpPath = outputPath.replace(/\.[^.]+$/, `_trim${i}${ext}`)

      await this.trimmer.trimClip(clips[i], tmpPath, trimStart, trimEnd, fps, trimOpts)
      trimmedPaths.push(tmpPath)
    }

    // ── Merge ──────────────────────────────────────────────────────────────
    this._checkCancelled(jobId)
    emit(onProgress, jobId, 'merging', 0.9, 'Unione clip finali...')

    await this.merger.mergeClips(trimmedPaths, outputPath, settings)

    // Cleanup trimmed intermediates
    for (const p of trimmedPaths) {
      try { fs.unlinkSync(p) } catch { /* already gone */ }
    }

    emit(onProgress, jobId, 'completed', 1.0,
      `Video finale pronto: ${path.basename(outputPath)}`)

    return outputPath
  }
}

function emit(onProgress, jobId, stage, progress, message) {
  try {
    onProgress({ job_id: jobId, stage, progress: Math.round(progress * 100) / 100, message })
  } catch { /* renderer may have closed */ }
}

module.exports = { FrameCutOptimizerPipeline }
