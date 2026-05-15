'use strict'
/**
 * Shared low-level utilities: raw pixel extraction via FFmpeg, hash/histogram algorithms.
 * No external image libraries — FFmpeg outputs raw bytes piped to Node.js buffers.
 */

const { spawn } = require('child_process')
const path = require('path')

const THUMB_SIZE = 64       // 64×64 grayscale thumbnails for all comparisons
const THUMB_BYTES = THUMB_SIZE * THUMB_SIZE  // 4096 bytes per frame

/**
 * Extract a 64×64 grayscale thumbnail from a PNG frame as a raw Buffer.
 * Uses ffmpeg pipe:1 → avoids temp files, one subprocess per frame.
 */
async function extractThumbnailPixels(framePath, ffmpegPath = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-y',
      '-i', framePath,
      '-vf', `scale=${THUMB_SIZE}:${THUMB_SIZE}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      'pipe:1',
    ], { windowsHide: true })

    const chunks = []
    proc.stdout.on('data', d => chunks.push(d))
    proc.stderr.on('data', () => {})  // suppress ffmpeg banner

    proc.on('error', e => reject(new Error(`FFmpeg not found (${ffmpegPath}): ${e.message}`)))
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`Thumbnail extraction failed: ${path.basename(framePath)}`))
      const buf = Buffer.concat(chunks)
      resolve(buf.slice(0, THUMB_BYTES))
    })
  })
}

/**
 * Compute difference hash (dHash) from a 64×64 grayscale Buffer.
 * Samples 8×8 grid → compares each pixel to its right neighbour → 64-bit hash array.
 */
function computeDHash(pixelBuf) {
  const step = THUMB_SIZE / 8   // stride = 8 pixels
  const bits = new Uint8Array(64)

  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const px = gx * step
      const py = gy * step
      const idx      = py * THUMB_SIZE + px
      const idxRight = py * THUMB_SIZE + Math.min(px + step, THUMB_SIZE - 1)
      bits[gy * 8 + gx] = pixelBuf[idx] > pixelBuf[idxRight] ? 1 : 0
    }
  }
  return bits
}

/** Hamming distance between two 64-element Uint8Array hashes. */
function hammingDistance(h1, h2) {
  let d = 0
  for (let i = 0; i < 64; i++) if (h1[i] !== h2[i]) d++
  return d
}

/** Hash similarity in [0,1] — 1 = identical, 0 = completely different. */
function hashSimilarity(h1, h2) {
  return 1 - hammingDistance(h1, h2) / 64
}

/**
 * Compute normalized histogram (16 bins) from a grayscale Buffer.
 * Returns Float32Array of length 16, values sum to 1.
 */
function computeHistogram(pixelBuf, bins = 16) {
  const hist = new Float32Array(bins)
  const step = 256 / bins
  for (let i = 0; i < pixelBuf.length; i++) {
    hist[Math.floor(pixelBuf[i] / step)]++
  }
  for (let i = 0; i < bins; i++) hist[i] /= pixelBuf.length
  return hist
}

/**
 * Bhattacharyya coefficient between two normalized histograms.
 * Returns value in [0,1]: 1 = identical distribution, 0 = no overlap.
 */
function histogramSimilarity(h1, h2) {
  let sum = 0
  for (let i = 0; i < h1.length; i++) sum += Math.sqrt(h1[i] * h2[i])
  return sum
}

/**
 * Normalized mean absolute pixel difference.
 * Returns value in [0,1]: 0 = identical, 1 = maximum difference.
 */
function pixelDiff(bufA, bufB) {
  const len = Math.min(bufA.length, bufB.length)
  let total = 0
  for (let i = 0; i < len; i++) total += Math.abs(bufA[i] - bufB[i])
  return total / (len * 255)
}

/**
 * Composite similarity score: 0 = totally different, 1 = identical.
 * Weights: dHash 35%, histogram 35%, pixel similarity 30%.
 */
function compositeScore(dHashSim, histSim, pixDiff) {
  return dHashSim * 0.35 + histSim * 0.35 + (1 - pixDiff) * 0.30
}

module.exports = {
  THUMB_SIZE,
  THUMB_BYTES,
  extractThumbnailPixels,
  computeDHash,
  hammingDistance,
  hashSimilarity,
  computeHistogram,
  histogramSimilarity,
  pixelDiff,
  compositeScore,
}
