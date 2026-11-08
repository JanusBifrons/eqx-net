/**
 * GPU-lit ship art (R&D): the light pass of `shade.ts` run per pixel on the
 * GPU from the three-slice maps (`litMaps.ts`). The base terms mirror
 * `shadeLitTexel` + `litShadow` line for line (keep them in step: the parity
 * test checks the TypeScript twin against the baked frames).
 *
 * Experiment round (step 1b) adds, each compiled in only when switched on
 * (`lightingSettings.ts` `lightingDefines`):
 *  - FILL_LIGHT: a second, coloured light, no shadows;
 *  - POINT_LIGHTS n: explosions and weapons fire light the hull;
 *  - OCCLUDERS (capitals): OCC_SHADOW casts their shadow onto this hull,
 *    OCC_AO darkens the side facing them, OCC_BOUNCE throws their colour on it.
 *
 * One mesh per hull (R1). The maps are a shader resource; the mesh's own
 * texture stays white, so Pixi keeps the normal premultiplied blend. The
 * inherited colour (damage flash, fades) arrives as Pixi's `uColor` and
 * `uWorldColorAlpha`. GLSL ES 1 rules apply (Pixi): loops have constant
 * bounds, uniform arrays are indexed only by the loop variable.
 */
import { BufferImageSource, Geometry, GlProgram, Mesh, Shader, Texture, UniformGroup } from 'pixi.js';
import { matTables, type LightRig } from './shade.js';
import { LIT_GUTTER, sliceX, type LitMaps } from './litMaps.js';
import { BAKED_LOOK, lightingDefines, type LightingSettings } from './lightingSettings.js';

export const LIT_VERTEX = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
out vec2 vLocal;
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
  vLocal = aPosition;
  vColor = uColor * uWorldColorAlpha;
}`;

/** Most self-shadow steps (the loop bound must be constant). */
export const LIT_MAX_SHADOW_STEPS = 128;
/** Point lights and occluders a hull can take at most. */
export const MAX_POINT_LIGHTS = 8;
export const MAX_OCCLUDERS = 4;

/** The material table (shade.ts MATP) as GLSL constants: Pixi compiles GLSL
 *  ES 1, which can't index a uniform array by a variable. */
function matFunctions(): string {
  const { gloss, spec } = matTables();
  const chain = (name: string, t: Float32Array): string => {
    let body = '';
    for (let k = 0; k < t.length; k++) body += `  if (m == ${k}) return ${t[k]!.toFixed(4)};\n`;
    return `float ${name}(int m) {\n${body}  return ${t[1]!.toFixed(4)};\n}`;
  };
  return chain('matGloss', gloss) + '\n' + chain('matSpec', spec);
}

function litFragment(defines: string): string {
  return /* glsl */ `
precision highp float;
${defines}
in vec2 vUV;
in vec2 vLocal;
in vec4 vColor;
out vec4 finalColor;
uniform sampler2D uMaps;
// x: slice B offset (uv), y: slice C offset (uv), zw: one texel (uv).
uniform vec4 uSlices;
// Sun direction in the hull's frame (xyz) and the half vector.
uniform vec3 uL;
uniform vec3 uH;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uRim;
// x: exposure, y: max height, z: max emission, w: texels per world unit.
uniform vec4 uScale;
// x: self-shadow steps, y: march step (texels), z: rise per step (world u).
uniform vec3 uShadow;
// x: full-shadow darkness, y: edge softness (world u), z: rise per world unit (occluder shadows).
uniform vec3 uShadowLook;
#ifdef FILL_LIGHT
uniform vec3 uL2;
uniform vec3 uFillColor;
#endif
#ifdef POINT_LIGHTS
// Hull-local position (xy), height (z), reach (w); colour (rgb), intensity (a).
uniform vec4 uPLPos[POINT_LIGHTS];
uniform vec4 uPLCol[POINT_LIGHTS];
#endif
#ifdef OCCLUDERS
// Centre (xy) and box axis (zw: cos, sin) in hull-local units; half size (xy),
// height (z); colour (rgb) and how sunlit (a). Unused slots have height 0.
uniform vec4 uOccPose[OCCLUDERS];
uniform vec4 uOccSize[OCCLUDERS];
uniform vec4 uOccCol[OCCLUDERS];
#endif

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
  float ao = 1.0 - 0.65 * cav;
  float sk = matSpec(mat);
  float gl = matGloss(mat);

  // Self shadow: march the height toward the sun (shade.ts shadowMap).
  float shadow = 1.0;
