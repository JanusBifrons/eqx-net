/**
 * The cut field's rock surface (plan v2 B3): the owner-approved procedural
 * rock shader from the `exp/terrain-look` look test (`?bigrock=proc`), with
 * the per-rock values moved from uniforms to vertex attributes so one Mesh
 * draws a whole chunk (`CutFieldLayer`). The surface is made per pixel from
 * the offset to the rock's centre: a dome from the outline, fBm, craters and
 * cracks down to ~2 screen pixels, lit by the sector's sun. No texture.
 * `aUV.y` >= 1 marks a far-zoom tile vertex (1 + see-through share): there the
 * surface is drawn as rock-sized cells with streets (`FIELD_FAR_ROCK_CELL`,
 * `fieldStreet`), in world space, so the far level reads as the rocks it
 * stands for at the switch; the cells fade out below ~4 px.
 *
 * Field rocks never turn, so the sun needs no per-rock frame. Per frame only
 * `setFieldRockView` runs, a compare unless the zoom or the sun moved.
 */
import { GlProgram, UniformGroup } from 'pixi.js';
import { lin } from '../art/fields';
import { ROCK_COLORS } from '../art/rockForge';
import { DEFAULT_RIG } from '../art/shade';
import { cutFieldOpts } from '../../../core/terrain/chunkStreamer';
import { FIELD_FAR_ROCK_CELL, fieldStreet, SLICED } from '../../../core/terrain/fieldLayout';

/** Far-zoom cells (B4): cell side, half street at the core, street growth
 *  toward the rim, field radius (all world u), as GLSL literals. */
const FIELD_F = cutFieldOpts('').fighterLength;
const glf = (x: number): string => x.toFixed(3);

const VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
in vec2 aLocal;
in vec4 aRock;
in vec2 aOre;
out vec2 vOre;
out vec2 vLocal;
out float vT;
out float vThin;
out vec4 vRock;
out vec2 vSunDir;
out vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uSunLook;
void main() {
  mat3 model = uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((uProjectionMatrix * model * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  // The sun into the mesh's own axes, so a woken (spinning) rock keeps its
  // light where the sun is; a chunk mesh is unrotated, so this is identity.
  vec2 sunW = vec2(cos(uSunLook.z), sin(uSunLook.z));
  vec2 ax = normalize(model[0].xy), ay = normalize(model[1].xy);
  vSunDir = vec2(dot(sunW, ax), dot(sunW, ay));
  vLocal = aLocal;
  vT = aUV.x;
  vThin = aUV.y;
  vRock = aRock;
  vOre = aOre;
  vColor = uColor * uWorldColorAlpha;
}`;

const FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vLocal;
in float vT;
in float vThin;
in vec4 vRock;
in vec2 vOre;
in vec2 vSunDir;
in vec4 vColor;
out vec4 finalColor;
uniform vec3 uAlbedo;
// Ore look (F1c): x = style (0 off, 1 tint, 2 veins, 3 seams); ice, crystal albedo.
uniform vec4 uOreStyle;
uniform vec3 uIceAlbedo;
uniform vec3 uCrystalAlbedo;
// x: sun elevation (rad), y: exposure, z: sun azimuth (Pixi world).
uniform vec4 uSunLook;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
#define FAR_CELL ${glf(FIELD_FAR_ROCK_CELL)}
#define FAR_HALF_STREET ${glf(fieldStreet(0, FIELD_F) / 2)}
#define FAR_STREET_EDGE ${glf(SLICED.streetEdgeMul - 1)}
#define FIELD_R ${glf(SLICED.radius)}

float linToSrgb(float c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float tone(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

// Float-only hash (no uint: the game's GL path can't compile integer ops).
float h01(vec2 p, float s) {
  vec3 p3 = fract(vec3(p.xyx + s * 0.1031) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Value noise: x the value (0..1), yz its gradient (per lattice unit).
vec3 noised(vec2 x, float s) {
  vec2 fl = floor(x);
  vec2 i = fl;
  vec2 f = x - fl;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = h01(i, s), b = h01(i + vec2(1.0, 0.0), s), c = h01(i + vec2(0.0, 1.0), s), d = h01(i + vec2(1.0, 1.0), s);
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * (vec2(b - a, c - a) + k * u.yx));
}

void main() {
  vec2 p = vLocal;
  float R = vRock.x;
  // World units per screen pixel: detail finer than ~2 px is left out (no shimmer).
  // (uSunLook.w: world units per screen pixel, set per frame from the camera;
  // the game's GL path has no fwidth.)
  float px = max(1e-4, uSunLook.w);
  float seed = vRock.w;

  // The dome: in a fan from the centre, vT runs 1 (centre) to 0 (outline)
  // linearly along each ray, so the outline's distance on this ray is known.
  float e = 1.0 - clamp(vT, 0.0, 0.999);
  float rl = length(p);
  vec2 dir = rl > 1e-3 ? p / rl : vec2(0.0);
  vec2 G = -dir * (0.8 * e / sqrt(max(0.03, 1.0 - e * e)));

  // Far-zoom tiles (aUV.y = 1 + thin): each coarse piece is cut on down to
  // rock size here, as the field cuts it (macro-terrain.md "Far zoom"): a few
  // straight seeded cuts, each roughly across the one before, the pixel's
  // side picking the next region. Each sub-piece is inset by half the field's
  // street and shaded as a faceted roof (slope away from its nearest edge),
  // so the coarse pieces read as the rocks they stand for at the switch.
  // Full at >= 8 px a rock, gone at 4 px (the plain pieces).
  bool coarse = vThin >= 0.5;
  float thin = coarse ? vThin - 1.0 : 0.0;
  float street = 1.0;
  float cellFade = coarse ? clamp(FAR_CELL / px / 4.0 - 1.0, 0.0, 1.0) : 0.0;
  if (cellFade > 0.0) {
    // The piece's own outline: distance along this ray (vT linear on it).
    float dmin = rl * clamp(vT, 0.0, 1.0) / max(1e-3, 1.0 - clamp(vT, 0.0, 0.999));
    vec2 nmin = -dir;
    vec2 c = vec2(0.0);
    float r = R * 0.7;
    float path = fract(seed * 0.000123 + 0.31) * 977.0;
    float ang = 6.2832 * h01(vec2(path, 3.0), 13.0);
    for (int k = 0; k < 6; k++) {
      if (r < FAR_CELL * 0.7) break;
      vec2 n = vec2(cos(ang), sin(ang));
      vec2 pc = c + n * (h01(vec2(path, float(k)), 17.0) - 0.5) * 0.6 * r;
      float sd = dot(p - pc, n);
      float side = sd >= 0.0 ? 1.0 : -1.0;
      if (abs(sd) < dmin) { dmin = abs(sd); nmin = n * side; }
      c += n * side * r * 0.5;
      r *= 0.7;
      path = fract(path * 0.6180 + side * 0.3819 + 0.1) * 977.0;
      ang += 1.5708 + (h01(vec2(path, 5.0), 19.0) - 0.5) * 0.7;
    }
    float fd = length(p + vRock.yz) / FIELD_R;
    float halfStreet = FAR_HALF_STREET * (1.0 + FAR_STREET_EDGE * fd * fd);
    street = mix(1.0, smoothstep(halfStreet - 0.5 * px, halfStreet + 0.5 * px, dmin), cellFade);
    G = mix(G, nmin * 0.6, cellFade);
    R = mix(R, 0.5 * FAR_CELL, cellFade);
    if (cellFade > 0.5) seed = floor(fract(path * 0.0137) * 65536.0);
  }

  // fBm: each octave adds about the same slope (scale-free rock).
  vec2 q = p + vRock.yz;
  float lam = min(R * 0.5, 5000.0);
  float amp = 0.30;
  float alb = 0.0;
  for (int k = 0; k < 18; k++) {
    float fade = clamp(lam / px * 0.5 - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    vec3 n = noised(q / lam, seed + float(k) * 7.919);
    G += n.yz * amp * fade;
    if (k > 1) alb += (n.x - 0.5) * 0.10 * fade;
    lam *= 0.497;
    amp *= 0.84;
  }

  // Craters, one possible per cell at each scale (each fits inside its cell).
  float ao = 1.0;
  float cs = min(R * 0.45, 4000.0);
  for (int k = 0; k < 10; k++) {
    float fade = clamp(cs / px / 8.0 - 1.0, 0.0, 1.0);
    if (fade <= 0.0) break;
    vec2 cell = floor(q / cs);
    vec2 ci = cell;
    float cseed = seed + 31.0 + float(k) * 10.4729;
    if (h01(ci, cseed) < 0.6) {
      vec2 c = (cell + 0.3 + 0.4 * vec2(h01(ci, cseed + 1.0), h01(ci, cseed + 2.0))) * cs;
      float r = cs * (0.07 + 0.13 * h01(ci, cseed + 3.0));
      vec2 dv = q - c;
      float dist = length(dv);
      float d = dist / r;
      if (d < 1.45 && dist > 1e-3) {
        float dhdd = d < 1.0 ? 2.0 * 0.5 * d : -2.0 * 0.16 * (1.0 - (d - 1.0) / 0.45) / 0.45;
        G += dhdd * dv / dist * fade;
        if (d < 1.0) { ao *= mix(1.0, 0.75 + 0.25 * d, fade); alb -= 0.05 * (1.0 - d) * fade; }
        else alb += 0.06 * (1.0 - (d - 1.0) / 0.45) * fade;
      }
    }
    cs *= 0.43;
  }

  // Cracks: thin valleys of ridged noise, anti-aliased by the footprint.
  float crack = 0.0;
  float cl = min(R * 0.3, 2400.0);
  for (int k = 0; k < 4; k++) {
    float fw = px / cl;
    if (fw > 0.02) break;
    vec3 n = noised(q / cl + 17.0, seed + 555.0 + float(k) * 1.3);
    float ridge = abs(n.x * 2.0 - 1.0);
    float aa = max(fw * length(n.yz) * 2.0, 1e-4);
    crack = max(crack, (1.0 - smoothstep(0.012, 0.012 + aa + 0.02, ridge)) * clamp(1.0 - fw / 0.02, 0.0, 1.0));
    cl *= 0.37;
  }

  vec3 N = normalize(vec3(-G, 1.0));
  float ce = cos(uSunLook.x);
  vec3 L = vec3(vSunDir * ce, sin(uSunLook.x));
  float nd = max(0.0, dot(N, L));
  vec3 base = uAlbedo;
  float style = uOreStyle.x;
  float gloss = 0.0;
  if (style > 0.5) {
    // The ore map, read where this pixel is: a pocket's edge runs across a rock.
    float ice = clamp(vOre.x, 0.0, 1.0), cry = clamp(vOre.y, 0.0, 1.0);
    if (style < 1.5) {
      // Tint: the rock takes the ore's colour as its share grows.
      base = mix(base, uIceAlbedo, smoothstep(0.0, 0.8, ice));
      base = mix(base, uCrystalAlbedo, smoothstep(0.0, 0.8, cry));
    } else {
      // Patches of ore in the rock, more of the surface as concentration grows:
      // ice as smooth pale sheets, crystal as bright veins along the cracks.
      float fine = clamp(R * 0.08, 6.0, 900.0);
      float fade = clamp(fine / px * 0.5 - 1.0, 0.0, 1.0);
      float m = noised(q / fine + 3.0, seed + 91.0).x * fade + 0.5 * (1.0 - fade);
      float iceM = smoothstep(1.0 - ice, 1.05 - ice * 0.6, m);
      float cryM = smoothstep(1.0 - cry, 1.05 - cry * 0.6, 1.0 - m);
      base = mix(mix(base, uIceAlbedo, 0.35 * ice), uIceAlbedo * 1.25, iceM);
      base = mix(mix(base, uCrystalAlbedo, 0.3 * cry), uCrystalAlbedo * 1.4, cryM);
      gloss = iceM * 0.4 + cryM * 0.25;
      alb *= 1.0 - 0.6 * iceM;
      if (style > 2.5) {
        // Seams: the cracks run with ore instead of shadow.
        float seam = crack * max(ice, cry);
        base = mix(base, (ice > cry ? uIceAlbedo * 1.3 : uCrystalAlbedo * 1.6), seam);
        crack *= 1.0 - max(ice, cry);
      }
    }
  }
  vec3 albedo = base * clamp(1.0 + alb, 0.4, 1.6) * (1.0 - 0.65 * crack);
  // No sky rim light: on the dome's edge it read as a glow (owner 2026-11-15).
  vec3 c = albedo * (uSunColor * nd + uAmbient * 4.0 * ao);
  // A wet sheen on ore patches: a little specular toward the sun.
  if (gloss > 0.0) c += uSunColor * gloss * pow(max(0.0, dot(reflect(-L, N), vec3(0.0, 0.0, 1.0))), 24.0);
  c *= uSunLook.y;
  vec3 rgb = vec3(linToSrgb(tone(c.r)), linToSrgb(tone(c.g)), linToSrgb(tone(c.b)));
  // Far-zoom tiles thin toward the field's rim (thin = coarseFieldThin): see-through in rock-sized patches. smoothstep(0.15, 0.85, n)
  // makes this noise about uniform (measured, within ~1.3 %), so the share
  // drawn is about 1 - vThin. Patches under ~2 px fall back to plain alpha.
  float cover = street;
  if (thin > 0.0) {
    float n = 0.65 * noised(q / 1200.0 + 41.0, seed + 41.0).x + 0.35 * noised(q / 520.0 + 7.0, seed + 43.0).x;
    float u = smoothstep(0.15, 0.85, n);
    float w = clamp(min(thin, 1.0 - thin), 1e-3, 0.08);
    float f = clamp(520.0 / px * 0.5 - 0.5, 0.0, 1.0);
    cover *= mix(1.0 - thin, smoothstep(thin - w, thin + w, u), f);
  }
  if (cover <= 0.0) discard;
  finalColor = vec4(rgb, 1.0) * vColor * cover;
}`;

let program: GlProgram | null = null;
let view: UniformGroup | null = null;
let rockLook: UniformGroup | null = null;
let sunAzSet = NaN;

/** Ore look styles (`?ore=`, F1c); veins is the default (owner 2026-11-15). */
export const FIELD_ORE_STYLES = ['off', 'tint', 'veins', 'seams'] as const;
export type FieldOreStyle = (typeof FIELD_ORE_STYLES)[number];
let oreStyle = 2; // veins: the owner's pick (2026-11-15)

/** Pick the ore look; applies to every field rock at once. */
export function setFieldOreStyle(style: FieldOreStyle): void {
  oreStyle = FIELD_ORE_STYLES.indexOf(style);
  if (!rockLook) return;
  (rockLook.uniforms as unknown as { uOreStyle: Float32Array }).uOreStyle[0] = oreStyle;
  rockLook.update();
}

export function fieldRockProgram(): GlProgram {
  program ??= GlProgram.from({ vertex: VERTEX, fragment: FRAGMENT, name: 'field-rock-proc' });
  return program;
}

/** The shared uniforms: the sun and zoom (`fieldRockView`), the rock colour. */
export function fieldRockShaderResources(): Record<string, UniformGroup> {
  if (!view) {
    const r = DEFAULT_RIG;
    view = new UniformGroup({
      uSunLook: { value: new Float32Array([r.sunElev, r.exposure, r.sunAz, 3]), type: 'vec4<f32>' },
      uSunColor: { value: new Float32Array(r.sunColor), type: 'vec3<f32>' },
      uAmbient: { value: new Float32Array(r.ambient), type: 'vec3<f32>' },
    });
    sunAzSet = r.sunAz;
    rockLook = new UniformGroup({
      uAlbedo: { value: new Float32Array(lin(ROCK_COLORS['rock']!)), type: 'vec3<f32>' },
      uOreStyle: { value: new Float32Array([oreStyle, 0, 0, 0]), type: 'vec4<f32>' },
      uIceAlbedo: { value: new Float32Array(lin(ROCK_COLORS['ice']!)), type: 'vec3<f32>' },
      uCrystalAlbedo: { value: new Float32Array(lin(ROCK_COLORS['crystal']!)), type: 'vec3<f32>' },
    });
  }
  return { fieldRockView: view, fieldRockLook: rockLook! };
}

/** Per frame: the sector's sun (Pixi azimuth) and the camera's world scale. */
export function setFieldRockView(sunAz: number, cameraScale: number): void {
  if (view === null || !(cameraScale > 0)) return;
  const look = (view.uniforms as unknown as { uSunLook: Float32Array }).uSunLook;
  const px = 1 / cameraScale;
  if (sunAz === sunAzSet && px === look[3]) return;
  sunAzSet = sunAz;
  look[2] = sunAz;
  look[3] = px;
  view.update();
}
