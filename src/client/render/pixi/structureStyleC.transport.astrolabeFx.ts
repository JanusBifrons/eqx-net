/**
 * The Ancients' gate's light (teleporter redesign, the approved "B Astrolabe"
 * mock-up's effects; owner, take 19: "no animation or indication you had
 * warped", "the wireframe effect"): the light-only parts of the gate's rig
 * (`ASTROLABE_FX_PARTS`), faded and scaled every frame from the jump
 * timetable through `RigDrawHook.partShow`. No new renderer, pass or
 * particle system: they are rig parts like the rings.
 *
 * - Lane beams: three beams out through the lane gaps, under the stone rings,
 *   so they show only through the gaps and shine straight out once the lanes
 *   line up.
 * - Pool waves: the hex wireframe in five bands from the centre out, lit by
 *   waves running outward; brighter as the rings line up and the gate charges.
 * - Crystal glow: swells as the rings line up and the gate charges.
 * - Jump flash: a white-teal glow that builds over the last moments before
 *   the swap and fades after it, plus three rings of light thrown out. A
 *   rider sees it build as the jump fires and fade on arrival (the twin gate
 *   keeps the same timetable). It is the gate's own light, in the world, not
 *   a screen flash.
 *
 * Deterministic from the timetable (`astrolabePoseAt`'s `sinceFireMs` and
 * `settle`), so a late joiner sees the same light (#16). Allocation-free per
 * frame (#14); the part art is built once.
 */
import { GraphicsContext, type Graphics } from 'pixi.js';
import { ASTROLABE_FX_PARTS, ASTROLABE_LANES, ASTROLABE_SWAP_MS } from '../../../core/galaxy/alienGateAstrolabe.js';
import type { Rig } from '../../../core/articulation/rig.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { ALIEN_GATE_INTERVAL_MS } from '../../../shared-types/teleport.js';
import { ALIEN_GATE_SEAL_RADIUS } from '../../../shared-types/alienGateSeal.js';

const TEAL = 0x3fe0c5;
/** The flash's white (the mock-up's `#e8fffb`). */
const FLASH_WHITE = 0xe8fffb;
/** Pool hex cell size (the baked lattice's). */
export const POOL_HEX = 62;
const POOL_R = ALIEN_GATE_SEAL_RADIUS;
/** Pool wave bands, centre out. */
export const POOL_BANDS = 5;
/** Lane beam reach and width (world units; the mock-up's). */
const LANE_REACH = 1100;
const LANE_WIDTH = 120;
/** Crystal glow radius at full swell (world units). */
const CRYSTAL_GLOW_R = 400;
/** Flash glow radius and the light rings' reach (world units). */
const FLASH_R = 700;
const WAVE_ART_R = 1000;
const WAVE_START_R = 80;
/** The flash builds over this long before the swap and fades over this long
 *  after it (ms; taste: the mock-up's one-second flash). */
export const FLASH_RISE_MS = 400;
export const FLASH_FADE_MS = 1000;
/** Each light ring runs this long, the next starting this much later (ms). */
const WAVE_MS = 1100;
const WAVE_STAGGER_MS = 220;
/** Pool wave length (world units per radian, the mock-up's 95) and angular
 *  speed: a whole number of waves per timetable minute, so the waves run on
 *  unbroken through the minute's wrap. */
const WAVE_LEN = 95;
const WAVE_OMEGA = (2 * Math.PI * 40) / (ALIEN_GATE_INTERVAL_MS / 1000);

/** The light's strengths at a moment (caller-owned scratch). */
export interface AstrolabeFx {
  /** Lane beam alpha. */
  lanes: number;
  /** Pool brightness (0..1) and the waves' phase (rad). */
  pool: number;
  wavePhase: number;
  /** Crystal glow alpha and swell (0..1). */
  crystal: number;
  swell: number;
  /** Flash glow alpha. */
  flash: number;
  /** Ms since the swap (NaN before it, or once the light rings are spent). */
  sinceSwapMs: number;
}

export function createAstrolabeFx(): AstrolabeFx {
  return { lanes: 0, pool: 0, wavePhase: 0, crystal: 0, swell: 0, flash: 0, sinceSwapMs: Number.NaN };
}

/** Dark: a gate with no timetable (no known twin). */
export function clearAstrolabeFx(out: AstrolabeFx): AstrolabeFx {
  out.lanes = 0; out.pool = 0; out.wavePhase = 0; out.crystal = 0; out.swell = 0; out.flash = 0; out.sinceSwapMs = Number.NaN;
  return out;
}

