'use strict'
/**
 * MotionAnalysisService
 * Detects static/duplicate frames within a sequence by comparing consecutive thumbnails.
 * Reuses pre-extracted thumbnails from FrameSimilarityService when available.
 */

const path = require('path')
const { extractThumbnailPixels, pixelDiff } = require('./frameUtils')

class MotionAnalysisService {
  constructor(ffmpegPath = 'ffmpeg') {
    this._ffmpeg = ffmpegPath
  }

  /**
   * Analyze motion between consecutive frames.
   *
   * @param {string[]} framePaths - ordered frame file paths
   * @param {number}   staticThreshold - motion_score below this = static frame (default 0.015)
   * @param {Buffer[]} [preloadedThumbs] - optional pre-computed thumbnails (avoids re-reading)
   * @returns {Promise<Array<{frame, index, motion_score, is_static}>>}
   */
  async analyzeMotion(framePaths, staticThreshold = 0.015, preloadedThumbs = null) {
    if (framePaths.length === 0) return []

    const thumbs = preloadedThumbs
      ?? await Promise.all(framePaths.map(fp => extractThumbnailPixels(fp, this._ffmpeg)))

    const result = []

    // First frame: compare to second (no predecessor)
    const firstScore = framePaths.length > 1
      ? pixelDiff(thumbs[0], thumbs[1])
      : 0

    result.push({
      frame:        path.basename(framePaths[0]),
      index:        0,
      motion_score: round4(firstScore),
      is_static:    firstScore < staticThreshold,
    })

    // Subsequent frames: compare to predecessor
    for (let i = 1; i < framePaths.length; i++) {
      const score = pixelDiff(thumbs[i - 1], thumbs[i])
      result.push({
        frame:        path.basename(framePaths[i]),
        index:        i,
        motion_score: round4(score),
        is_static:    score < staticThreshold,
      })
    }

    return result
  }

  /**
   * Count how many leading frames in an array are static.
   * Used to find the first "active" frame in clip B.
   */
  countLeadingStaticFrames(motionResult) {
    let count = 0
    for (const m of motionResult) {
      if (m.is_static) count++
      else break
    }
    return count
  }

  /**
   * Count how many trailing frames in an array are static.
   * Used to detect frozen tail in clip A.
   */
  countTrailingStaticFrames(motionResult) {
    let count = 0
    for (let i = motionResult.length - 1; i >= 0; i--) {
      if (motionResult[i].is_static) count++
      else break
    }
    return count
  }
}

function round4(v) { return Math.round(v * 10000) / 10000 }

module.exports = { MotionAnalysisService }
