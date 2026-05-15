'use strict'
/**
 * CutDecisionService
 * Pure decision logic — no I/O, no FFmpeg.
 * Given similarity + motion analysis, decides trim amounts and recommended transition.
 */

const DEFAULT_SETTINGS = {
  framesToAnalyze:              12,
  duplicateSimilarityThreshold: 0.965,
  staticMotionThreshold:        0.015,
  maxTrimFrames:                6,
  minClipDurationRatio:         0.9,
  enableCrossfade:              false,
  crossfadeFrames:              3,
  enableInterpolation:          false,
  outputCodec:                  'libx264',
  audioCodec:                   'aac',
  crf:                          18,
  preset:                       'medium',
}

class CutDecisionService {
  /**
   * Decide trim amounts for one A→B transition.
   *
   * @param {Object} similarityResult - from FrameSimilarityService.analyzePairs()
   * @param {Array}  motionB          - from MotionAnalysisService.analyzeMotion() for clip B first frames
   * @param {Array}  motionA          - from MotionAnalysisService.analyzeMotion() for clip A last frames
   * @param {Object} infoA            - { fps, duration } for clip A
   * @param {Object} infoB            - { fps, duration } for clip B
   * @param {Object} settings         - overrides for DEFAULT_SETTINGS
   *
   * @returns {{
   *   clip_a_trim_end_frames: number,
   *   clip_b_trim_start_frames: number,
   *   recommended_transition: string,
   *   needs_interpolation: boolean,
   *   confidence: number,
   *   reason: string
   * }}
   */
  decide(similarityResult, motionB, motionA, infoA, infoB, settings = {}) {
    const cfg   = { ...DEFAULT_SETTINGS, ...settings }
    const pairs = similarityResult.pairs
    const reasons = []

    // ── Step 1: Trim B frames that are visually identical to last frame of A ──
    let trimB = 0
    for (let i = 0; i < Math.min(pairs.length, cfg.maxTrimFrames); i++) {
      if (pairs[i].similarity >= cfg.duplicateSimilarityThreshold) {
        trimB = i + 1
      } else {
        break
      }
    }
    if (trimB > 0) {
      reasons.push(
        `First ${trimB} frame(s) of clip B duplicate the last frame of A (similarity ≥ ${cfg.duplicateSimilarityThreshold}).`
      )
    }

    // ── Step 2: Continue trimming leading static frames of B beyond duplicate zone ──
    if (motionB && trimB < cfg.maxTrimFrames) {
      for (let i = trimB; i < Math.min(motionB.length, cfg.maxTrimFrames); i++) {
        if (motionB[i].is_static) {
          trimB = i + 1
        } else {
          break
        }
      }
      const activeFr = motionB.find((m, i) => i >= trimB && !m.is_static)
      if (activeFr) {
        reasons.push(`Motion in clip B starts at frame ${activeFr.index + 1} (score ${activeFr.motion_score}).`)
      }
    }

    // ── Step 3: Trim trailing static frames of clip A ──
    let trimA = 0
    if (motionA) {
      let staticTail = 0
      for (let i = motionA.length - 1; i >= 0; i--) {
        if (motionA[i].is_static) staticTail++
        else break
      }
      if (staticTail > 0 && staticTail <= cfg.maxTrimFrames) {
        trimA = staticTail
        reasons.push(`Last ${trimA} frame(s) of clip A are static.`)
      }
    }

    // ── Step 4: Guard minimum clip duration ──
    if (infoA && infoB) {
      const maxTrimSecA = infoA.duration * (1 - cfg.minClipDurationRatio)
      const maxTrimSecB = infoB.duration * (1 - cfg.minClipDurationRatio)
      const cappedTrimA = Math.floor(maxTrimSecA * infoA.fps)
      const cappedTrimB = Math.floor(maxTrimSecB * infoB.fps)

      if (trimA > cappedTrimA) {
        trimA = cappedTrimA
        reasons.push(`Trim A capped at ${trimA}fr to keep ≥${cfg.minClipDurationRatio * 100}% of duration.`)
      }
      if (trimB > cappedTrimB) {
        trimB = cappedTrimB
        reasons.push(`Trim B capped at ${trimB}fr to keep ≥${cfg.minClipDurationRatio * 100}% of duration.`)
      }
    }

    // ── Step 5: Transition recommendation ──
    const activePair = pairs[trimB] ?? pairs[pairs.length - 1]
    const maxSim     = pairs.reduce((m, p) => Math.max(m, p.similarity), 0)

    let recommendedTransition = 'hard_cut_on_motion'
    if (trimB === 0 && maxSim >= cfg.duplicateSimilarityThreshold) {
      recommendedTransition = 'hard_cut'
    } else if (cfg.enableCrossfade) {
      recommendedTransition = 'crossfade'
    }

    // ── Confidence score ──
    const simAfterTrim  = activePair ? 1 - activePair.similarity : 0.5
    const motionClarity = motionB?.[trimB]?.is_static === false ? 1.0 : 0.65
    const rawConf       = 0.5 + simAfterTrim * 0.3 + motionClarity * 0.2
    const confidence    = Math.round(Math.min(1, rawConf) * 100) / 100

    return {
      clip_a_trim_end_frames:    trimA,
      clip_b_trim_start_frames:  trimB,
      recommended_transition:    recommendedTransition,
      needs_interpolation:       cfg.enableInterpolation,
      confidence,
      reason: reasons.length ? reasons.join(' ') : 'No significant overlap detected — no trim needed.',
    }
  }
}

module.exports = { CutDecisionService, DEFAULT_SETTINGS }
