/**
 * Style C transport: the Ancients' gate "Astrolabe" (teleporter redesign A2,
 * the approved "B Astrolabe" mock-up). Alien stone, not player plating: no
 * rivets, hazard paint or welds.
 *
 * - The static base (`alienGate`, the baked body): the hex light pool at
 *   the centre and the floating crystal over it. No pylons (owner,
 *   2026-11-25: the gate is the rings round the crystal). The pool fills to
 *   the inner ring, where the seal closes: only the pool rides (owner
 *   2026-11-26). The body is a floor, drawn under every hull (pad-deck band);
 *   nothing is baked in the ring band: the rings are rig parts on the `over`
 *   layer, ABOVE the ships (arches they fly under).
 * - The three rings (`alien-astrolabe` rig, `ALIEN_GATE_ASTROLABE_DEF`): each
 *   ring part's art (`astrolabePartContext`) is dark stone in three arc
 *   segments with three lane gaps and dim teal edge lines and glyph ticks;
 *   its lit overlay (`astrolabeLitContext`) brightens the same teal as the
 *   lanes line up (`RigDrawHook.spinClock` writes `litAlpha` from `settle`).
 * - The gate's light (lane beams, pool waves, crystal glow, jump flash):
 *   light-only parts of the same rig, faded per frame from the timetable
 *   (`structureStyleC.transport.astrolabeFx.ts`).
 * - The rings' clock (`astrolabeSpinClock`): set every frame from the jump
 *   timetable (`astrolabePoseAt`), never from frame time, so the lanes line
 *   up as the gate fires; the live `tpPhase` holds them in line through the
 *   cycle (#16: a late joiner sees the same angles).
 */
import { GraphicsContext } from 'pixi.js';
import { ASTROLABE_RINGS, astrolabePoseAt, createAstrolabePose, type AstrolabeRing } from '../../../core/galaxy/alienGateAstrolabe.js';
import type { Rig } from '../../../core/articulation/rig.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { ALIEN_GATE_INTERVAL_MS, TP_PHASE, alienGateOffsetMs } from '../../../shared-types/teleport.js';
import { ALIEN_GATE_SEAL_RADIUS } from '../../../shared-types/alienGateSeal.js';
import { alienGateNeighbour } from '../../components/alienGateInfo.js';
import { SOOT, ngon, poly, strip, type StyleCtx } from './structureStyleKit.js';
import type { RigClockFrame, RigClockMemo, RigClockTarget, RigDrawHook } from './structureRigLook.js';
import {
  ASTROLABE_FX, astrolabeFxAt, astrolabeFxPartContext, astrolabePartShow, clearAstrolabeFx, forEachPoolHex, POOL_HEX,
} from './structureStyleC.transport.astrolabeFx.js';

/** The Ancients' teal (the mock-up's `C.teal`). */
export const ANCIENT_TEAL = 0x3fe0c5;
/** Ring stone (dark basalt). */
const RING_STONE = 0x2a3339;
const CRYSTAL = 0x0e1a1b;
/** The hex light pool's radius and hex cell size. The pool fills right up
 *  to the inner ring: it is the ride area (owner 2026-11-26), the seal's. */
export const LIGHT_POOL_R = ALIEN_GATE_SEAL_RADIUS;
/** Lane spacing (rad): three lanes, lane centres at 0, 120°, 240° (A1). */
const SECTOR = (2 * Math.PI) / 3;
/** Lit overlay strength at full alignment (taste: subtle). */
export const ASTROLABE_GLOW_MAX = 0.8;

/** The hex light pool: a dark teal disc, a hex lattice glowing brighter
 *  toward the centre, a lit rim. */
function lightPool(c: StyleCtx): void {
  const R = LIGHT_POOL_R;
  poly(c, ngon(0, 0, R, 48), 0x071012, 'mark', 0, 1);
  poly(c, ngon(0, 0, R * 0.62, 36), 0x0f2a2a, 'mark', 0, 1);
  forEachPoolHex((x, y, d) => {
    const a = 0.14 + 0.3 * (1 - d / R);
    for (let i = 0; i < 6; i++) {
      const a0 = Math.PI / 6 + (i * Math.PI) / 3, a1 = a0 + Math.PI / 3, r = POOL_HEX * 0.92;
      poly(c, strip([x + Math.cos(a0) * r, y + Math.sin(a0) * r], [x + Math.cos(a1) * r, y + Math.sin(a1) * r], 5), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: a });
    }
  });
  for (let i = 0; i < 48; i++) {
    const a0 = (i / 48) * 2 * Math.PI, a1 = ((i + 1) / 48) * 2 * Math.PI;
    poly(c, strip([Math.cos(a0) * R, Math.sin(a0) * R], [Math.cos(a1) * R, Math.sin(a1) * R], 8), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: 0.35 });
  }
}

