/**
 * GPU-lit ship art (R&D): the light pass of `shade.ts` run per pixel on the
 * GPU from the three-slice maps (`litMaps.ts`). The fragment shader mirrors
 * `shadeLitTexel` + `litShadow` line for line (keep them in step: the parity
 * test checks the TypeScript twin against the baked frames).
 *
 * One mesh per ship (R1). The maps are a shader resource; the mesh's own
 * texture stays white, so Pixi keeps the normal premultiplied blend. The
 * inherited colour (damage flash, fades) arrives as Pixi's `uColor` and
 * `uWorldColorAlpha` and multiplies the result. GLSL ES 3 (WebGL2).
 */
import { BufferImageSource, Geometry, GlProgram, Mesh, Shader, Texture, UniformGroup } from 'pixi.js';
import { matTables, type LightRig } from './shade.js';
import { LIT_GUTTER, sliceX, type LitMaps } from './litMaps.js';

export const LIT_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
out vec4 vColor;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vColor = uColor * uWorldColorAlpha;
}`;

/** The material table (shade.ts MATP) as GLSL constants: the shader runs as
 *  GLSL ES 1 under Pixi, which can't index a uniform array by a variable. */
function matFunctions(): string {
  const { gloss, spec } = matTables();
  const chain = (name: string, t: Float32Array): string => {
    let body = '';
    for (let k = 0; k < t.length; k++) body += `  if (m == ${k}) return ${t[k]!.toFixed(4)};\n`;
    return `float ${name}(int m) {\n${body}  return ${t[1]!.toFixed(4)};\n}`;
  };
  return chain('matGloss', gloss) + '\n' + chain('matSpec', spec);
}

/** Most shadow steps a ship may ask for (the loop bound must be constant). */
export const LIT_MAX_SHADOW_STEPS = 128;

export const LIT_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 vUV;
in vec4 vColor;
out vec4 finalColor;
uniform sampler2D uMaps;
// x: slice B offset (uv), y: slice C offset (uv), zw: one texel (uv).
uniform vec4 uSlices;
// Sun direction in the ship's frame (xyz) and the half vector toward the camera.
uniform vec3 uL;
uniform vec3 uH;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uRim;
// x: exposure, y: max height, z: max emission, w: texels per world unit.
uniform vec4 uScale;
// x: shadow steps (0 = none), y: march step (texels), z: rise per step (world u).
uniform vec3 uShadow;
// x: how dark a full shadow is (0..1; the bake uses 0.85), y: edge softness
// (world u of occluder height to reach full shadow; the bake uses 0.6).
uniform vec2 uShadowLook;

float srgbToLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float linToSrgb(float c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float tone(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
${matFunctions()}

void main() {
  vec4 A = texture(uMaps, vUV);
  float cov = A.a;
  if (cov <= 0.0) discard;
  vec4 B = texture(uMaps, vUV + vec2(uSlices.x, 0.0));
  vec4 C = texture(uMaps, vUV + vec2(uSlices.y, 0.0));
  vec3 alb = vec3(srgbToLin(A.r), srgbToLin(A.g), srgbToLin(A.b));
  vec2 nxy = B.rg * 2.0 - 1.0;
  vec3 n = vec3(nxy, sqrt(max(0.0, 1.0 - dot(nxy, nxy))));
  float height = B.b * uScale.y;
  float cav = B.a;
  vec3 emis = C.rgb * C.rgb * uScale.z;
  int mat = int(floor(C.a * 255.0 / 16.0 + 0.5));

  // Shadow: march the height toward the sun (shade.ts shadowMap).
  float shadow = 1.0;
  if (uShadow.x > 0.0) {
    vec2 dir = normalize(uL.xy) * uShadow.y * uSlices.zw;
    float h0 = height + 0.05;
    float occl = 0.0;
    for (int s = 1; s < ${LIT_MAX_SHADOW_STEPS}; s++) {
      if (float(s) >= uShadow.x) break;
      float ray = h0 + uShadow.z * float(s);
      if (ray > uScale.y) break;
      vec2 p = vUV + dir * float(s);
      // Slice A ends LIT_GUTTER texels before slice B starts.
      if (p.x < 0.0 || p.y < 0.0 || p.x >= uSlices.x - ${LIT_GUTTER}.0 * uSlices.z || p.y >= 1.0) break;
      float d = texture(uMaps, p + vec2(uSlices.x, 0.0)).b * uScale.y - ray;
      if (d > 0.0) { occl = max(occl, min(1.0, d / uShadowLook.y)); if (occl >= 1.0) break; }
    }
    shadow = 1.0 - occl * uShadowLook.x;
  }

  float ndl = max(0.0, dot(n, uL));
  float ndh = max(0.0, dot(n, uH));
  float ao = 1.0 - 0.65 * cav;
  float sk = matSpec(mat);
  float spec = (sk > 0.0 && ndh > 0.0) ? sk * pow(ndh, matGloss(mat)) * shadow : 0.0;
  float nzi = 1.0 - n.z;
  float rim = nzi * nzi * 1.6 * ao;
  float hemi = (0.55 + 0.45 * n.z) * ao;
  float sunT = ndl * shadow * (0.35 + 0.65 * ao);
  vec3 rad = alb * (uAmbient * hemi + uSunColor * sunT) + uSunColor * spec * 0.6 + uRim * rim * (0.35 + alb) + emis;
  vec3 c = rad * uScale.x;
  vec3 rgb = vec3(linToSrgb(tone(c.r)), linToSrgb(tone(c.g)), linToSrgb(tone(c.b)));
  finalColor = vec4(rgb * cov, cov) * vColor;
}`;

