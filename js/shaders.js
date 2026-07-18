// WebGL2 shader sources. One fragment pass does crop -> grade -> key(alpha) -> toon(quantize + Sobel edge).
export const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5)); // flip Y for video
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform sampler2D u_mask;   // ML foreground mask (r channel), full-source aligned
uniform int   u_useMask;
uniform vec2  u_texel;      // 1 / source resolution
uniform vec4  u_crop;       // x, y, w, h  (normalized region of source)

uniform int   u_keyMode;    // 0 none | 1 chroma | 2 dark | 3 light
uniform vec3  u_keyColor;
uniform float u_keyThresh;
uniform float u_keySoft;
uniform float u_spill;

uniform int   u_toon;
uniform float u_levels;
uniform float u_edgeThresh;
uniform float u_edgeThick;
uniform float u_edgeGain;
uniform vec3  u_edgeColor;
uniform vec3  u_tint;        // per-layer multiplicative recolor (1,1,1 = off)
uniform int   u_outline;     // colored outline around the segmented silhouette
uniform vec3  u_outlineColor;
uniform float u_outlineThick;
uniform float u_sat;
uniform float u_bright;
uniform float u_contrast;

vec2 srcUV(vec2 uv) { return u_crop.xy + uv * u_crop.zw; }
vec3 samp(vec2 uv)  { return texture(u_tex, uv).rgb; }
float luma(vec3 c)  { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 grade(vec3 c) {
  c = (c - 0.5) * u_contrast + 0.5 + u_bright;
  float l = luma(c);
  c = mix(vec3(l), c, u_sat);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec2 base = srcUV(v_uv);
  vec3 raw = samp(base);
  vec3 col = grade(raw);

  // ---- alpha (background removal) uses the ungraded raw color ----
  float alpha = 1.0;
  if (u_keyMode == 1) {
    float d = distance(raw, u_keyColor);
    alpha = smoothstep(u_keyThresh, u_keyThresh + u_keySoft, d);
    if (u_spill > 0.0) {
      // pull graded color away from the key hue in kept-but-tinted pixels
      float t = clamp(u_spill * (1.0 - alpha) + u_spill * 0.35, 0.0, 1.0);
      col = mix(col, vec3(luma(col)), t);
    }
  } else if (u_keyMode == 2) {
    float l = luma(raw);
    alpha = smoothstep(u_keyThresh, u_keyThresh + u_keySoft, l);
  } else if (u_keyMode == 3) {
    float l = luma(raw);
    alpha = smoothstep(u_keyThresh, u_keyThresh + u_keySoft, 1.0 - l);
  }

  // ---- ML segmentation runs "first": everything outside the foreground mask is removed ----
  if (u_useMask == 1) {
    alpha *= texture(u_mask, base).r;
  }

  vec3 outCol = col;
  if (u_toon == 1) {
    float L = max(u_levels - 1.0, 1.0);
    outCol = floor(col * L + 0.5) / L;
    outCol *= u_tint;

    // Sobel edge on graded luma, offsets in source-pixel space
    vec2 t = u_texel * u_edgeThick;
    float l00 = luma(grade(samp(base + vec2(-t.x, -t.y))));
    float l10 = luma(grade(samp(base + vec2( 0.0, -t.y))));
    float l20 = luma(grade(samp(base + vec2( t.x, -t.y))));
    float l01 = luma(grade(samp(base + vec2(-t.x,  0.0))));
    float l21 = luma(grade(samp(base + vec2( t.x,  0.0))));
    float l02 = luma(grade(samp(base + vec2(-t.x,  t.y))));
    float l12 = luma(grade(samp(base + vec2( 0.0,  t.y))));
    float l22 = luma(grade(samp(base + vec2( t.x,  t.y))));
    float gx = (l20 + 2.0*l21 + l22) - (l00 + 2.0*l01 + l02);
    float gy = (l02 + 2.0*l12 + l22) - (l00 + 2.0*l10 + l20);
    float g = length(vec2(gx, gy)) * u_edgeGain;
    // tight band -> crisp, near-solid ink line (Just Dance style)
    float edge = smoothstep(u_edgeThresh, u_edgeThresh + 0.05, g) * alpha;
    outCol = mix(outCol, u_edgeColor, edge);
  }

  // thick colored outline around the segmented object's silhouette (mask boundary)
  if (u_outline == 1 && u_useMask == 1) {
    float inside = texture(u_mask, base).r;
    if (inside < 0.5) {
      float mx = 0.0;
      vec2 rt = u_texel * u_outlineThick;
      for (int k = 0; k < 16; k++) {
        float a = float(k) / 16.0 * 6.2831853;
        mx = max(mx, texture(u_mask, base + vec2(cos(a), sin(a)) * rt).r);
      }
      if (mx > 0.5) { outCol = u_outlineColor; alpha = 1.0; }
    }
  }

  fragColor = vec4(outCol, alpha);
}`;