/**
 * The light at `sinceFireMs` after the last timetabled fire, with the rings'
 * `settle` (1 = lanes in line): the lanes and pool brighten as the rings line
 * up, the gate charges from the fire to the swap, the flash builds into the
 * swap and fades after it. Pure; writes `out`.
 */
export function astrolabeFxAt(out: AstrolabeFx, sinceFireMs: number, settle: number): AstrolabeFx {
  const u = sinceFireMs;
  const c = u >= 0 && u < ASTROLABE_SWAP_MS ? (u / ASTROLABE_SWAP_MS) ** 2 : 0; // charge
  out.lanes = 0.08 + 0.42 * settle + 0.3 * c;
  out.pool = Math.min(1, 0.2 + 0.4 * settle + 0.4 * c);
  out.wavePhase = (WAVE_OMEGA * u) / 1000;
  out.crystal = 0.3 + 0.4 * settle + 0.3 * c;
  out.swell = Math.max(settle, c);
  const s = u - ASTROLABE_SWAP_MS;
  if (s >= -FLASH_RISE_MS && s < 0) out.flash = 0.95 * (1 + s / FLASH_RISE_MS);
  else if (s >= 0 && s < FLASH_FADE_MS) out.flash = 0.95 * (1 - s / FLASH_FADE_MS);
  else out.flash = 0;
  out.sinceSwapMs = s >= 0 && s < WAVE_MS + 2 * WAVE_STAGGER_MS ? s : Number.NaN;
  return out;
}

/** Pool band `b`'s wave alpha at the moment `fx` (the mock-up's per-hex
 *  `0.06 + bright * 0.5 * max(0, sin(d / 95 - t * speed))`, per band). */
export function poolBandAlpha(fx: AstrolabeFx, b: number): number {
  const d = ((b + 0.5) / POOL_BANDS) * POOL_R;
  return 0.06 + fx.pool * 0.6 * Math.max(0, Math.sin(d / WAVE_LEN - fx.wavePhase));
}

/** Light ring `j`'s spread (0..1, NaN = not running) at the moment `fx`. */
export function waveSpread(fx: AstrolabeFx, j: number): number {
  const f = (fx.sinceSwapMs - j * WAVE_STAGGER_MS) / WAVE_MS;
  return f >= 0 && f < 1 ? f : Number.NaN;
}

// ── The parts' art (built once) ────────────────────────────────────────────

/** Visit every hex cell centre of the pool lattice (the baked pool's). */
export function forEachPoolHex(visit: (x: number, y: number, d: number) => void): void {
  const hw = POOL_HEX * Math.sqrt(3);
  for (let row = -6; row <= 6; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = col * hw + (row & 1 ? hw / 2 : 0), y = row * POOL_HEX * 1.5, d = Math.hypot(x, y);
      if (d <= POOL_R - POOL_HEX) visit(x, y, d);
    }
  }
}

function lanesArt(): GraphicsContext {
  const g = new GraphicsContext();
  const r0 = POOL_R * 0.92;
  for (let l = 0; l < ASTROLABE_LANES; l++) {
    const a = (l * 2 * Math.PI) / ASTROLABE_LANES, cx = Math.cos(a), cy = Math.sin(a), nx = -cy, ny = cx;
    // A soft beam: a wide faint band, a core, a bright centre line; fading out.
    for (const [w, al] of [[LANE_WIDTH, 0.35], [LANE_WIDTH * 0.5, 0.5], [LANE_WIDTH * 0.15, 0.9]] as const) {
      const h = w / 2;
      g.poly([cx * r0 + nx * h, cy * r0 + ny * h, cx * LANE_REACH + nx * h * 0.6, cy * LANE_REACH + ny * h * 0.6,
        cx * LANE_REACH - nx * h * 0.6, cy * LANE_REACH - ny * h * 0.6, cx * r0 - nx * h, cy * r0 - ny * h], true).fill({ color: TEAL, alpha: al });
    }
  }
  return g;
}

function poolBandArt(b: number): GraphicsContext {
  const g = new GraphicsContext();
  const lo = (b / POOL_BANDS) * POOL_R, hi = ((b + 1) / POOL_BANDS) * POOL_R, r = POOL_HEX * 0.92;
  forEachPoolHex((x, y, d) => {
    if (d < lo || d >= hi) return;
    for (let i = 0; i < 6; i++) {
      const a0 = Math.PI / 6 + (i * Math.PI) / 3, a1 = a0 + Math.PI / 3;
      g.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r).lineTo(x + Math.cos(a1) * r, y + Math.sin(a1) * r);
    }
  });
  g.stroke({ color: TEAL, width: 7, alpha: 1 });
  return g;
}