#ifdef SELF_SHADOW
  {
    vec2 dir = normalize(uL.xy) * uShadow.y * uSlices.zw;
    float h0 = height + 0.05;
    float occl = 0.0;
    for (int s = 1; s < ${LIT_MAX_SHADOW_STEPS}; s++) {
      if (float(s) >= uShadow.x) break;
      float ray = h0 + uShadow.z * float(s);
      if (ray > uScale.y) break;
      vec2 p = vUV + dir * float(s);
      if (p.x < 0.0 || p.y < 0.0 || p.x >= uSlices.x - ${LIT_GUTTER}.0 * uSlices.z || p.y >= 1.0) break;
      float d = texture(uMaps, p + vec2(uSlices.x, 0.0)).b * uScale.y - ray;
      if (d > 0.0) { occl = max(occl, min(1.0, d / uShadowLook.y)); if (occl >= 1.0) break; }
    }
    shadow = 1.0 - occl * uShadowLook.x;
  }
#endif

  vec3 ambient = uAmbient;
  vec3 rimC = uRim;
  vec3 extra = vec3(0.0);
  // In a capital's shadow the hull also loses most of its fill light and some sky.
  float inCapShadow = 0.0;
#ifdef OCCLUDERS
  {
    float occShadow = 0.0, occAo = 0.0;
    vec2 sd = normalize(uL.xy);
    for (int i = 0; i < OCCLUDERS; i++) {
      vec4 P = uOccPose[i];
      vec4 S = uOccSize[i];
      if (S.z <= 0.0) continue;
      mat2 Rt = mat2(P.z, -P.w, P.w, P.z); // rotate into the box's frame
      vec2 q = Rt * (vLocal - P.xy);
#ifdef OCC_SHADOW
      {
        // Ray toward the sun through the box (slabs): in shadow if it passes
        // under the box's height.
        vec2 dq = Rt * sd;
        vec2 inv = 1.0 / (abs(dq) + 1e-5) * sign(dq + 1e-6);
        vec2 t1 = (-S.xy - q) * inv, t2 = (S.xy - q) * inv;
        float tn = max(min(t1.x, t2.x), min(t1.y, t2.y));
        float tf = min(max(t1.x, t2.x), max(t1.y, t2.y));
        if (tf > max(tn, 0.0)) {
          float t0 = max(tn, 0.0);
          float rayH = height + t0 * uShadowLook.z;
          occShadow = max(occShadow, clamp((S.z - rayH) / max(uShadowLook.y * 6.0, 1.0), 0.0, 1.0));
        }
      }
#endif
      // How close the box's side is, and whether this pixel faces it.
      float dist = length(max(abs(q) - S.xy, vec2(0.0)));
      float near = clamp(1.0 - dist / (S.z * 3.0 + 30.0), 0.0, 1.0);
      vec2 toBox = P.xy - vLocal;
      float facing = clamp(0.35 + 0.65 * dot(n.xy, normalize(toBox + 1e-4)), 0.0, 1.0);
#ifdef OCC_AO
      occAo = max(occAo, near * near * facing);
#endif
#ifdef OCC_BOUNCE
      extra += alb * uOccCol[i].rgb * uSunColor * 0.35 * uOccCol[i].a * near * facing * ao;
#endif
    }
    inCapShadow = occShadow * uShadowLook.x;
    shadow *= 1.0 - inCapShadow;
    ambient *= (1.0 - 0.7 * occAo) * (1.0 - 0.45 * inCapShadow);
    rimC *= (1.0 - 0.7 * occAo) * (1.0 - 0.6 * inCapShadow);
  }
