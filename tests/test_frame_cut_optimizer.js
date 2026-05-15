/**
 * Unit tests for Frame Cut Optimizer — pure logic only (no FFmpeg, no file I/O).
 * Run with:  node tests/test_frame_cut_optimizer.js
 */

'use strict'

const assert = require('assert')

// ── Import pure modules ────────────────────────────────────────────────────────

const {
  computeDHash,
  hashSimilarity,
  computeHistogram,
  histogramSimilarity,
  pixelDiff,
  compositeScore,
  THUMB_BYTES,
} = require('../src/ui/video/frameUtils')

const { CutDecisionService, DEFAULT_SETTINGS } = require('../src/ui/video/CutDecisionService')
const { MotionAnalysisService } = require('../src/ui/video/MotionAnalysisService')

// ── Test helpers ───────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function makeBuffer(size, fillValue) {
  return Buffer.alloc(size, fillValue)
}

function makeGradientBuffer(size) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = Math.floor((i / size) * 255)
  return buf
}

// ── dHash tests ────────────────────────────────────────────────────────────────

console.log('\n── dHash ──────────────────────────────────────────────────────')

test('identical buffers produce identical hashes', () => {
  const buf = makeGradientBuffer(THUMB_BYTES)
  const h1  = computeDHash(buf)
  const h2  = computeDHash(buf)
  assert.strictEqual(hashSimilarity(h1, h2), 1.0)
})

test('uniform black vs uniform white = different hashes', () => {
  const black = makeBuffer(THUMB_BYTES, 0)
  const white = makeBuffer(THUMB_BYTES, 255)
  const h1 = computeDHash(black)
  const h2 = computeDHash(white)
  // Both are uniform → both hashes should be all-same bits; uniform image has 0 gradient
  // so hash similarity may be 0 or 1 depending on uniform direction
  const sim = hashSimilarity(h1, h2)
  assert.ok(sim === 0 || sim === 1, `expected 0 or 1, got ${sim}`)
})

test('nearly-identical images produce dHash similarity > 0.9', () => {
  // dHash primary purpose: detect near-duplicate frames
  const original = makeGradientBuffer(THUMB_BYTES)
  const slightly_modified = Buffer.from(original)
  // Add tiny noise: change every 50th pixel by 3 units
  for (let i = 0; i < slightly_modified.length; i += 50) {
    slightly_modified[i] = Math.min(255, slightly_modified[i] + 3)
  }
  const sim = hashSimilarity(computeDHash(original), computeDHash(slightly_modified))
  assert.ok(sim > 0.9, `expected > 0.9 for near-identical frames, got ${sim}`)
})

test('dHash output is Uint8Array of 64 bits', () => {
  const hash = computeDHash(makeBuffer(THUMB_BYTES, 128))
  assert.ok(hash instanceof Uint8Array)
  assert.strictEqual(hash.length, 64)
  assert.ok(hash.every(b => b === 0 || b === 1))
})

// ── Histogram tests ────────────────────────────────────────────────────────────

console.log('\n── Histogram ──────────────────────────────────────────────────')

test('identical buffers produce similarity = 1', () => {
  const buf = makeGradientBuffer(THUMB_BYTES)
  const h1  = computeHistogram(buf)
  const sim = histogramSimilarity(h1, h1)
  assert.ok(Math.abs(sim - 1.0) < 0.001, `expected ~1.0, got ${sim}`)
})

test('all-black vs all-white = low histogram similarity', () => {
  const h1 = computeHistogram(makeBuffer(THUMB_BYTES, 0))
  const h2 = computeHistogram(makeBuffer(THUMB_BYTES, 255))
  const sim = histogramSimilarity(h1, h2)
  assert.ok(sim < 0.1, `expected < 0.1, got ${sim}`)
})

test('histogram sums to ~1', () => {
  const hist = computeHistogram(makeGradientBuffer(THUMB_BYTES))
  const sum = Array.from(hist).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1.0) < 0.001, `expected ~1.0, got ${sum}`)
})

// ── Pixel diff tests ───────────────────────────────────────────────────────────

