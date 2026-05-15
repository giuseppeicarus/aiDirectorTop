'use strict'
/**
 * FrameSimilarityService
 * Compares last frames of clip A against first frames of clip B.
 * Uses FFmpeg raw pixel thumbnails + pure-JS hash/histogram/diff algorithms (no new deps).
 */

const path = require('path')
const {
  extractThumbnailPixels,
  computeDHash,
  hashSimilarity,
  computeHistogram,
  histogramSimilarity,
  pixelDiff,
  compositeScore,
} = require('./frameUtils')

class FrameSimilarityService {
  constructor(ffmpegPath = 'ffmpeg') {
    this._ffmpeg = ffmpegPath
  }

  /** Load all thumbnails for a list of frame paths in parallel. */
  async _loadThumbnails(framePaths) {
    return Promise.all(framePaths.map(fp => extractThumbnailPixels(fp, this._ffmpeg)))
  }

  /**
   * Analyze similarity between last frames of A and first frames of B.
   *
   * Primary comparison: last frame of A vs. each frame of B (catches duplicate overlap).
   * Secondary: each consecutive pair within A and within B (used by motion analysis).
   *
   * Returns { pairs } where each pair covers last-A vs. clipB_first_N.
   */
  async analyzePairs(framesA, framesB, similarityThreshold = 0.965) {
    // Load all thumbnails once (parallel)
    const [thumbsA, thumbsB] = await Promise.all([
      this._loadThumbnails(framesA),
      this._loadThumbnails(framesB),
    ])

    // Pre-compute hashes + histograms
    const hashesA = thumbsA.map(computeDHash)
    const hashesB = thumbsB.map(computeDHash)
    const histsA  = thumbsA.map(t => computeHistogram(t))
    const histsB  = thumbsB.map(t => computeHistogram(t))

    // Compare last frame of A against every frame of B
    const lastIdx  = framesA.length - 1
    const lastThumbA = thumbsA[lastIdx]
    const lastHashA  = hashesA[lastIdx]
    const lastHistA  = histsA[lastIdx]

    const pairs = framesB.map((fb, i) => {
      const dHash  = hashSimilarity(lastHashA, hashesB[i])
      const hist   = histogramSimilarity(lastHistA, histsB[i])
      const diff   = pixelDiff(lastThumbA, thumbsB[i])
      const sim    = compositeScore(dHash, hist, diff)

      return {
        frame_a:        path.basename(framesA[lastIdx]),
        frame_b:        path.basename(fb),
        similarity:     round3(sim),
        pixel_diff:     round3(diff),
        hash_similarity: round3(dHash),
        hist_similarity: round3(hist),
        is_duplicate:   sim >= similarityThreshold,
      }
    })

    return {
      pairs,
      // Also expose pre-computed data for motion analysis re-use
      _thumbsA: thumbsA,
      _thumbsB: thumbsB,
    }
  }
}

function round3(v) { return Math.round(v * 1000) / 1000 }

module.exports = { FrameSimilarityService }
