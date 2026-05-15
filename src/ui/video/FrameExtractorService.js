'use strict'
/**
 * FrameExtractorService
 * Extracts last N frames of clip A and first N frames of clip B into a job-scoped temp dir.
 * Uses FFmpeg for extraction and FFprobe for metadata.
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

class FrameExtractorService {
  constructor(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe') {
    this._ffmpeg  = ffmpegPath
    this._ffprobe = ffprobePath
  }

  /** Temp directory for a job. */
  jobDir(jobId) {
    return path.join(os.tmpdir(), 'fco_jobs', jobId)
  }

  prepareJobDir(jobId) {
    const dir = this.jobDir(jobId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  cleanupJob(jobId) {
    try {
      fs.rmSync(this.jobDir(jobId), { recursive: true, force: true })
    } catch { /* already gone */ }
  }

  // ── FFprobe ────────────────────────────────────────────────────────────────

  /**
   * Returns { fps, duration, width, height } for a video file.
   * Throws descriptive errors for common failure modes.
   */
  async getVideoInfo(clipPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        clipPath,
      ], { windowsHide: true })

      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', d => stdout += d)
      proc.stderr.on('data', d => stderr += d)
      proc.on('error', e => reject(new Error(`FFprobe not found (${this._ffprobe}): ${e.message}`)))
      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`FFprobe failed for "${path.basename(clipPath)}": ${stderr.slice(-300)}`))
        }
        try {
          const info = JSON.parse(stdout)
          const vs = info.streams.find(s => s.codec_type === 'video')
          if (!vs) return reject(new Error(`No video stream in "${path.basename(clipPath)}"`))

          // r_frame_rate can be "30/1" or "30000/1001"
          const [num, den] = vs.r_frame_rate.split('/').map(Number)
          const fps = den && den !== 0 ? num / den : num
          if (!fps || fps < 1 || fps > 300) {
            return reject(new Error(`Could not detect FPS for "${path.basename(clipPath)}" (got ${vs.r_frame_rate})`))
          }

          const duration = parseFloat(info.format?.duration || vs.duration || 0)
          if (duration < 0.1) {
            return reject(new Error(`Clip "${path.basename(clipPath)}" is too short (${duration.toFixed(2)}s)`))
          }

          resolve({
            fps,
            duration,
            width:  vs.width,
            height: vs.height,
            hasAudio: info.streams.some(s => s.codec_type === 'audio'),
          })
        } catch (e) {
          reject(new Error(`Failed to parse FFprobe output: ${e.message}`))
        }
      })
    })
  }

  // ── Frame extraction ───────────────────────────────────────────────────────

  /**
   * Extract `count` frames starting at `startSec` into `outDir` as `prefix_NNN.png`.
   * Returns sorted array of absolute PNG paths.
   */
  async extractFrames(clipPath, outDir, prefix, startSec, count) {
    return new Promise((resolve, reject) => {
      const outPattern = path.join(outDir, `${prefix}_%03d.png`)

      const args = [
        '-y',
        '-ss', String(Math.max(0, startSec)),
        '-i', clipPath,
        '-vframes', String(count),
        '-vsync', 'vfr',
        '-f', 'image2',
        outPattern,
      ]

      const proc = spawn(this._ffmpeg, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', d => stderr += d)
      proc.on('error', e => reject(new Error(`FFmpeg not found: ${e.message}`)))
      proc.on('close', code => {
        if (code !== 0) {
          return reject(new Error(
            `Frame extraction failed for "${path.basename(clipPath)}": ${stderr.slice(-400)}`
          ))
        }

        const files = fs.readdirSync(outDir)
          .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
          .sort()
          .map(f => path.join(outDir, f))

        if (files.length === 0) {
          return reject(new Error(
            `No frames extracted from "${path.basename(clipPath)}" at ${startSec.toFixed(2)}s`
          ))
        }

        resolve(files)
      })
    })
  }

  // ── Main entry point ───────────────────────────────────────────────────────

  /**
   * Full extraction for one A→B transition.
   * Returns { jobDir, framesA, framesB, infoA, infoB }
   *
   * framesA: sorted last-N-frames of clip A (index 0 = earliest of the tail)
   * framesB: sorted first-N-frames of clip B (index 0 = very first frame)
   */
  async extractJobFrames(jobId, clipAPath, clipBPath, framesToAnalyze = 12) {
    const dir = this.prepareJobDir(jobId)

    const [infoA, infoB] = await Promise.all([
      this.getVideoInfo(clipAPath),
      this.getVideoInfo(clipBPath),
    ])

    // Last N frames of A: seek to (duration - N/fps) before end
    const frameDurA = 1 / infoA.fps
    const startSecA = Math.max(0, infoA.duration - framesToAnalyze * frameDurA - 0.1)

    const [framesA, framesB] = await Promise.all([
      this.extractFrames(clipAPath, dir, 'clipA_last', startSecA, framesToAnalyze),
      this.extractFrames(clipBPath, dir, 'clipB_first', 0, framesToAnalyze),
    ])

    return { jobDir: dir, framesA, framesB, infoA, infoB }
  }
}

module.exports = { FrameExtractorService }