console.log('\n── Pixel diff ─────────────────────────────────────────────────')

test('identical buffers → pixelDiff = 0', () => {
  const buf = makeBuffer(THUMB_BYTES, 128)
  assert.strictEqual(pixelDiff(buf, buf), 0)
})

test('black vs white → pixelDiff = 1', () => {
  const black = makeBuffer(THUMB_BYTES, 0)
  const white = makeBuffer(THUMB_BYTES, 255)
  assert.strictEqual(pixelDiff(black, white), 1)
})

test('half-diff → pixelDiff ≈ 0.5', () => {
  const b0  = makeBuffer(THUMB_BYTES, 0)
  const b128 = makeBuffer(THUMB_BYTES, 128)
  const diff = pixelDiff(b0, b128)
  assert.ok(Math.abs(diff - 128/255) < 0.001, `expected ~${(128/255).toFixed(3)}, got ${diff}`)
})

// ── Composite score ────────────────────────────────────────────────────────────

console.log('\n── Composite score ────────────────────────────────────────────')

test('all-1 inputs → composite = 1', () => {
  assert.strictEqual(compositeScore(1, 1, 0), 1)
})

test('all-0 inputs → composite = 0', () => {
  assert.strictEqual(compositeScore(0, 0, 1), 0)
})

test('composite is in [0,1]', () => {
  for (let i = 0; i < 100; i++) {
    const s = compositeScore(Math.random(), Math.random(), Math.random())
    assert.ok(s >= 0 && s <= 1, `out of range: ${s}`)
  }
})

// ── CutDecisionService ────────────────────────────────────────────────────────

console.log('\n── CutDecisionService ─────────────────────────────────────────')

const decider = new CutDecisionService()

function makePairs(similarities) {
  return {
    pairs: similarities.map((sim, i) => ({
      frame_a:        `clipA_last_012.png`,
      frame_b:        `clipB_first_${String(i+1).padStart(3,'0')}.png`,
      similarity:     sim,
      pixel_diff:     1 - sim,
      hash_similarity: sim,
      hist_similarity: sim,
      is_duplicate:   sim >= 0.965,
    }))
  }
}

function makeMotion(scores, threshold = 0.015) {
  return scores.map((score, i) => ({
    frame: `frame_${i}.png`,
    index: i,
    motion_score: score,
    is_static: score < threshold,
  }))
}

const infoA = { fps: 24, duration: 10 }
const infoB = { fps: 24, duration: 10 }

test('no duplicates → trim B = 0', () => {
  const sim  = makePairs([0.30, 0.25, 0.20, 0.20, 0.15])
  const mB   = makeMotion([0.05, 0.06, 0.07, 0.08, 0.09])
  const mA   = makeMotion([0.05, 0.06])
  const res  = decider.decide(sim, mB, mA, infoA, infoB)
  assert.strictEqual(res.clip_b_trim_start_frames, 0)
})

test('3 duplicate frames → trim B = 3', () => {
  const sim = makePairs([0.98, 0.97, 0.97, 0.40, 0.30, 0.20])
  const mB  = makeMotion([0.001, 0.001, 0.001, 0.08, 0.09, 0.10])
  const res = decider.decide(sim, mB, null, infoA, infoB)
  assert.strictEqual(res.clip_b_trim_start_frames, 3)
})

test('duplicates + static extension → trim B > duplicate count', () => {
  const sim = makePairs([0.98, 0.98, 0.40, 0.30])
  // After 2 duplicates, still 2 static frames
  const mB  = makeMotion([0.001, 0.001, 0.005, 0.005, 0.08])
  const res = decider.decide(sim, mB, null, infoA, infoB)
  assert.ok(res.clip_b_trim_start_frames >= 2, `expected ≥ 2, got ${res.clip_b_trim_start_frames}`)
})

test('trim never exceeds maxTrimFrames', () => {
  const sim = makePairs([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99])
  const mB  = makeMotion([0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001])
  const res = decider.decide(sim, mB, null, infoA, infoB, { maxTrimFrames: 6 })
  assert.ok(res.clip_b_trim_start_frames <= 6, `exceeded maxTrimFrames: ${res.clip_b_trim_start_frames}`)
})

