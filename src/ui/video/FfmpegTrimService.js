'use strict'
/**
 * FfmpegTrimService
 * Trims a single clip by removing N frames from the start and/or M frames from the end.
 * Re-encodes only when trim is needed; falls back to stream-copy when safe.
 * Preserves audio/video sync.
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

class FfmpegTrimService {
  constructor(ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe') {
    this._ffmpeg  = ffmpegPath
    this._ffprobe = ffprobePath
  }

  _run(args, desc = '') {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._ffmpeg, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', d => stderr += d)
      proc.on('error', e => reject(new Error(`FFmpeg not found: ${e.message}`)))
      proc.on('close', code => {
        if (code !== 0) {
          reject(new Error(`FFmpeg trim failed${desc ? ' (' + desc + ')' : ''}: ${stderr.slice(-500)}`))
        } else {
          resolve()
        }
      })
    })
  }

  async _getDuration(inputPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._ffprobe, [
        '-v', 'quiet', '-print_format', 'json', '-show_format', inputPath,
      ], { windowsHide: true })
      let stdout = ''
      proc.stdout.on('data', d => stdout += d)
      proc.on('close', code => {
        if (code !== 0) return reject(new Error('FFprobe failed during trim'))
        try {
          const duration = parseFloat(JSON.parse(stdout).format.duration)
          resolve(duration)
        } catch (e) {
          reject(new Error(`Could not parse duration: ${e.message}`))
        }
      })
    })
  }

  async _hasAudio(inputPath) {
    return new Promise(resolve => {
      const proc = spawn(this._ffprobe, [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath,
      ], { windowsHide: true })
      let stdout = ''
      proc.stdout.on('data', d => stdout += d)
      proc.on('close', () => {
        try {
          resolve(JSON.parse(stdout).streams.some(s => s.codec_type === 'audio'))
        } catch { resolve(false) }
      })
    })
  }

  /**
   * Trim `inputPath` → `outputPath` by removing `trimStartFrames` from the start
   * and `trimEndFrames` from the end, at the given `fps`.
   *
   * If both are 0, the file is copied without re-encoding.
   */
  async trimClip(inputPath, outputPath, trimStartFrames, trimEndFrames, fps, opts = {}) {
    const {
      codec   = 'libx264',
      crf     = 18,
      preset  = 'medium',
      audioCdc = 'aac',
    } = opts

    // No trim needed → copy file
    if (trimStartFrames === 0 && trimEndFrames === 0) {
      fs.copyFileSync(inputPath, outputPath)
      return
    }

    const duration  = await this._getDuration(inputPath)
    const startSec  = trimStartFrames / fps
    const endSec    = duration - (trimEndFrames / fps)

    if (endSec - startSec < 0.1) {
      throw new Error(
        `Trim of "${path.basename(inputPath)}" produces a clip shorter than 0.1s ` +
        `(start=${startSec.toFixed(3)}s, end=${endSec.toFixed(3)}s)`
      )
    }

    const hasAudio = await this._hasAudio(inputPath)

    // Re-encode to ensure precise frame-accurate trim.
    // Stream-copy can't guarantee frame-accuracy with -ss/-to.
    const args = [
      '-y',
      '-i', inputPath,
      '-ss', startSec.toFixed(6),
      '-to', endSec.toFixed(6),
      '-c:v', codec,
      '-crf', String(crf),
      '-preset', preset,
    ]

    if (hasAudio) {
      args.push('-c:a', audioCdc)
    } else {
      args.push('-an')
    }

    args.push('-movflags', '+faststart', outputPath)
    await this._run(args, path.basename(inputPath))
  }
}

module.exports = { FfmpegTrimService }
