/**
 * TransitionEngine — WebGL-based transition renderer.
 * Supports: CSS, Canvas 2D, and WebGL (including 3D) transitions.
 */

export const TRANSITIONS = {
  cut:         { id:'cut',         label:'Cut',          cat:'basic',      duration:0,    icon:'✂️',  ffmpeg:null },
  fade:        { id:'fade',        label:'Fade',         cat:'basic',      duration:0.5,  icon:'○',   ffmpeg:'xfade=fade' },
  dissolve:    { id:'dissolve',    label:'Dissolve',     cat:'basic',      duration:0.6,  icon:'◎',   ffmpeg:'xfade=dissolve' },
  flash:       { id:'flash',       label:'Flash',        cat:'basic',      duration:0.3,  icon:'⚡',  ffmpeg:'xfade=fadewhite' },
  black:       { id:'black',       label:'Fade Black',   cat:'basic',      duration:0.5,  icon:'■',   ffmpeg:'xfade=fadeblack' },

  slide_left:  { id:'slide_left',  label:'Slide Left',   cat:'slide',      duration:0.4,  icon:'←',   ffmpeg:'xfade=slideleft' },
  slide_right: { id:'slide_right', label:'Slide Right',  cat:'slide',      duration:0.4,  icon:'→',   ffmpeg:'xfade=slideright' },
  slide_up:    { id:'slide_up',    label:'Slide Up',     cat:'slide',      duration:0.4,  icon:'↑',   ffmpeg:'xfade=slideup' },
  slide_down:  { id:'slide_down',  label:'Slide Down',   cat:'slide',      duration:0.4,  icon:'↓',   ffmpeg:'xfade=slidedown' },
  push_left:   { id:'push_left',   label:'Push Left',    cat:'slide',      duration:0.4,  icon:'⇐',   ffmpeg:'xfade=hlslice' },
  push_right:  { id:'push_right',  label:'Push Right',   cat:'slide',      duration:0.4,  icon:'⇒',   ffmpeg:'xfade=hrslice' },

  wipe_left:   { id:'wipe_left',   label:'Wipe Left',    cat:'wipe',       duration:0.5,  icon:'▷',   ffmpeg:'xfade=wipeleft' },
  wipe_right:  { id:'wipe_right',  label:'Wipe Right',   cat:'wipe',       duration:0.5,  icon:'◁',   ffmpeg:'xfade=wiperight' },
  wipe_up:     { id:'wipe_up',     label:'Wipe Up',      cat:'wipe',       duration:0.5,  icon:'△',   ffmpeg:'xfade=wipeup' },
  wipe_down:   { id:'wipe_down',   label:'Wipe Down',    cat:'wipe',       duration:0.5,  icon:'▽',   ffmpeg:'xfade=wipedown' },
  radial:      { id:'radial',      label:'Radial',       cat:'wipe',       duration:0.6,  icon:'◉',   ffmpeg:'xfade=radial' },
  iris:        { id:'iris',        label:'Iris',         cat:'wipe',       duration:0.6,  icon:'◎',   ffmpeg:'xfade=circleopen' },

  zoom_in:     { id:'zoom_in',     label:'Zoom In',      cat:'cinematic',  duration:0.5,  icon:'⊕',   ffmpeg:'xfade=zoomin' },
  zoom_blur:   { id:'zoom_blur',   label:'Zoom Blur',    cat:'cinematic',  duration:0.6,  icon:'⊙',   ffmpeg:'xfade=zoomin' },
  film_burn:   { id:'film_burn',   label:'Film Burn',    cat:'cinematic',  duration:0.8,  icon:'🎞',   ffmpeg:'xfade=distance' },
  light_leak:  { id:'light_leak',  label:'Light Leak',   cat:'cinematic',  duration:0.7,  icon:'☀',   ffmpeg:'xfade=fadewhite' },
  glitch:      { id:'glitch',      label:'Glitch',       cat:'cinematic',  duration:0.4,  icon:'▦',   ffmpeg:'xfade=pixelize' },
  pixelate:    { id:'pixelate',    label:'Pixelate',     cat:'cinematic',  duration:0.5,  icon:'⊞',   ffmpeg:'xfade=pixelize' },

  cube:        { id:'cube',        label:'Cube',         cat:'3d',         duration:0.7,  icon:'⬡',   ffmpeg:'xfade=slideleft' },
  page_turn:   { id:'page_turn',   label:'Page Turn',    cat:'3d',         duration:0.8,  icon:'📄',  ffmpeg:'xfade=wipeleft' },
  flip_h:      { id:'flip_h',      label:'Flip H',       cat:'3d',         duration:0.6,  icon:'⟺',   ffmpeg:'xfade=hblur' },
  flip_v:      { id:'flip_v',      label:'Flip V',       cat:'3d',         duration:0.6,  icon:'⟻',   ffmpeg:'xfade=vblur' },
  fold:        { id:'fold',        label:'Fold',         cat:'3d',         duration:0.7,  icon:'⊿',   ffmpeg:'xfade=wipeleft' },
}

