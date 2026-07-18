// WebGL2 renderer: uploads the current video frame and draws it through the shader pipeline.
import { VERT, FRAG } from './shaders.js';

export class Pipeline {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
    if (!gl) throw new Error('WebGL2 not supported in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.prog = this._program(VERT, FRAG);
    this.loc = {};
    for (const n of ['u_tex','u_mask','u_useMask','u_texel','u_crop','u_keyMode','u_keyColor',
      'u_keyThresh','u_keySoft','u_spill','u_toon','u_levels','u_edgeThresh','u_edgeThick',
      'u_edgeGain','u_edgeColor','u_tint','u_outline','u_outlineColor','u_outlineThick',
      'u_sat','u_bright','u_contrast'])
      this.loc[n] = gl.getUniformLocation(this.prog, n);

    // fullscreen triangle
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.tex = this._makeTex();
    this.maskTex = this._makeTex();
    this.useMask = false;
    // 1x1 white fallback so sampling the mask is a no-op until one is set
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
  }

  _makeTex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  // Upload an ML mask (canvas/ImageData/Image). Its r channel becomes the keep-alpha.
  setMask(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.useMask = true;
  }
  clearMask() { this.useMask = false; }

  _program(vs, fs) {
    const gl = this.gl;
    const c = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error('Shader compile: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, c(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, c(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Link: ' + gl.getProgramInfoLog(p));
    gl.useProgram(p);
    return p;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  // Draw one frame. `src` is the video element (or any texImage2D-able source).
  // clear=false composites this draw over what's already there (for stacking layers).
  render(src, s, clear = true) {
    const gl = this.gl;
    this.resize(s.outputW, s.outputH);
    gl.viewport(0, 0, s.outputW, s.outputH);
    gl.useProgram(this.prog);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (src && (src.videoWidth || src.width)) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    gl.uniform1i(this.loc.u_tex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.loc.u_mask, 1);
    gl.uniform1i(this.loc.u_useMask, this.useMask ? 1 : 0);
    const w = src && src.videoWidth ? src.videoWidth : (s.videoW || 1);
    const h = src && src.videoHeight ? src.videoHeight : (s.videoH || 1);

    gl.uniform2f(this.loc.u_texel, 1 / w, 1 / h);
    gl.uniform4f(this.loc.u_crop, s.crop.x, s.crop.y, s.crop.w, s.crop.h);
    gl.uniform1i(this.loc.u_keyMode, s.keyMode);
    gl.uniform3fv(this.loc.u_keyColor, s.keyColor);
    gl.uniform1f(this.loc.u_keyThresh, s.keyThresh);
    gl.uniform1f(this.loc.u_keySoft, s.keySoft);
    gl.uniform1f(this.loc.u_spill, s.spill);
    gl.uniform1i(this.loc.u_toon, s.toon ? 1 : 0);
    gl.uniform1f(this.loc.u_levels, s.levels);
    gl.uniform1f(this.loc.u_edgeThresh, s.edgeThresh);
    gl.uniform1f(this.loc.u_edgeThick, s.edgeThick);
    gl.uniform1f(this.loc.u_edgeGain, s.edgeGain);
    gl.uniform3fv(this.loc.u_edgeColor, s.edgeColor);
    gl.uniform3fv(this.loc.u_tint, s.tint || [1, 1, 1]);
    gl.uniform1i(this.loc.u_outline, s.outline ? 1 : 0);
    gl.uniform3fv(this.loc.u_outlineColor, s.outlineColor || [1, 1, 1]);
    gl.uniform1f(this.loc.u_outlineThick, s.outlineThick || 3);
    gl.uniform1f(this.loc.u_sat, s.sat);
    gl.uniform1f(this.loc.u_bright, s.bright);
    gl.uniform1f(this.loc.u_contrast, s.contrast);

    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  clearCanvas() {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Read the current canvas as a PNG blob (straight alpha, Unity-friendly).
  toBlob() {
    return new Promise(res => this.canvas.toBlob(res, 'image/png'));
  }

  // Sample the source color at normalized output-uv (for the eyedropper).
  sampleColorAt(u, v, s) {
    const cx = s.crop.x + u * s.crop.w;
    const cy = s.crop.y + v * s.crop.h;
    const cv = document.createElement('canvas');
    cv.width = s.videoW; cv.height = s.videoH;
    const ctx = cv.getContext('2d');
    ctx.drawImage(s.video, 0, 0, s.videoW, s.videoH);
    const px = ctx.getImageData(Math.floor(cx * s.videoW), Math.floor(cy * s.videoH), 1, 1).data;
    return [px[0] / 255, px[1] / 255, px[2] / 255];
  }
}