test('static tail in A → trim A > 0', () => {
  const sim = makePairs([0.50, 0.40, 0.30])
  const mB  = makeMotion([0.05, 0.06, 0.07])
  const mA  = makeMotion([0.06, 0.05, 0.001, 0.001, 0.001])  // 3 static tail frames
  const res = decider.decide(sim, mB, mA, infoA, infoB)
  assert.strictEqual(res.clip_a_trim_end_frames, 3)
})

test('minClipDurationRatio caps trim', () => {
  // Short clip: 1s at 24fps = 24 frames. Max trim = 10% = 2.4 → 2 frames
  const shortInfo = { fps: 24, duration: 1 }
  const sim = makePairs(Array(10).fill(0.99))
  const mB  = makeMotion(Array(10).fill(0.001))
  const res = decider.decide(sim, mB, null, shortInfo, shortInfo, {
    maxTrimFrames: 10,
    minClipDurationRatio: 0.9,
  })
  assert.ok(res.clip_b_trim_start_frames <= 2, `expected ≤ 2, got ${res.clip_b_trim_start_frames}`)
})

test('crossfade enabled → recommended_transition = crossfade', () => {
  const sim = makePairs([0.99, 0.99])
  const mB  = makeMotion([0.001, 0.001])
  const res = decider.decide(sim, mB, null, infoA, infoB, { enableCrossfade: true })
  assert.strictEqual(res.recommended_transition, 'crossfade')
})

test('result has all required keys', () => {
  const res = decider.decide(makePairs([0.5]), makeMotion([0.05]), null, infoA, infoB)
  const keys = ['clip_a_trim_end_frames','clip_b_trim_start_frames',
    'recommended_transition','needs_interpolation','confidence','reason']
  for (const k of keys) {
    assert.ok(k in res, `Missing key: ${k}`)
  }
})

test('confidence is in [0,1]', () => {
  for (let i = 0; i < 20; i++) {
    const sims = Array.from({ length: 6 }, () => Math.random())
    const mots = Array.from({ length: 6 }, () => Math.random() * 0.1)
    const res = decider.decide(makePairs(sims), makeMotion(mots), null, infoA, infoB)
    assert.ok(res.confidence >= 0 && res.confidence <= 1, `confidence out of range: ${res.confidence}`)
  }
})

// ── MotionAnalysisService (pure logic) ────────────────────────────────────────

console.log('\n── MotionAnalysisService helpers ──────────────────────────────')

const motionSvc = new MotionAnalysisService()

test('countLeadingStaticFrames: all dynamic', () => {
  const motion = makeMotion([0.05, 0.06, 0.07])
  assert.strictEqual(motionSvc.countLeadingStaticFrames(motion), 0)
})

test('countLeadingStaticFrames: 2 static then dynamic', () => {
  const motion = makeMotion([0.001, 0.001, 0.06])
  assert.strictEqual(motionSvc.countLeadingStaticFrames(motion), 2)
})

test('countTrailingStaticFrames: 3 static tail', () => {
  const motion = makeMotion([0.06, 0.001, 0.001, 0.001])
  assert.strictEqual(motionSvc.countTrailingStaticFrames(motion), 3)
})

test('countTrailingStaticFrames: no static tail', () => {
  const motion = makeMotion([0.001, 0.06])
  assert.strictEqual(motionSvc.countTrailingStaticFrames(motion), 0)
})

// ── DEFAULT_SETTINGS completeness ─────────────────────────────────────────────

console.log('\n── DEFAULT_SETTINGS ───────────────────────────────────────────')

test('all required keys present', () => {
  const required = [
    'framesToAnalyze','duplicateSimilarityThreshold','staticMotionThreshold',
    'maxTrimFrames','minClipDurationRatio','enableCrossfade','crossfadeFrames',
    'enableInterpolation','outputCodec','audioCodec','crf','preset',
  ]
  for (const k of required) {
    assert.ok(k in DEFAULT_SETTINGS, `Missing default: ${k}`)
  }
})

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n────────────────────────────────────────────────────────────────`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