export const TRANSITION_CATEGORIES = [
  { id:'basic',     label:'Base'     },
  { id:'slide',     label:'Slide'    },
  { id:'wipe',      label:'Wipe'     },
  { id:'cinematic', label:'Cinema'   },
  { id:'3d',        label:'3D'       },
]

export const DEFAULT_TRANSITION = 'cut'

export function transitionDuration(id) {
  return TRANSITIONS[id]?.duration ?? 0
}

export function transitionFFmpeg(id, durationSec = 0.5) {
  const t = TRANSITIONS[id]
  if (!t || !t.ffmpeg) return null
  return `${t.ffmpeg}:duration=${durationSec}:offset=CLIP_OFFSET`
}

const VERT_SHADER = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`

const FRAG_BASE = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_from;
  uniform sampler2D u_to;
  uniform float u_progress;
`

const SHADERS = {
  fade: FRAG_BASE + `
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      gl_FragColor = mix(a, b, u_progress);
    }`,

  dissolve: FRAG_BASE + `
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      float noise = rand(v_uv);
      gl_FragColor = noise < u_progress ? b : a;
    }`,

  flash: FRAG_BASE + `
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      float flash = u_progress < 0.5 ? u_progress * 2.0 : (1.0 - u_progress) * 2.0;
      gl_FragColor = mix(mix(a, b, u_progress), vec4(1.0), flash * 0.8);
    }`,

  black: FRAG_BASE + `
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      float mid = u_progress < 0.5 ? u_progress * 2.0 : (u_progress - 0.5) * 2.0;
      vec4 src = u_progress < 0.5 ? a : b;
      gl_FragColor = mix(src, vec4(0.0, 0.0, 0.0, 1.0), mid);
    }`,

  slide_left: FRAG_BASE + `
    void main() {
      vec2 uv_from = vec2(v_uv.x + u_progress, v_uv.y);
      vec2 uv_to   = vec2(v_uv.x + u_progress - 1.0, v_uv.y);
      if (uv_from.x < 1.0) gl_FragColor = texture2D(u_from, uv_from);
      else gl_FragColor = texture2D(u_to, uv_to);
    }`,

  slide_right: FRAG_BASE + `
    void main() {
      vec2 uv_from = vec2(v_uv.x - u_progress, v_uv.y);
      vec2 uv_to   = vec2(v_uv.x - u_progress + 1.0, v_uv.y);
      if (uv_from.x >= 0.0) gl_FragColor = texture2D(u_from, uv_from);
      else gl_FragColor = texture2D(u_to, uv_to);
    }`,

  slide_up: FRAG_BASE + `
    void main() {
      vec2 uv_from = vec2(v_uv.x, v_uv.y + u_progress);
      vec2 uv_to   = vec2(v_uv.x, v_uv.y + u_progress - 1.0);
      if (uv_from.y < 1.0) gl_FragColor = texture2D(u_from, uv_from);
      else gl_FragColor = texture2D(u_to, uv_to);
    }`,

  slide_down: FRAG_BASE + `
    void main() {
      vec2 uv_from = vec2(v_uv.x, v_uv.y - u_progress);
      vec2 uv_to   = vec2(v_uv.x, v_uv.y - u_progress + 1.0);
      if (uv_from.y >= 0.0) gl_FragColor = texture2D(u_from, uv_from);
      else gl_FragColor = texture2D(u_to, uv_to);
    }`,

  push_left: FRAG_BASE + `
    void main() {
      vec2 uv_a = vec2(v_uv.x + u_progress, v_uv.y);
      vec2 uv_b = vec2(v_uv.x + u_progress - 1.0, v_uv.y);
      if (uv_a.x < 1.0 && uv_a.x >= 0.0) gl_FragColor = texture2D(u_from, uv_a);
      else if (uv_b.x >= 0.0 && uv_b.x < 1.0) gl_FragColor = texture2D(u_to, uv_b);
      else gl_FragColor = vec4(0.0);
    }`,

  wipe_left: FRAG_BASE + `
    void main() {
      gl_FragColor = v_uv.x < (1.0 - u_progress) ? texture2D(u_from, v_uv) : texture2D(u_to, v_uv);
    }`,

  wipe_right: FRAG_BASE + `
    void main() {
      gl_FragColor = v_uv.x > (1.0 - u_progress) ? texture2D(u_from, v_uv) : texture2D(u_to, v_uv);
    }`,

  wipe_up: FRAG_BASE + `
    void main() {
      gl_FragColor = v_uv.y < (1.0 - u_progress) ? texture2D(u_from, v_uv) : texture2D(u_to, v_uv);
    }`,

  wipe_down: FRAG_BASE + `
    void main() {
      gl_FragColor = v_uv.y > (1.0 - u_progress) ? texture2D(u_from, v_uv) : texture2D(u_to, v_uv);
    }`,

  radial: FRAG_BASE + `
    void main() {
      vec2 c = v_uv - 0.5;
      float angle = atan(c.y, c.x) / (2.0 * 3.14159) + 0.5;
      gl_FragColor = angle < u_progress ? texture2D(u_to, v_uv) : texture2D(u_from, v_uv);
    }`,

  iris: FRAG_BASE + `
    void main() {
      float dist = length(v_uv - 0.5) * 1.414;
      gl_FragColor = dist < u_progress ? texture2D(u_to, v_uv) : texture2D(u_from, v_uv);
    }`,

  zoom_in: FRAG_BASE + `
    void main() {
      float scale = 1.0 + u_progress * 0.3;
      vec2 uv = (v_uv - 0.5) / scale + 0.5;
      gl_FragColor = mix(texture2D(u_from, uv), texture2D(u_to, v_uv), u_progress);
    }`,

  zoom_blur: FRAG_BASE + `
    void main() {
      vec4 blur = vec4(0.0);
      int samples = 8;
      for (int i = 0; i < 8; i++) {
        float scale = 1.0 + float(i) * u_progress * 0.05;
        vec2 uv = (v_uv - 0.5) / scale + 0.5;
        blur += texture2D(u_from, uv);
      }
      blur /= 8.0;
      gl_FragColor = mix(blur, texture2D(u_to, v_uv), u_progress);
    }`,

  film_burn: FRAG_BASE + `
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453); }
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      float burn = rand(v_uv + u_progress) * 0.4;
      vec4 orange = vec4(1.0, 0.4, 0.0, 1.0);
      float mask = smoothstep(u_progress - 0.1, u_progress + 0.1, v_uv.x + burn);
      gl_FragColor = mix(mix(a, orange, burn * (1.0-mask)), b, mask);
    }`,

  light_leak: FRAG_BASE + `
    void main() {
      vec4 a = texture2D(u_from, v_uv);
      vec4 b = texture2D(u_to, v_uv);
      float leak = sin(u_progress * 3.14159) * 0.9;
      vec4 light = vec4(1.0, 0.95, 0.8, 1.0) * leak;
      gl_FragColor = mix(mix(a, b, u_progress) + light * 0.5, b, u_progress);
    }`,

  glitch: FRAG_BASE + `
    float rand(float x) { return fract(sin(x * 127.1) * 43758.5453); }
    void main() {
      float sliceY = floor(v_uv.y * 20.0) / 20.0;
      float offset = (rand(sliceY + u_progress) - 0.5) * u_progress * 0.2;
      vec2 uvA = vec2(v_uv.x + offset, v_uv.y);
      vec2 uvB = vec2(v_uv.x - offset, v_uv.y);
      gl_FragColor = mix(texture2D(u_from, uvA), texture2D(u_to, uvB), u_progress);
    }`,

  pixelate: FRAG_BASE + `
    void main() {
      float px = mix(1.0, 32.0, sin(u_progress * 3.14159));
      vec2 uv = floor(v_uv * px) / px;
      gl_FragColor = mix(texture2D(u_from, uv), texture2D(u_to, uv), u_progress);
    }`,

  cube: FRAG_BASE + `
    void main() {
      float p = u_progress;
      float angle = p * 1.5708;
      float facing = cos(angle);
      float side   = sin(angle);
      if (p < 0.5) {
        vec2 uv = vec2(v_uv.x / facing - (1.0 - facing) * 0.5, v_uv.y);
        if (uv.x >= 0.0 && uv.x <= 1.0) gl_FragColor = texture2D(u_from, uv);
        else gl_FragColor = texture2D(u_to, v_uv);
      } else {
        vec2 uv = vec2((v_uv.x - (1.0 - facing) * 0.5) / facing, v_uv.y);
        if (uv.x >= 0.0 && uv.x <= 1.0) gl_FragColor = texture2D(u_to, uv);
        else gl_FragColor = texture2D(u_from, v_uv);
      }
    }`,

  page_turn: FRAG_BASE + `
    void main() {
      float p = u_progress;
      float fold = 1.0 - p;
      if (v_uv.x < fold) {
        gl_FragColor = texture2D(u_from, v_uv);
      } else {
        float shadow = smoothstep(fold, fold + 0.05, v_uv.x) * 0.5;
        vec2 uv = vec2((v_uv.x - fold) / (1.0 - fold), v_uv.y);
        gl_FragColor = mix(texture2D(u_to, uv), vec4(0.0, 0.0, 0.0, 1.0), shadow);
      }
    }`,

  flip_h: FRAG_BASE + `
    void main() {
      float scale = abs(cos(u_progress * 3.14159));
      vec2 uv = vec2((v_uv.x - 0.5) / max(scale, 0.01) + 0.5, v_uv.y);
      if (uv.x < 0.0 || uv.x > 1.0) { gl_FragColor = vec4(0.0); return; }
      gl_FragColor = u_progress < 0.5 ? texture2D(u_from, uv) : texture2D(u_to, uv);
    }`,

  flip_v: FRAG_BASE + `
    void main() {
      float scale = abs(cos(u_progress * 3.14159));
      vec2 uv = vec2(v_uv.x, (v_uv.y - 0.5) / max(scale, 0.01) + 0.5);
      if (uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
      gl_FragColor = u_progress < 0.5 ? texture2D(u_from, uv) : texture2D(u_to, uv);
    }`,

  fold: FRAG_BASE + `
    void main() {
      float p = u_progress;
      if (v_uv.x > (1.0 - p)) {
        vec2 uv = vec2(2.0 * (1.0 - p) - v_uv.x, v_uv.y);
        float shade = (v_uv.x - (1.0 - p)) / p * 0.4;
        gl_FragColor = mix(texture2D(u_from, uv), vec4(0.0,0.0,0.0,1.0), shade);
      } else {
        gl_FragColor = mix(texture2D(u_from, v_uv), texture2D(u_to, v_uv), p);
      }
    }`,
}