/** The floating crystal: a dark three-sided stone edged in teal, a glowing
 *  heart, and three motes around it. */
function crystal(c: StyleCtx): void {
  const tri = ngon(0, 0, 110, 3, -Math.PI / 2);
  poly(c, ngon(14, 20, 110, 3, -Math.PI / 2), SOOT, 'mark', 0.4, 1, { alpha: 0.6 });
  poly(c, tri, CRYSTAL, 'metal', 36, 10, { roof: [10, 30] });
  for (let i = 0; i < 3; i++) poly(c, strip(tri[i]!, tri[(i + 1) % 3]!, 8), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: 0.85 });
  poly(c, ngon(0, 0, 38, 3, -Math.PI / 2), 0x9ff5e6, 'glow', -0.8, 1, { alpha: 0.55 });
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + i * SECTOR;
    poly(c, ngon(Math.cos(a) * 190, Math.sin(a) * 190, 14, 8), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: 0.8 });
  }
  c.lit(0, 0, 60, ANCIENT_TEAL);
}

/** Ancients' gate (`alien_gate`, 1600 × 1600): light pool and crystal.
 *  The rings are the rig's (`astrolabePartContext`). */
export function alienGate(c: StyleCtx): void {
  lightPool(c);
  crystal(c);
}

// ── The rings (rig part art) ──────────────────────────────────────────────

/** Ring `r`'s three stone segments' angle spans (rad, ring frame): from just
 *  past one lane gap to just before the next. */
function segSpan(r: AstrolabeRing, s: number): [number, number] {
  return [s * SECTOR + r.gap / 2, (s + 1) * SECTOR - r.gap / 2];
}

/** Add an arc as its own subpath (`moveTo` then `lineTo`s: never `arc()`
 *  after a point, see arcSubpath.ts). Build time only. */
function arcPath(g: GraphicsContext, r: number, a0: number, a1: number): void {
  const n = Math.max(8, Math.ceil(((a1 - a0) * r) / 24));
  g.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
  for (let i = 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
}

/** The teal edge lines and glyph ticks of ring `r` at strength `k`. */
function ringTeal(g: GraphicsContext, r: AstrolabeRing, k: number): void {
  for (let s = 0; s < 3; s++) {
    const [a0, a1] = segSpan(r, s);
    arcPath(g, r.radius - r.width / 2 + 4, a0, a1);
    arcPath(g, r.radius + r.width / 2 - 4, a0, a1);
  }
  g.stroke({ color: ANCIENT_TEAL, width: 3, alpha: 0.6 * k });
  for (let s = 0; s < 3; s++) {
    const [a0, a1] = segSpan(r, s);
    for (let a = a0 + 0.08; a < a1 - 0.05; a += 0.16) {
      const r1 = r.radius - r.width * 0.25, r2 = r.radius + r.width * ((Math.round(a * 37) % 3) * 0.1);
      g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1).lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    }
  }
  g.stroke({ color: ANCIENT_TEAL, width: 5, alpha: 0.7 * k });
}

const ringArt = new Map<string, GraphicsContext | null>();
const ringLit = new Map<string, GraphicsContext | null>();

function ringOf(rig: Rig, i: number): AstrolabeRing | undefined {
  const id = rig.parts[i]?.id;
  return ASTROLABE_RINGS.find((r) => r.part === id);
}

/** The astrolabe rig's art for part `i`: a stone ring in three segments,
 *  or a light-only part's (`astrolabeFxPartContext`). */
export function astrolabePartContext(rig: Rig, i: number): GraphicsContext | null {
  const r = ringOf(rig, i);
  if (r === undefined) return astrolabeFxPartContext(rig, i);
  const hit = ringArt.get(r.part);
  if (hit !== undefined) return hit;
  const g = new GraphicsContext();
  const ri = r.radius - r.width / 2, ro = r.radius + r.width / 2;
  for (let s = 0; s < 3; s++) {
    const [a0, a1] = segSpan(r, s);
    const n = Math.max(12, Math.ceil(((a1 - a0) * ro) / 20));
    const pts: number[] = [];
    for (let k = 0; k <= n; k++) { const a = a0 + ((a1 - a0) * k) / n; pts.push(Math.cos(a) * ro, Math.sin(a) * ro); }
    for (let k = n; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / n; pts.push(Math.cos(a) * ri, Math.sin(a) * ri); }
    g.poly(pts, true).fill({ color: RING_STONE }).stroke({ color: 0x0a0c0e, width: 2.5 });
    // Masonry joints: the ring is laid in stone blocks.
    for (let a = a0 + 0.3; a < a1 - 0.1; a += 0.3) g.moveTo(Math.cos(a) * ri, Math.sin(a) * ri).lineTo(Math.cos(a) * ro, Math.sin(a) * ro);
    g.stroke({ color: 0x161c20, width: 3 });
  }
  ringTeal(g, r, 0.5);
  ringArt.set(r.part, g);
  return g;
}