/** A soft disc: stacked faint circles (a radial fade without a texture). */
function glowDisc(r: number, color: number, steps: number, each: number): GraphicsContext {
  const g = new GraphicsContext();
  for (let i = steps; i >= 1; i--) g.circle(0, 0, (r * i) / steps).fill({ color, alpha: each });
  return g;
}

function waveArt(): GraphicsContext {
  return new GraphicsContext().circle(0, 0, WAVE_ART_R).stroke({ color: TEAL, width: 30, alpha: 1 })
    .circle(0, 0, WAVE_ART_R).stroke({ color: FLASH_WHITE, width: 10, alpha: 0.9 });
}

/** What each fx part shows (by `ASTROLABE_FX_PARTS` order). */
const Role = { None: 0, Lanes: 1, Pool: 2, Crystal: 3, Flash: 4, Wave: 5 } as const;

interface PartRole { role: number; n: number }

function roleOf(id: string): PartRole {
  if (id === 'fx-lanes') return { role: Role.Lanes, n: 0 };
  if (id.startsWith('fx-pool-')) return { role: Role.Pool, n: Number(id.slice(8)) };
  if (id === 'fx-crystal') return { role: Role.Crystal, n: 0 };
  if (id === 'fx-flash') return { role: Role.Flash, n: 0 };
  if (id.startsWith('fx-wave-')) return { role: Role.Wave, n: Number(id.slice(8)) };
  return { role: Role.None, n: 0 };
}

const fxArt = new Map<string, GraphicsContext>();

/** The art for an fx part (null: not an fx part). Built once per part id. */
export function astrolabeFxPartContext(rig: Rig, i: number): GraphicsContext | null {
  const id = rig.parts[i]?.id;
  if (id === undefined || !ASTROLABE_FX_PARTS.some((f) => f.part === id)) return null;
  const hit = fxArt.get(id);
  if (hit !== undefined) return hit;
  const { role, n } = roleOf(id);
  const g = role === Role.Lanes ? lanesArt()
    : role === Role.Pool ? poolBandArt(n)
    : role === Role.Crystal ? glowDisc(CRYSTAL_GLOW_R, TEAL, 10, 0.12)
    : role === Role.Flash ? glowDisc(FLASH_R, FLASH_WHITE, 12, 0.14)
    : waveArt();
  fxArt.set(id, g);
  return g;
}

// ── Per frame ──────────────────────────────────────────────────────────────

/** The light at this frame, for the gate being posed: written by the rig's
 *  spin clock hook just before that gate's pose (`astrolabeSpinClock`, the
 *  registry calls them back to back per structure), read by `partShow`. */
export const ASTROLABE_FX = createAstrolabeFx();

/** Part index -> role, per rig (built once). */
const roles = new WeakMap<Rig, PartRole[]>();
function rolesOf(rig: Rig): PartRole[] {
  let r = roles.get(rig);
  if (r === undefined) {
    r = [];
    for (let i = 0; i < rig.partCount; i++) r.push(roleOf(rig.parts[i]!.id));
    roles.set(rig, r);
  }
  return r;
}

function show(g: Graphics, alpha: number, scale: number): void {
  g.visible = alpha > 0.004;
  g.alpha = Math.min(1, alpha);
  g.scale.set(scale);
}

/** `RigDrawHook.partShow` for the astrolabe: fade and scale the light-only
 *  parts from `ASTROLABE_FX`; the rings are left as posed. Light casts no
 *  shadow. Allocation-free. */
export function astrolabePartShow(rig: Rig, i: number, _value: number, _st: StructureRenderState | undefined, g: Graphics,
  shadow: Graphics | null): void {
  const pr = rolesOf(rig)[i];
  if (pr === undefined || pr.role === Role.None) return;
  if (shadow !== null) shadow.visible = false;
  const fx = ASTROLABE_FX;
  switch (pr.role) {
    case Role.Lanes: show(g, fx.lanes, 1); break;
    case Role.Pool: show(g, poolBandAlpha(fx, pr.n), 1); break;
    case Role.Crystal: show(g, fx.crystal, 0.5 + 0.5 * fx.swell); break;
    case Role.Flash: show(g, fx.flash, 0.6 + 0.4 * Math.min(1, fx.flash / 0.95)); break;
    case Role.Wave: {
      const f = waveSpread(fx, pr.n);
      if (Number.isNaN(f)) show(g, 0, 1);
      else show(g, 1 - f, (WAVE_START_R + f * (WAVE_ART_R - WAVE_START_R)) / WAVE_ART_R);
      break;
    }
  }
}