const FRAG_FALLBACK = FRAG_BASE + `void main() { gl_FragColor = mix(texture2D(u_from, v_uv), texture2D(u_to, v_uv), u_progress); }`

function compileShader(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  return s
}

function makeProgram(gl, fragSrc) {
  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SHADER)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  const prog = gl.createProgram()
  gl.attachShader(prog, vert)
  gl.attachShader(prog, frag)
  gl.linkProgram(prog)
  return prog
}

function uploadTex(gl, img) {
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  return tex
}

export class TransitionEngine {
  constructor(canvas) {
    this.canvas = canvas
    this.gl = canvas.getContext('webgl', { alpha: false, antialias: false })
    this._programs = {}
    this._animId = null
    this._init()
  }

  _init() {
    const gl = this.gl
    if (!gl) return
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)
    this._buf = buf
  }

  _getProgram(transId) {
    if (this._programs[transId]) return this._programs[transId]
    const gl = this.gl
    const fragSrc = SHADERS[transId] || FRAG_FALLBACK
    const prog = makeProgram(gl, fragSrc)
    this._programs[transId] = prog
    return prog
  }

  animate(transId, fromImg, toImg, durationMs = 500, onDone) {
    const gl = this.gl
    if (!gl || transId === 'cut') {
      if (onDone) onDone()
      return
    }
    this.stop()

    const texFrom = uploadTex(gl, fromImg)
    const texTo   = uploadTex(gl, toImg)
    const prog    = this._getProgram(transId)

    gl.useProgram(prog)
    const posLoc  = gl.getAttribLocation(prog, 'a_pos')
    const fromLoc = gl.getUniformLocation(prog, 'u_from')
    const toLoc   = gl.getUniformLocation(prog, 'u_to')
    const progLoc = gl.getUniformLocation(prog, 'u_progress')

    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFrom); gl.uniform1i(fromLoc, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texTo);   gl.uniform1i(toLoc, 1)

    const start = performance.now()
    const draw = (now) => {
      const p = Math.min((now - start) / durationMs, 1.0)
      gl.uniform1f(progLoc, p)
      gl.viewport(0, 0, this.canvas.width, this.canvas.height)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      if (p < 1.0) {
        this._animId = requestAnimationFrame(draw)
      } else {
        gl.deleteTexture(texFrom)
        gl.deleteTexture(texTo)
        if (onDone) onDone()
      }
    }
    this._animId = requestAnimationFrame(draw)
  }

  stop() {
    if (this._animId) { cancelAnimationFrame(this._animId); this._animId = null }
  }

  /** Rendering sincrono di un singolo frame (per timeline preview player). */
  _renderFrame(transId, fromImgOrCanvas, toImgOrCanvas, progress) {
    const gl = this.gl
    if (!gl) return
    if (transId === 'cut') return

    this.stop()
    const texFrom = uploadTex(gl, fromImgOrCanvas)
    const texTo   = uploadTex(gl, toImgOrCanvas)
    const prog    = this._getProgram(transId)

    gl.useProgram(prog)
    const posLoc  = gl.getAttribLocation(prog, 'a_pos')
    const fromLoc = gl.getUniformLocation(prog, 'u_from')
    const toLoc   = gl.getUniformLocation(prog, 'u_to')
    const progLoc = gl.getUniformLocation(prog, 'u_progress')

    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texFrom); gl.uniform1i(fromLoc, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texTo);   gl.uniform1i(toLoc, 1)

    gl.uniform1f(progLoc, Math.max(0, Math.min(1, progress)))
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    gl.deleteTexture(texFrom)
    gl.deleteTexture(texTo)
  }

  destroy() {
    this.stop()
    Object.values(this._programs).forEach(p => this.gl?.deleteProgram(p))
    this._programs = {}
  }
}
