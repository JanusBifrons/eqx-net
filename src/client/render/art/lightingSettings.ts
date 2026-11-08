/**
 * GPU lighting settings (R&D, plan prancy-squishing-donut "GPU-lit ship art",
 * step 1b). The user: "performance and configurability is king, so we can
 * toggle these off per device granularly". Every feature of the lit shader
 * has its own switch or level here; a feature that is off is compiled out of
 * the shader (`lightingDefines`), so it costs nothing.
 *
 * Pure data and parsing only: presets per device come from the cost table.
 */

export interface ShadowLook {
  /** How dark a full shadow is, 0..1 (the bake: 0.85). */
  strength: number;
  /** Occluder height (world u) that reaches full shadow: lower = sharper edge (the bake: 0.6). */
  edge: number;
  /** Shadow length × (the bake: 1). Lengthens shadows without lowering the sun. */
  length: number;
}

export interface LightingSettings {
  /** Self-shadow march steps (0 = no cast shadows on the hull itself). */
  selfShadowSteps: 0 | 16 | 48 | 128;
  shadow: ShadowLook;
  /** Sun height override (degrees); null = the sector's own sun. */
  sunElevDeg: number | null;
  /** Multiplies the ambient and rim light (a lower sun darkens hulls). */
  ambientBoost: number;
  /** A second, coloured light from the far side (no shadows). */
  fillLight: boolean;
  /** Dynamic lights per hull: explosions, weapons fire (0 = off). */
  pointLights: 0 | 4 | 8;
  /** Engines are lights too (their own stern, nearby hulls); needs pointLights. */
  engineLights: boolean;
  /** Big hulls (capitals) cast shadows onto nearby ships. */
  capitalShadows: boolean;
  /** Big hulls block ambient light on the side of a ship that faces them. */
  capitalOcclusion: boolean;
  /** Big hulls' sunlit sides throw a little colour onto nearby ships. */
  capitalBounce: boolean;
  /** Structures lit live (else their baked frame). */
  litStructures: boolean;
  /** Asteroids lit live (else their baked frame). */
  litAsteroids: boolean;
}

/** What the baked frames look like (parity with today). */
export const BAKED_LOOK: LightingSettings = {
  selfShadowSteps: 48,
  shadow: { strength: 0.85, edge: 0.6, length: 1 },
  sunElevDeg: null,
  ambientBoost: 1,
  fillLight: false,
  pointLights: 0,
  engineLights: false,
  capitalShadows: false,
  capitalOcclusion: false,
  capitalBounce: false,
  litStructures: false,
  litAsteroids: false,
};

/** The user's lean (2026-11-08): F = 3× long, sharp shadows, lower sun. */
export const LOOK_F: LightingSettings = {
  ...BAKED_LOOK,
  selfShadowSteps: 128,
  shadow: { strength: 1, edge: 0.2, length: 3 },
  sunElevDeg: 25,
};

/**
 * "Realistic" (user, 2026-11-08): no ambient or rim light, only the sun and
 * light from other things (capital bounce, weapons fire, explosions), so a
 * hull's shadowed side is black against space.
 */
export const LOOK_REAL: LightingSettings = {
  ...LOOK_F,
  shadow: { strength: 1, edge: 0.2, length: 3 },
  ambientBoost: 0,
  pointLights: 8,
  engineLights: true,
  capitalShadows: true,
  capitalBounce: true,
};

/** Everything on (the experiment's showcase look). */
export const ALL_ON: LightingSettings = {
  ...LOOK_F,
  ambientBoost: 1.35,
  fillLight: true,
  pointLights: 8,
  engineLights: true,
  capitalShadows: true,
  capitalOcclusion: true,
  capitalBounce: true,
  litStructures: true,
  litAsteroids: true,
};

