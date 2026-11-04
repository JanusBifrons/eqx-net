/**
 * Shield impact — the shader variant (plan iridescent-seeking-rainbow v2, W6b).
 *
 * One quad per shield. The fragment shader draws the same look as the baked
 * flipbook (fxTextures.shieldHitFlipbook) but live: up to four hits at once,
 * each a lit spot plus a ripple of hex cells, and a whole-dome flash when
 * the shield breaks. Costs one draw call per visible shield (no batching);
 * idle shields are hidden. GLSL ES 3 (Pixi v8 WebGL2 path).
 *
 * Uniform layout per hit: (cos angle, sin angle, age s, power).
 */

export const SHIELD_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;

export const SHIELD_FRAGMENT = /* glsl */ `
precision mediump float;
in vec2 vUV;
out vec4 finalColor;
uniform vec4 uHit0;
uniform vec4 uHit1;
uniform vec4 uHit2;
uniform vec4 uHit3;
uniform vec3 uTint;
uniform float uBreak;
uniform float uLife;
uniform float uCells;

float hexEdge(vec2 p) {
  vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5;
  vec2 b = mod(p - s * 0.5, s) - s * 0.5;
  vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);
  return 0.5 - max(dot(g, vec2(0.5, 0.8660254)), g.x);
}

float hit(vec4 h, vec2 p, float z, float lines, float fill) {
  float t = h.z / uLife;
  if (t < 0.0 || t >= 1.0) return 0.0;
  vec2 hp = vec2(h.x, h.y) * 0.94;
  float d = length(p - hp) * (0.8 + 0.2 * z);
  float front = 0.05 + t * 0.6;
  float width = 0.1 + t * 0.12;
  float ring = exp(-pow((d - front) / width, 2.0)) * pow(1.0 - t, 1.6) * exp(-d * 2.5);
  float spot = exp(-d * d * 30.0) * pow(1.0 - t, 2.5) * 2.2;
  float r = length(p) / 0.94;
  float ang = acos(clamp(dot(normalize(p + 1e-5), vec2(h.x, h.y)), -1.0, 1.0));
  float rimArc = exp(-pow((1.0 - r) * 16.0, 2.0)) * exp(-pow(ang / 0.9, 2.0)) * pow(1.0 - t, 1.8);
  return ((lines + fill) * (ring + spot) * (0.45 + 0.55 * pow(1.0 - z, 1.6)) + spot * 0.35 + rimArc * 0.9) * h.w;
}

void main() {
  vec2 p = vUV;
  float r = length(p) / 0.94;
  if (r >= 1.0) discard;
  float z = sqrt(1.0 - r * r);
  vec2 l = p / (0.55 + 0.45 * z);
  float e = hexEdge(l * uCells);
  float lines = exp(-e * e * 700.0);
  float fill = exp(-e * e * 25.0) * 0.25;
  float a = hit(uHit0, p, z, lines, fill) + hit(uHit1, p, z, lines, fill)
          + hit(uHit2, p, z, lines, fill) + hit(uHit3, p, z, lines, fill);
  // Shield break: the whole dome flares, then the hex lines shatter outward.
  if (uBreak >= 0.0 && uBreak < 0.7) {
    float k = uBreak / 0.7;
    float fres = pow(1.0 - z, 2.0);
    float shatter = exp(-pow((r - k * 1.1) / 0.12, 2.0));
    a += (lines * (0.6 + fres) + fres * 0.5) * pow(1.0 - k, 2.0) * 1.6 + shatter * lines * 1.5 * (1.0 - k);
  }
  a = clamp(a, 0.0, 1.0) * smoothstep(1.0, 0.985, r);
  finalColor = vec4(uTint * a, a);
}`;

/** Quad corners (−1..1) and matching UVs, for a shield mesh of radius 1. */
export const SHIELD_QUAD_POS = [-1, -1, 1, -1, 1, 1, -1, 1];
export const SHIELD_QUAD_UV = [-1, -1, 1, -1, 1, 1, -1, 1];
export const SHIELD_QUAD_INDEX = [0, 1, 2, 0, 2, 3];