#endif

  float ndl = max(0.0, dot(n, uL));
  float ndh = max(0.0, dot(n, uH));
  float spec = (sk > 0.0 && ndh > 0.0) ? sk * pow(ndh, gl) * shadow : 0.0;
  float nzi = 1.0 - n.z;
  float rim = nzi * nzi * 1.6 * ao;
  float hemi = (0.55 + 0.45 * n.z) * ao;
  float sunT = ndl * shadow * (0.35 + 0.65 * ao);
  vec3 rad = alb * (ambient * hemi + uSunColor * sunT) + uSunColor * spec * 0.6 + rimC * rim * (0.35 + alb) + emis + extra;
#ifdef FILL_LIGHT
  rad += alb * uFillColor * max(0.0, dot(n, uL2)) * ao * (1.0 - 0.8 * inCapShadow);
#endif
#ifdef POINT_LIGHTS
  for (int i = 0; i < POINT_LIGHTS; i++) {
    vec4 lp = uPLPos[i];
    vec4 lc = uPLCol[i];
    if (lc.a <= 0.0) continue;
    // Height is above the hull's top (a capital's deck stands taller than a
    // blast beside it would otherwise sit), and the light fades to nothing
    // at its reach.
    vec3 d = vec3(lp.xy - vLocal, lp.z + uScale.y - height);
    float dist = length(d);
    float k = dist / lp.w;
    float w = clamp(1.0 - k * k, 0.0, 1.0);
    float att = lc.a * w * w;
    vec3 Lp = d / max(dist, 1e-3);
    float nd = max(0.0, dot(n, Lp));
    vec3 Hp = normalize(Lp + vec3(0.0, 0.0, 1.0));
    float sp = sk > 0.0 ? sk * pow(max(0.0, dot(n, Hp)), gl) : 0.0;
    rad += lc.rgb * att * (alb * nd * ao + sp * 0.6);
  }
