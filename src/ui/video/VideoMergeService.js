'use strict'
/**
 * VideoMergeService
 * Concatenates a list of trimmed clips into a single output file.
 * Strategy: concat demuxer (no re-encode) when crossfade is off;
 *           filter_complex xfade when crossfade is enabled.
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

class VideoMergeService {
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
          reject(new Error(`FFmpeg merge failed${desc ? ' (' + desc + ')' : ''}: ${stderr.slice(-600)}`))
        } else {
          resolve()
        }
      })
    })
  }

  _writeConcatFile(clips, listPath) {
    // Safe quoting for Windows paths: FFmpeg concat format uses single quotes
    const lines = clips.map(c => {
      const normalized = c.replace(/\\/g, '/')
      const escaped    = normalized.replace(/'/g, "\\'")
      return `file '${escaped}'`
    })
    fs.writeFileSync(listPath, lines.join('\n'), 'utf8')
  }

  async _getClipDuration(clipPath) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this._ffprobe, [
        '-v', 'quiet', '-print_format', 'json', '-show_format', clipPath,
      ], { windowsHide: true })
      let stdout = ''
      proc.stdout.on('data', d => stdout += d)
      proc.on('close', () => {
        try { resolve(parseFloat(JSON.parse(stdout).format.duration)) }
        catch { resolve(4.0) }  // fallback if probe fails
      })
    })
  }

  /**
   * Merge clips into outputPath.
   *
   * @param {string[]} clips      - ordered absolute paths to input clips
   * @param {string}   outputPath - absolute path for the output file
   * @param {Object}   settings   - { enableCrossfade, crossfadeFrames, outputCodec, crf, preset, audioCodec }
   */
  async mergeClips(clips, outputPath, settings = {}) {
    if (clips.length === 0) throw new Error('No clips provided for merge')
    if (clips.length === 1) {
      fs.copyFileSync(clips[0], outputPath)
      return
    }

    const {
      enableCrossfade = false,
      crossfadeFrames = 3,
      outputCodec     = 'libx264',
      crf             = 18,
      preset          = 'medium',
      audioCodec      = 'aac',
    } = settings

    if (!enableCrossfade) {
      await this._concatDemuxer(clips, outputPath, outputCodec, crf, preset, audioCodec)
    } else {
      await this._xfadeMerge(clips, outputPath, crossfadeFrames, outputCodec, crf, preset)
    }
  }

  // ── Concat demuxer ─────────────────────────────────────────────────────────

  async _concatDemuxer(clips, outputPath, codec, crf, preset, audioCdc) {
    const listPath = outputPath.replace(/\.[^.]+$/, '_concat_list.txt')
    this._writeConcatFile(clips, listPath)

    try {
      await this._run([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', codec,
        '-crf', String(crf),
        '-preset', preset,
        '-c:a', audioCdc,
        '-movflags', '+faststart',
        outputPath,
      ], 'concat demuxer')
    } finally {
      try { fs.unlinkSync(listPath) } catch { /* ignore */ }
    }
  }

  // ── xfade crossfade ────────────────────────────────────────────────────────

  async _xfadeMerge(clips, outputPath, crossfadeFrames, codec, crf, preset) {
    // We need each clip's duration to compute xfade offsets
    const durations = await Promise.all(clips.map(c => this._getClipDuration(c)))

    const inputs = clips.flatMap(c => ['-i', c])
    const fadeDur = crossfadeFrames / 30  // assume ~30fps display rate for crossfade

    // Build filter_complex: chain xfade between consecutive pairs
    const parts = []
    let prevLabel = '[0:v]'
    let timeOffset = 0

    for (let i = 1; i < clips.length; i++) {
      timeOffset += durations[i - 1] - fadeDur
      const outLabel = i === clips.length - 1 ? '[vout]' : `[v${i}]`
      parts.push(
        `${prevLabel}[${i}:v]xfade=transition=fade:duration=${fadeDur.toFixed(3)}:offset=${timeOffset.toFixed(3)}${outLabel}`
      )
      prevLabel = `[v${i}]`
    }

    await this._run([
      '-y',
      ...inputs,
      '-filter_complex', parts.join(';'),
      '-map', '[vout]',
      '-c:v', codec,
      '-crf', String(crf),
      '-preset', preset,
      '-an',  // crossfade doesn't mix audio; add audio concat as future enhancement
      outputPath,
    ], 'xfade')
  }
}

module.exports = { VideoMergeService }
