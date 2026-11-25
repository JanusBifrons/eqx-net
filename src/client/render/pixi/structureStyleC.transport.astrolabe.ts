/**
 * Style C transport: the Ancients' gate "Astrolabe" (teleporter redesign A2,
 * the approved "B Astrolabe" mock-up). Alien stone, not player plating: no
 * rivets, hazard paint or welds.
 *
 * - The static base (`alienGate`, the baked body): the twelve posts as stone
 *   pylons with teal glyph slits, the hex light pool at the centre and the
 *   floating crystal over it. Nothing is drawn in the ring band: the rings
 *   are rig parts on the `under` layer, BELOW the body sprite, so anything
 *   baked there would cover them (the pylons stand over the outer ring, as
 *   they should).
 * - The three rings (`alien-astrolabe` rig, `ALIEN_GATE_ASTROLABE_DEF`): each
 *   ring part's art (`astrolabePartContext`) is dark stone in three arc
 *   segments with three lane gaps and dim teal edge lines and glyph ticks;
 *   its lit overlay (`astrolabeLitContext`) brightens the same teal as the
 *   lanes line up (`RigDrawHook.spinClock` writes `litAlpha` from `settle`).
 * - The rings' clock (`astrolabeSpinClock`): set every frame from the jump
 *   timetable (`astrolabePoseAt`), never from frame time, so the lanes line
 *   up as the gate fires; the live `tpPhase` holds them in line through the
 *   cycle (#16: a late joiner sees the same angles).
 */
import { GraphicsContext } from 'pixi.js';
import { ASTROLABE_RINGS, astrolabePoseAt, createAstrolabePose, type AstrolabeRing } from '../../../core/galaxy/alienGateAstrolabe.js';
import type { Rig } from '../../../core/articulation/rig.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { ALIEN_GATE_INTERVAL_MS, TP_PHASE, alienGateOffsetMs, padPostCenters } from '../../../shared-types/teleport.js';
import { alienGateNeighbour } from '../../components/alienGateInfo.js';
import { SOOT, chamferBox, ngon, poly, strip, type PolyOp, type Pts, type StyleCtx } from './structureStyleKit.js';
import type { RigClockFrame, RigClockMemo, RigClockTarget, RigDrawHook } from './structureRigLook.js';

/** The Ancients' teal (the mock-up's `C.teal`). */
export const ANCIENT_TEAL = 0x3fe0c5;
/** Ring stone and pylon stone (dark basalt). */
const RING_STONE = 0x2a3339;
const PYLON_STONE = 0x2e373e;
const CAP_STONE = 0x3a464e;
const CRYSTAL = 0x0e1a1b;
/** The hex light pool's radius (inside the inner ring) and hex cell size. */
export const LIGHT_POOL_R = 360;
const HEX = 62;
/** Lane spacing (rad): three lanes, lane centres at 0, 120°, 240° (A1). */
const SECTOR = (2 * Math.PI) / 3;
/** Lit overlay strength at full alignment (taste: subtle). */
export const ASTROLABE_GLOW_MAX = 0.8;

/** A polygon pushed WITHOUT the outline fit check: the corner pylons stand on
 *  the gate's corner posts, past the style outline's deep chamfer. Still
 *  inside the footprint box the forge bakes. */
function stand(c: StyleCtx, pts: Pts, color: number, mat: PolyOp['mat'], lift: number, bevel: number, extra?: Partial<PolyOp>): void {
  c.polys.push({ pts, color, mat, lift, bevel, ...extra });
}

/** One stone pylon on a post (`post` wide, the collider's size). */
function pylon(c: StyleCtx, x: number, y: number, post: number): void {
  const h = post / 2;
  stand(c, chamferBox(x - h + 14, y - h + 18, post, post, 18), SOOT, 'mark', 0.4, 1, { alpha: 0.85 });
  stand(c, chamferBox(x - h, y - h, post, post, 18), PYLON_STONE, 'metal', 44, 10, { roof: [8, 16] });
  stand(c, ngon(x, y, h * 0.52, 4, Math.PI / 4), CAP_STONE, 'metal', 6, 4);
  // Glyph slits etched down two faces, and the lit eye on the cap.
  for (const s of [-1, 1]) stand(c, strip([x + s * (h - 14), y - h + 22], [x + s * (h - 14), y + h - 22], 5), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: 0.4 });
  stand(c, ngon(x, y, 9, 6), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: 0.9 });
  c.lit(x, y, 12, ANCIENT_TEAL);
}

/** The hex light pool: a dark teal disc, a hex lattice glowing brighter
 *  toward the centre, a lit rim. */
function lightPool(c: StyleCtx): void {
  const R = LIGHT_POOL_R;
  poly(c, ngon(0, 0, R, 48), 0x071012, 'mark', 0, 1);
  poly(c, ngon(0, 0, R * 0.62, 36), 0x0f2a2a, 'mark', 0, 1);
  const hw = HEX * Math.sqrt(3);
  for (let row = -6; row <= 6; row++) {
    for (let col = -4; col <= 4; col++) {
      const x = col * hw + (row & 1 ? hw / 2 : 0), y = row * HEX * 1.5, d = Math.hypot(x, y);
      if (d > R - HEX) continue;
      const a = 0.14 + 0.3 * (1 - d / R);
      for (let i = 0; i < 6; i++) {
        const a0 = Math.PI / 6 + (i * Math.PI) / 3, a1 = a0 + Math.PI / 3, r = HEX * 0.92;
        poly(c, strip([x + Math.cos(a0) * r, y + Math.sin(a0) * r], [x + Math.cos(a1) * r, y + Math.sin(a1) * r], 5), ANCIENT_TEAL, 'glow', -0.8, 1, { alpha: a });
      }
    }
  }
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

/** Ancients' gate (`alien_gate`, 1600 × 1600): pylons, light pool, crystal.
 *  The rings are the rig's (`astrolabePartContext`). */
export function alienGate(c: StyleCtx): void {
  lightPool(c);
  crystal(c);
  for (const [x, y] of padPostCenters('alien_gate')) pylon(c, x, -y, 100);
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

/** The astrolabe rig's art for part `i`: a stone ring in three segments. */
export function astrolabePartContext(rig: Rig, i: number): GraphicsContext | null {
  const r = ringOf(rig, i);
  if (r === undefined) return null;
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
  if (f.sectorKey === null) return false;
  if (memo.sector !== f.sectorKey) {
    // Once per gate (and sector): the pair's place in the minute.
    memo.sector = f.sectorKey;
    const n = alienGateNeighbour(f.sectorKey, f.hostX, f.hostY);
    memo.offsetMs = n === null ? Number.NaN : alienGateOffsetMs(f.sectorKey, n);
    memo.lastPhase = -1;
  }
  if (Number.isNaN(memo.offsetMs)) return false;
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
  return true;
}

/** The astrolabe rig's drawing hook (`rigs` in structureStyleC.transport.ts). */
export const ASTROLABE_RIG_HOOK: RigDrawHook = {
  partArt: astrolabePartContext,
  partLit: astrolabeLitContext,
  spinClock: astrolabeSpinClock,
};