#endif
  vec3 c = rad * uScale.x;
  vec3 rgb = vec3(linToSrgb(tone(c.r)), linToSrgb(tone(c.g)), linToSrgb(tone(c.b)));
  finalColor = vec4(rgb * cov, cov) * vColor;
}`;
}

const programs = new Map<string, GlProgram>();
function litProgram(s: LightingSettings): GlProgram {
  const { key, defines } = lightingDefines(s);
  let p = programs.get(key);
  if (!p) {
    p = GlProgram.from({ vertex: LIT_VERTEX, fragment: litFragment(defines), name: `lit-ship-${programs.size}` });
    programs.set(key, p);
  }
  return p;
}

/** The maps as a texture: uploaded as-is (no premultiplication: every channel is data). */
export function litMapsTexture(m: LitMaps): Texture {
  const source = new BufferImageSource({
    resource: new Uint8Array(m.frame.data.buffer, m.frame.data.byteOffset, m.frame.data.byteLength),
    width: m.frame.w, height: m.frame.h, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear',
  });
  return new Texture({ source });
}

/** A light in the world (Pixi space): explosions, weapons fire. */
export interface PointLight { x: number; y: number; z: number; r: number; g: number; b: number; intensity: number; reach: number; owner: number }
/** A big hull that shades others (Pixi space): a box with a height. */
export interface Occluder { id: number; x: number; y: number; rot: number; hx: number; hy: number; height: number; r: number; g: number; b: number; sunlit: number }

/** The lights and occluders around this frame (filled by the caller, reused). */
export class LitScene {
  readonly lights: PointLight[] = [];
  lightCount = 0;
  readonly occluders: Occluder[] = [];
  occluderCount = 0;
  begin(): void { this.lightCount = 0; this.occluderCount = 0; }
  /** `owner`: the hull this light belongs to (its engines), -1 for none. */
  addLight(x: number, y: number, z: number, color: number, intensity: number, reach: number, owner = -1): void {
    let l = this.lights[this.lightCount];
    if (!l) { l = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, intensity: 0, reach: 1, owner: -1 }; this.lights.push(l); }
    l.x = x; l.y = y; l.z = z; l.intensity = intensity; l.reach = reach; l.owner = owner;
    l.r = ((color >> 16) & 255) / 255; l.g = ((color >> 8) & 255) / 255; l.b = (color & 255) / 255;
    this.lightCount++;
  }
  addOccluder(id: number, x: number, y: number, rot: number, hx: number, hy: number, height: number, color: number, sunlit: number): void {
    let o = this.occluders[this.occluderCount];
    if (!o) { o = { id: 0, x: 0, y: 0, rot: 0, hx: 0, hy: 0, height: 0, r: 0, g: 0, b: 0, sunlit: 0 }; this.occluders.push(o); }
    o.id = id; o.x = x; o.y = y; o.rot = rot; o.hx = hx; o.hy = hy; o.height = height; o.sunlit = sunlit;
    o.r = ((color >> 16) & 255) / 255; o.g = ((color >> 8) & 255) / 255; o.b = (color & 255) / 255;
    this.occluderCount++;
  }
}

/** Fill light: from the side away from the sun, low, cool. */
const FILL_COLOR = [0.16, 0.22, 0.42] as const;

const _pick = new Int32Array(MAX_POINT_LIGHTS + MAX_OCCLUDERS);
const _pickD = new Float64Array(MAX_POINT_LIGHTS + MAX_OCCLUDERS);

/**
 * One GPU-lit hull: a quad the size of the hull (world units, centred), lit
 * by the shader. `setLight` once per frame with the sun, the hull's world
 * pose and the scene's lights / occluders.
 */
export class LitShipMesh extends Mesh<Geometry, Shader> {
  private readonly uni: UniformGroup;
  private readonly u: Record<string, Float32Array>;
  /** Occluder id of this hull (so it never shades itself), -1 for none. */
  occluderId = -1;
  /** Owner id of this hull's own lights (its engines), -1 for none. */
  lightOwnerId = -1;
  /** How much of its own engines' light a hull takes (they point away from it). */
  static OWN_LIGHT = 0.15;
  /** The hull's half extents (world u): lights are judged at its rectangle. */
  private readonly hx: number;
  private readonly hy: number;

  constructor(readonly maps: LitMaps, tex: Texture, readonly settings: LightingSettings = BAKED_LOOK, geometry?: Geometry) {
    const W = maps.frame.w;
    const NL = Math.max(1, settings.pointLights), NO = MAX_OCCLUDERS;
    const uni = new UniformGroup({
      uSlices: { value: new Float32Array([sliceX(maps.w, 1) / W, sliceX(maps.w, 2) / W, 1 / W, 1 / maps.h]), type: 'vec4<f32>' },
      uL: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
      uH: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
      uSunColor: { value: new Float32Array(3), type: 'vec3<f32>' },
      uAmbient: { value: new Float32Array(3), type: 'vec3<f32>' },
      uRim: { value: new Float32Array(3), type: 'vec3<f32>' },
      uScale: { value: new Float32Array([1, maps.maxH, maps.emisMax, maps.ppu]), type: 'vec4<f32>' },
      uShadow: { value: new Float32Array([0, 1, 0]), type: 'vec3<f32>' },
      uShadowLook: { value: new Float32Array([0.85, 0.6, 1]), type: 'vec3<f32>' },
      uL2: { value: new Float32Array([0, 0, 1]), type: 'vec3<f32>' },
      uFillColor: { value: new Float32Array(FILL_COLOR), type: 'vec3<f32>' },
      uPLPos: { value: new Float32Array(NL * 4), type: 'vec4<f32>', size: NL },
      uPLCol: { value: new Float32Array(NL * 4), type: 'vec4<f32>', size: NL },
      uOccPose: { value: new Float32Array(NO * 4), type: 'vec4<f32>', size: NO },
      uOccSize: { value: new Float32Array(NO * 4), type: 'vec4<f32>', size: NO },
      uOccCol: { value: new Float32Array(NO * 4), type: 'vec4<f32>', size: NO },
    });
    const shader = new Shader({ glProgram: litProgram(settings), resources: { litUniforms: uni, uMaps: tex.source, uMapsSampler: tex.source.style } });
    super({ geometry: geometry ?? litShipGeometry(maps), shader });
    this.uni = uni;
    this.u = uni.uniforms as Record<string, Float32Array>;
    this.hx = maps.w / maps.ppu / 2; this.hy = maps.h / maps.ppu / 2;
  }

  /** Light for this frame: the sector's sun, the hull's world pose (Pixi
   *  space) and the lights / occluders around it. */
  setLight(rig: LightRig, x: number, y: number, worldRotation: number, scene: LitScene | null): void {
    const s = this.settings;
    const elev = s.sunElevDeg !== null ? (s.sunElevDeg * Math.PI) / 180 : rig.sunElev;
    const localAz = rig.sunAz - worldRotation;
    const ce = Math.cos(elev);
    const L = this.u['uL']!, H = this.u['uH']!;
    L[0] = Math.cos(localAz) * ce; L[1] = Math.sin(localAz) * ce; L[2] = Math.sin(elev);
    const hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
    H[0] = hx / hl; H[1] = hy / hl; H[2] = hz / hl;
    const sc = this.u['uSunColor']!, am = this.u['uAmbient']!, rm = this.u['uRim']!;
    for (let k = 0; k < 3; k++) { sc[k] = rig.sunColor[k]!; am[k] = rig.ambient[k]! * s.ambientBoost; rm[k] = rig.rim[k]! * s.ambientBoost; }
    this.u['uScale']![0] = rig.exposure;
    // Self shadow, as shade.ts: ~0.75 world units a step, clipped at 40 u ×
    // the length (a longer shadow rises more slowly over more steps).
    const len = Math.max(0.25, s.shadow.length);
    const stepT = Math.max(1, this.maps.ppu * 0.75);
    const rise = (Math.tan(elev) / this.maps.ppu) * stepT / len;
    const maxSteps = Math.min(s.selfShadowSteps, LIT_MAX_SHADOW_STEPS, Math.ceil((40 * len) / 0.75), Math.ceil(this.maps.maxH / Math.max(1e-4, rise)) + 2);
    const sh = this.u['uShadow']!;
    sh[0] = s.selfShadowSteps > 0 ? maxSteps : 0; sh[1] = stepT; sh[2] = rise;
    const look = this.u['uShadowLook']!;
    // Capital shadows use the real sun angle (the length × is a self-shadow look).
    look[0] = s.shadow.strength; look[1] = s.shadow.edge; look[2] = Math.tan(elev);
    if (s.fillLight) {
      const az2 = localAz + Math.PI * 0.8, e2 = 0.35;
      const L2 = this.u['uL2']!;
      L2[0] = Math.cos(az2) * Math.cos(e2); L2[1] = Math.sin(az2) * Math.cos(e2); L2[2] = Math.sin(e2);
    }
    if (scene) this.fillScene(scene, x, y, worldRotation);
    this.uni.update();
  }

  /** Nearest lights and occluders, in this hull's local frame. Allocation-free. */
  private fillScene(scene: LitScene, x: number, y: number, rot: number): void {
    const c = Math.cos(-rot), sn = Math.sin(-rot);
    const s = this.settings;
    if (s.pointLights > 0) {
      const n = Math.min(s.pointLights, MAX_POINT_LIGHTS);
      const k = strongestLightsInto(scene, x, y, rot, this.hx, this.hy, n, this.lightOwnerId);
      const P = this.u['uPLPos']!, C = this.u['uPLCol']!;
      for (let i = 0; i < n; i++) {
        if (i >= k) { C[i * 4 + 3] = 0; continue; }
        const l = scene.lights[_pick[i]!]!;
        const dx = l.x - x, dy = l.y - y;
        const isOwn = this.lightOwnerId >= 0 && l.owner === this.lightOwnerId;
        P[i * 4] = dx * c - dy * sn; P[i * 4 + 1] = dx * sn + dy * c; P[i * 4 + 2] = isOwn ? l.z - this.maps.maxH : l.z; P[i * 4 + 3] = l.reach; // own engines sit low at the stern, not over the deck
        const own = isOwn ? LitShipMesh.OWN_LIGHT : 1;
        C[i * 4] = l.r; C[i * 4 + 1] = l.g; C[i * 4 + 2] = l.b; C[i * 4 + 3] = l.intensity * own;
      }
    }
    if (s.capitalShadows || s.capitalOcclusion || s.capitalBounce) {
      const k = nearestInto(scene.occluders, scene.occluderCount, x, y, MAX_OCCLUDERS, this.occluderId);
      const P = this.u['uOccPose']!, S = this.u['uOccSize']!, C = this.u['uOccCol']!;
      for (let i = 0; i < MAX_OCCLUDERS; i++) {
        if (i >= k) { S[i * 4 + 2] = 0; continue; }
        const o = scene.occluders[_pick[i]!]!;
        const dx = o.x - x, dy = o.y - y;
        const rel = o.rot - rot;
        P[i * 4] = dx * c - dy * sn; P[i * 4 + 1] = dx * sn + dy * c; P[i * 4 + 2] = Math.cos(rel); P[i * 4 + 3] = Math.sin(rel);
        S[i * 4] = o.hx; S[i * 4 + 1] = o.hy; S[i * 4 + 2] = o.height;
        C[i * 4] = o.r; C[i * 4 + 1] = o.g; C[i * 4 + 2] = o.b; C[i * 4 + 3] = o.sunlit;
      }
    }
  }
}

/**
 * The `n` lights that reach this hull hardest into `_pick`: judged at the
 * hull's own rectangle (`hx` × `hy` half extents, rotated by `rot`), not a
 * circle round it. A long capital's circle touches every ship nearby, so
 * escorts' engines crowded a blast off its deck (hostile review 2026-11-08).
 * Weighted by intensity and falloff; the hull's own engines count for little.
 * Returns how many; the picks are in `_pick` (read by `pickedLight`).
 */
export function strongestLightsInto(scene: LitScene, x: number, y: number, rot: number, hx: number, hy: number, n: number, owner: number): number {
  const c = Math.cos(-rot), sn = Math.sin(-rot);
  let k = 0;
  for (let i = 0; i < scene.lightCount; i++) {
    const l = scene.lights[i]!;
    const dx = l.x - x, dy = l.y - y;
    const ox = Math.max(0, Math.abs(dx * c - dy * sn) - hx), oy = Math.max(0, Math.abs(dx * sn + dy * c) - hy);
    const edge = Math.hypot(ox, oy);
    if (edge >= l.reach) continue; // out of reach (the shader fades to 0 at reach)
    const q = edge / l.reach, w = 1 - q * q;
    const own = owner >= 0 && l.owner === owner ? LitShipMesh.OWN_LIGHT : 1;
    const d = -(l.intensity * own) * w * w; // lower = stronger
    let j: number;
    if (k < n) j = k++;
    else { if (d >= _pickD[n - 1]!) continue; j = n - 1; }
    while (j > 0 && _pickD[j - 1]! > d) { _pickD[j] = _pickD[j - 1]!; _pick[j] = _pick[j - 1]!; j--; }
    _pickD[j] = d; _pick[j] = i;
  }
  return k;
}
/** The scene index of the `i`th light `strongestLightsInto` picked. */
export function pickedLight(i: number): number { return _pick[i]!; }

/** The `n` items nearest (x, y) into `_pick` (skipping occluder `skipId`); returns how many. */
function nearestInto(items: ReadonlyArray<{ x: number; y: number; id?: number }>, count: number, x: number, y: number, n: number, skipId: number): number {
  let k = 0;
  for (let i = 0; i < count; i++) {
    const it = items[i]!;
    if (skipId >= 0 && it.id === skipId) continue;
    const d = (it.x - x) * (it.x - x) + (it.y - y) * (it.y - y);
    let j: number;
    if (k < n) j = k++;
    else { if (d >= _pickD[n - 1]!) continue; j = n - 1; }
    while (j > 0 && _pickD[j - 1]! > d) { _pickD[j] = _pickD[j - 1]!; _pick[j] = _pick[j - 1]!; j--; }
    _pickD[j] = d; _pick[j] = i;
  }
  return k;
}

/** The quad for a hull's maps: slice A's UVs, world-unit size, centred. */
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