let program: GlProgram | null = null;
function litProgram(): GlProgram {
  return (program ??= GlProgram.from({ vertex: LIT_VERTEX, fragment: LIT_FRAGMENT, name: 'lit-ship' }));
}

/** The maps as a texture: uploaded as-is (no premultiplication: every channel is data). */
export function litMapsTexture(m: LitMaps): Texture {
  const source = new BufferImageSource({
    resource: new Uint8Array(m.frame.data.buffer, m.frame.data.byteOffset, m.frame.data.byteLength),
    width: m.frame.w, height: m.frame.h, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear',
  });
  return new Texture({ source });
}


/**
 * One GPU-lit ship: a quad the size of the hull (world units, centred), lit
 * by the shader. `setLight` once per frame with the sun and the ship's world
 * rotation.
 */
export class LitShipMesh extends Mesh<Geometry, Shader> {
  private readonly uni: UniformGroup;
  private readonly u: Record<string, Float32Array>;

  constructor(readonly maps: LitMaps, tex: Texture, geometry?: Geometry) {
    const W = maps.frame.w;
    const uni = new UniformGroup({
      uSlices: { value: new Float32Array([sliceX(maps.w, 1) / W, sliceX(maps.w, 2) / W, 1 / W, 1 / maps.h]), type: 'vec4<f32>' },
      uL: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
      uH: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
      uSunColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uAmbient: { value: new Float32Array(3), type: 'vec3<f32>' },
      uRim: { value: new Float32Array(3), type: 'vec3<f32>' },
      uScale: { value: new Float32Array([1, maps.maxH, maps.emisMax, maps.ppu]), type: 'vec4<f32>' },
      uShadow: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
      uShadowLook: { value: new Float32Array([0.85, 0.6]), type: 'vec2<f32>' },
    });
    const shader = new Shader({ glProgram: litProgram(), resources: { litUniforms: uni, uMaps: tex.source, uMapsSampler: tex.source.style } });
    super({ geometry: geometry ?? litShipGeometry(maps), shader });
    this.uni = uni;
    this.u = uni.uniforms as Record<string, Float32Array>;
  }

  /** Light for this frame: the sector's sun and the ship's world rotation.
   *  `shadowSteps` 0 = no cast shadows. */
  setLight(rig: LightRig, worldRotation: number, shadowSteps: number, look: ShadowLook = BAKED_SHADOW): void {
    const sl = this.u['uShadowLook']!;
    sl[0] = look.strength; sl[1] = look.edge;
    const localAz = rig.sunAz - worldRotation;
    const ce = Math.cos(rig.sunElev);
    const L = this.u['uL']!, H = this.u['uH']!;
    L[0] = Math.cos(localAz) * ce; L[1] = Math.sin(localAz) * ce; L[2] = Math.sin(rig.sunElev);
    const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
    H[0] = hx / hl; H[1] = hy / hl; H[2] = hz / hl;
    const sc = this.u['uSunColor']!, am = this.u['uAmbient']!, rm = this.u['uRim']!;
    for (let k = 0; k < 3; k++) { sc[k] = rig.sunColor[k]!; am[k] = rig.ambient[k]!; rm[k] = rig.rim[k]!; }
    this.u['uScale']![0] = rig.exposure;
    // Same march as shade.ts: ~0.75 world units a step, clipped at 40 u.
    // A longer shadow: the ray rises more slowly, so it walks more steps of
    // the same size (no staircase banding), and the 40 u clip grows with it.
    const len = Math.max(0.25, look.length ?? 1);
    const stepT = Math.max(1, this.maps.ppu * 0.75);
    const rise = (Math.tan(rig.sunElev) / this.maps.ppu) * stepT / len;
    const maxSteps = Math.min(shadowSteps, LIT_MAX_SHADOW_STEPS, Math.ceil((40 * len) / 0.75), Math.ceil(this.maps.maxH / Math.max(1e-4, rise)) + 2);
    const sh = this.u['uShadow']!;
    sh[0] = shadowSteps > 0 ? maxSteps : 0; sh[1] = stepT; sh[2] = rise;
    this.uni.update();
  }
}

/** How harsh cast shadows are. */
export interface ShadowLook {
  /** How dark a full shadow is, 0..1 (the bake: 0.85). */
  strength: number;
  /** Occluder height (world u) that reaches full shadow: lower = sharper edge (the bake: 0.6). */
  edge: number;
  /** Shadow length × (the bake: 1). Lengthens shadows without lowering the sun. */
  length?: number;
}
/** The look the baked frames use. */
export const BAKED_SHADOW: ShadowLook = { strength: 0.85, edge: 0.6, length: 1 };

/** The quad for a ship's maps: slice A's UVs, world-unit size, centred. */
export function litShipGeometry(m: LitMaps): Geometry {
  const hw = m.w / m.ppu / 2, hh = m.h / m.ppu / 2;
  const u1 = m.w / m.frame.w;
  return new Geometry({
    attributes: {
      aPosition: new Float32Array([-hw, -hh, hw, -hh, hw, hh, -hw, hh]),
      aUV: new Float32Array([0, 0, u1, 0, u1, 1, 0, 1]),
    },
    indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

export { LIT_GUTTER };