const STEPS = [0, 16, 48, 128] as const;
const POINTS = [0, 4, 8] as const;
function nearest<T extends number>(vals: readonly T[], v: number): T {
  let best = vals[0]!;
  for (const x of vals) if (Math.abs(x - v) < Math.abs(best - v)) best = x;
  return best;
}
function bool(q: URLSearchParams, k: string, d: boolean): boolean {
  const v = q.get(k);
  return v === null ? d : v === '1' || v === 'true' || v === 'on';
}
function num(q: URLSearchParams, k: string, d: number): number {
  const v = q.get(k);
  if (v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Settings from URL switches over a base (testing): `look=baked|f|real|all`, then
 * per feature `selfshadow=0|16|48|128`, `shadowk=`, `shadowedge=`,
 * `shadowlen=`, `elev=`, `ambient=`, `fill=0|1`, `points=0|4|8`,
 * `capshadow=0|1`, `capao=0|1`, `capbounce=0|1`, `litstruct=0|1`, `litrock=0|1`,
 * `engines=0|1` (engines as lights; turns on 4 point lights if none).
 */
export function lightingFromSearch(search: string, base: LightingSettings = BAKED_LOOK): LightingSettings {
  const q = new URLSearchParams(search);
  const look = q.get('look');
  const b = look === 'f' ? LOOK_F : look === 'all' ? ALL_ON : look === 'real' ? LOOK_REAL : look === 'baked' ? BAKED_LOOK : base;
  const elev = q.get('elev');
  return {
    selfShadowSteps: nearest(STEPS, num(q, 'selfshadow', b.selfShadowSteps)),
    shadow: {
      strength: num(q, 'shadowk', b.shadow.strength),
      edge: Math.max(0.05, num(q, 'shadowedge', b.shadow.edge)),
      length: Math.max(0.25, num(q, 'shadowlen', b.shadow.length)),
    },
    sunElevDeg: elev !== null ? num(q, 'elev', 38) : b.sunElevDeg,
    ambientBoost: num(q, 'ambient', b.ambientBoost),
    fillLight: bool(q, 'fill', b.fillLight),
    pointLights: nearest(POINTS, num(q, 'points', bool(q, 'engines', false) && !q.has('points') ? Math.max(4, b.pointLights) : b.pointLights)),
    engineLights: bool(q, 'engines', b.engineLights),
    capitalShadows: bool(q, 'capshadow', b.capitalShadows),
    capitalOcclusion: bool(q, 'capao', b.capitalOcclusion),
    capitalBounce: bool(q, 'capbounce', b.capitalBounce),
    litStructures: bool(q, 'litstruct', b.litStructures),
    litAsteroids: bool(q, 'litrock', b.litAsteroids),
  };
}

/**
 * How bright an engine's light is (user, 2026-11-08: "engines, depending on
 * size and thrust, cast quite a lot of light"): from idle to four times at
 * full thrust, and bigger nozzles throw more (a capital's several times a
 * fighter's). `nozzleR` in world units, `thrust` 0..1.
 */
export function engineLightIntensity(nozzleR: number, thrust: number): number {
  const size = Math.min(4, Math.max(0.6, nozzleR / 3));
  return (1 + 3 * Math.max(0, Math.min(1, thrust))) * size;
}
/** How far an engine's light reaches (world units): grows with the nozzle. */
export function engineLightReach(nozzleR: number): number { return nozzleR * 14 + 40; }
/**
 * Where an engine's light sits: in the plume, astern of the nozzle and low,
 * not on the hull. A light on the nozzle sits over the ship's own deck and
 * lights the whole hull like a lamp overhead, filling its shadows (hostile
 * review 2026-11-08). Astern, it lights the stern and whatever is behind.
 */
export function engineLightAstern(nozzleR: number): number { return nozzleR * 3; }
export function engineLightHeight(nozzleR: number): number { return nozzleR * 0.5; }

/** Any capital effect on (they share the occluder list). */
export function usesOccluders(s: LightingSettings): boolean {
  return s.capitalShadows || s.capitalOcclusion || s.capitalBounce;
}

/**
 * The shader's compile-time switches for these settings: a feature that is
 * off is not in the program at all. Programs are cached per key.
 */
export function lightingDefines(s: LightingSettings): { key: string; defines: string } {
  const d: string[] = [];
  if (s.selfShadowSteps > 0) d.push('#define SELF_SHADOW 1');
  if (s.fillLight) d.push('#define FILL_LIGHT 1');
  if (s.pointLights > 0) d.push(`#define POINT_LIGHTS ${s.pointLights}`);
  if (s.capitalShadows) d.push('#define OCC_SHADOW 1');
  if (s.capitalOcclusion) d.push('#define OCC_AO 1');
  if (s.capitalBounce) d.push('#define OCC_BOUNCE 1');
  if (usesOccluders(s)) d.push('#define OCCLUDERS 4');
  return { key: d.join('|') || 'base', defines: d.join('\n') };
}