/** The astrolabe rig's lit overlay for part `i`: the same teal, brighter,
 *  faded in as the lanes line up (`litAlpha`). */
export function astrolabeLitContext(rig: Rig, i: number): GraphicsContext | null {
  const r = ringOf(rig, i);
  if (r === undefined) return null;
  const hit = ringLit.get(r.part);
  if (hit !== undefined) return hit;
  const g = new GraphicsContext();
  ringTeal(g, r, 1);
  ringLit.set(r.part, g);
  return g;
}

// ── The rings' clock ──────────────────────────────────────────────────────

/** Scratch pose: one for every gate (#14). */
const POSE = createAstrolabePose();

/** This client's estimate of the server's epoch game time (ms) at `fxNowMs`. */
export function astrolabeGameNow(memo: RigClockMemo, fxNowMs: number): number {
  // eslint-disable-next-line no-restricted-properties -- real time: first guess at the server's epoch game clock; snapped to the timetable at the first jump seen
  if (Number.isNaN(memo.anchorMs)) memo.anchorMs = Date.now() - fxNowMs;
  return fxNowMs + memo.anchorMs;
}

/**
 * `RigDrawHook.spinClock` for the astrolabe: the rings' clock from the jump
 * timetable (`astrolabePoseAt`, the pair's `alienGateOffsetMs`) at this
 * client's estimate of the server's epoch game time: `fxNow` (game speed)
 * plus an anchor first guessed from the wall clock, then snapped to the
 * timetable the moment the gate is seen leaving IDLE (alien gates fire only
 * on the timetable), so clock skew or a changed game speed never leaves the
 * lanes out of line at the next jump. A gate with no known twin runs free.
 */
export function astrolabeSpinClock(st: StructureRenderState | undefined, f: RigClockFrame, memo: RigClockMemo, view: RigClockTarget): boolean {
  if (f.sectorKey === null) { clearAstrolabeFx(ASTROLABE_FX); return false; }
  if (memo.sector !== f.sectorKey) {
    // Once per gate (and sector): the pair's place in the minute.
    memo.sector = f.sectorKey;
    const n = alienGateNeighbour(f.sectorKey, f.hostX, f.hostY);
    memo.offsetMs = n === null ? Number.NaN : alienGateOffsetMs(f.sectorKey, n);
    memo.lastPhase = -1;
  }
  if (Number.isNaN(memo.offsetMs)) { clearAstrolabeFx(ASTROLABE_FX); return false; }
  let now = astrolabeGameNow(memo, f.fxNowMs);
  const phase = st?.teleport?.phase ?? TP_PHASE.IDLE;
  if (memo.lastPhase === TP_PHASE.IDLE && phase !== TP_PHASE.IDLE) {
    // The gate just fired: that was a timetabled jump. Snap to the nearest.
    const k = Math.round((now - memo.offsetMs) / ALIEN_GATE_INTERVAL_MS);
    const fired = memo.offsetMs + k * ALIEN_GATE_INTERVAL_MS;
    memo.anchorMs += fired - now;
    now = fired;
  }
  memo.lastPhase = phase;
  astrolabePoseAt(POSE, now, memo.offsetMs, phase);
  view.spinClock = POSE.clockTicks;
  view.litAlpha = ASTROLABE_GLOW_MAX * POSE.settle;
  astrolabeFxAt(ASTROLABE_FX, POSE.sinceFireMs, POSE.settle); // this gate's light, read by its partShow next
  return true;
}

/** The astrolabe rig's drawing hook (`rigs` in structureStyleC.transport.ts). */
export const ASTROLABE_RIG_HOOK: RigDrawHook = {
  partArt: astrolabePartContext,
  partLit: astrolabeLitContext,
  spinClock: astrolabeSpinClock,
  partShow: astrolabePartShow,
};
