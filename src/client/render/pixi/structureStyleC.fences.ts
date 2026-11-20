/**
 * Style C family "fences" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Fences + gates: shield pylon, shield gate, airlock, territory lock.
 * The gate and airlock gatehouses (and their door-leaf art) live in the helper
 * `structureStyleC.fences.gate.ts`. This family's drawings live only here; `kinds` is spread into `STYLE_C`
 * (structureStyleC.ts). Kind -> family: structureFamilies.ts.
 */
import { GraphicsContext } from 'pixi.js';
import {
  LAMP_AMBER, LAMP_WHITE, RIVET, SLAB, SLAB_DARK, SLAB_LIGHT, SOOT, chamferBox, core, deck, glow, lamp,
  ngon, poly, rivets, stencil, strip, wornStripe, type StyleCtx, type StyleDrawerTable,
} from './structureStyleKit.js';
import type { RigDrawHookTable } from './structureRigLook.js';
import type { BodyStatusHook, BodyStatusHookTable } from './structureSocketNubs.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { getStructureKind, type StructureKindId } from '../../../shared-types/structureKinds.js';
import { EMIT, EMIT_DEAD, doorLeafContext, doorStatus, shieldAirlock, shieldGate } from './structureStyleC.fences.gate.js';

/** Bump with any change to this family's drawings: it is part of the stored
 *  bake key of every kind below (`structureStyleVersion`), so players' cached
 *  art for this family re-bakes and nothing else does. */
export const version = 'f2gh';

/** Shield pylon lens radii (× k, drawn for 120): the glass and its lamp. */
const PYLON_LENS = 13;
const PYLON_LAMP = 7;
/** Territory lock lights (× k, drawn for 400 × 300): antenna fins
 *  [x, half length], the emitter heads' radius, the tower slots, the hub. */
const LOCK_FINS = [[98, 118], [136, 96], [172, 72]] as const;
const LOCK_HEAD = 4;
const LOCK_SLOT_W = 16, LOCK_SLOT_H = 30, LOCK_SLOT_Y_DOWN = 72, LOCK_SLOT_Y_UP = -102;
const LOCK_HUB_LENS = 6;

/** Shield pylon (drawn for 120 × 120, scaled by the short side): a squat
 *  octagonal plinth with an emitter in stacked rings on top; heat-sink fins
 *  on the four diagonals (walls plug into the side studs). Powered, the emitter glows wall-teal; dark when unpowered. */
function shieldPylon(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W, H) / 120;
  deck(c);
  // Heat-sink fins on the diagonals: three thin plates each.
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a);
    for (const off of [-7, 0, 7]) {
      const ox = -sa * off * k, oy = ca * off * k;
      poly(c, strip([ca * 36 * k + ox, sa * 36 * k + oy], [ca * 54 * k + ox, sa * 54 * k + oy], 3 * k), SLAB_DARK, 'metal', 8, 0.8);
    }
  }
  // The plinth and its bolt ring.
  const plinth = core(c, ngon(0, 0, 40 * k, 8, Math.PI / 8), SLAB, 22, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8, r = 35 * k;
    poly(c, ngon(Math.cos(a) * r, Math.sin(a) * r, 1.8 * k, 6), RIVET, 'metal', 24, 0.5);
  }
  wornStripe(c, plinth, Math.PI / 2, 30 * k, 5 * k, 7);
  // The emitter: collar, dark ring, lens.
  poly(c, ngon(0, 0, 27 * k, 16), SLAB_DARK, 'metal', 30, 2);
  poly(c, ngon(0, 0, 20 * k, 16), SOOT, 'metal', 26, 1.5);
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    poly(c, ngon(Math.cos(a) * 23.5 * k, Math.sin(a) * 23.5 * k, 1.6 * k, 6), RIVET, 'metal', 32, 0.5);
  }
  glow(c, ngon(0, 0, PYLON_LENS * k, 16), c.live ? EMIT : EMIT_DEAD, 0.95);
  c.lit(0, 0, PYLON_LAMP * k, c.live ? 0xd8fbff : EMIT_DEAD);
  lamp(c, W / 2 - 8 * k, -H / 2 + 8 * k, 2.5 * k, LAMP_AMBER);
}

/** Territory Lock (drawn for 400 × 300, scaled by the short side / 300):
 *  the broadcast SPIRE in style C. A long riveted spine runs the full width;
 *  three pairs of antenna fins either side, tapering toward the ends, each
 *  tipped with claim-teal emitter heads; a chamfered lantern tower in the
 *  middle with lit slots above and below a round beacon seat. The beacon (a
 *  dish on a sweep arm) is the `lock-beacon` rig's part (`lockBeaconContext`):
 *  it turns only while the lock holds its sector; the hub it turns round
 *  stays here. */
function territoryLock(c: StyleCtx): void {
  const { W, H } = c;
  const k = Math.min(W / 400, H / 300);
  const emit = c.live ? EMIT : EMIT_DEAD;
  deck(c);
  // The spine: a dark beam, a lighter cap plate, rivet rows both edges.
  const half = W / 2 - 14 * k;
  core(c, chamferBox(-half, -22 * k, 2 * half, 44 * k, 10 * k), SLAB_DARK, 12, 0);
  poly(c, chamferBox(-half + 10 * k, -8 * k, 2 * half - 20 * k, 16 * k, 4 * k), SLAB_LIGHT, 'metal', 3, 1);
  for (const s of [-1, 1]) rivets(c, [-half + 14 * k, s * 15 * k], [half - 14 * k, s * 15 * k], 14 * k, 1.8 * k);
  // Antenna fins: three pairs either side of the tower.
  for (const [fx, fl] of LOCK_FINS) {
    for (const sx of [-1, 1]) {
      const cx = sx * fx * k, len = fl * k;
      poly(c, chamferBox(cx - 8 * k, -len, 16 * k, 2 * len, 5 * k), SLAB, 'metal', 14, 2, { seams: 18 * k, seamAngle: 0 });
      poly(c, strip([cx, -len + 14 * k], [cx, len - 14 * k], 3 * k), SOOT, 'metal', -1, 0.6);
      for (const sy of [-1, 1]) {
        poly(c, chamferBox(cx - 11 * k, sy * len - (sy > 0 ? 12 * k : 0), 22 * k, 12 * k, 3 * k), SLAB_LIGHT, 'metal', 18, 1.2);
        glow(c, ngon(cx, sy * (len - 6 * k), LOCK_HEAD * k, 8), emit, 0.95);
      }
    }
  }
  // The lantern tower.
  const tw = 60 * k, th = 128 * k;
  const tower = core(c, chamferBox(-tw, -th, 2 * tw, 2 * th, 22 * k), SLAB, 22, Math.PI / 2);
  wornStripe(c, tower, Math.PI / 2, -th + 14 * k, 7 * k, 11);
  for (const sy of [-1, 1]) {
    poly(c, chamferBox(-14 * k, sy > 0 ? 66 * k : -108 * k, 28 * k, 42 * k, 5 * k), SOOT, 'metal', -2, 1.5);
    glow(c, chamferBox((-LOCK_SLOT_W / 2) * k, (sy > 0 ? LOCK_SLOT_Y_DOWN : LOCK_SLOT_Y_UP) * k, LOCK_SLOT_W * k, LOCK_SLOT_H * k, 3 * k), emit, 0.9);
  }
  // The beacon seat: collar, bolt ring, dark well.
  poly(c, ngon(0, 0, 50 * k, 24), SLAB_DARK, 'metal', 26, 2);
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    poly(c, ngon(Math.cos(a) * 45 * k, Math.sin(a) * 45 * k, 1.7 * k, 6), RIVET, 'metal', 28, 0.5);
  }
  poly(c, ngon(0, 0, 40 * k, 24), SOOT, 'metal', 22, 1.5);
  // The beacon's hub and its claim-teal emitter (the arm and dish that turn
  // round it are the rig part, `lockBeaconContext`).
  poly(c, ngon(0, 0, 11 * k, 12), SLAB, 'metal', 33, 1);
  glow(c, ngon(0, 0, LOCK_HUB_LENS * k, 12), emit, 0.95);
  c.lit(0, 0, LOCK_HUB_LENS * k, c.live ? 0xd8fbff : EMIT_DEAD);
  // Spine-end hazard lamps, tower work lamps, a hull number.
  for (const sx of [-1, 1]) lamp(c, sx * (half - 8 * k), 0, 4 * k, LAMP_AMBER);
  lamp(c, -tw + 10 * k, th - 12 * k, 3 * k, LAMP_WHITE);
  lamp(c, tw - 10 * k, -th + 12 * k, 3 * k, LAMP_AMBER);
  stencil(c, '01', 16 * k, 46 * k, 18 * k);
  if (c.livery) c.sigils.push({ x: -36 * k, y: 60 * k, r: 12 * k });
}

/** This family's style C drawers (kinds not listed keep today's art). */
export const kinds: StyleDrawerTable = {
  shield_pylon: shieldPylon,
  shield_gate: shieldGate,
  shield_airlock: shieldAirlock,
  territory_lock: territoryLock,
};

// ── Unpowered: the lights go dark (live body state) ────────────────────────

/** 1 = a built pylon / lock with no power, else 0 (the powered, lit art is
 *  the bake and never re-bakes). Reads the same `powered` row flag as the
 *  no-power bolt (ConnectorRenderer). Shared by every family whose lights go
 *  dark unpowered. */
export function unpoweredCode(_kind: StructureKindId, st: StructureRenderState | undefined): number {
  return st !== undefined && st.built && st.powered === false ? 1 : 0;
}

const _fill = { color: 0, alpha: 0 };

/** A dead-glass disc over a baked lens. */
function deadDisc(g: GraphicsContext, x: number, y: number, r: number): void {
  g.circle(x, y, r);
  _fill.color = EMIT_DEAD; _fill.alpha = 1; g.fill(_fill);
}

/** Unpowered pylon: the emitter goes dark. The lamp's halo (2.2 × the lamp)
 *  stays inside the soot ring, so soot out to the halo, then dead glass; the
 *  collar, ring and plinth are the bake, unchanged. */
function drawPylonDark(g: GraphicsContext, code: number, kind: StructureKindId): void {
  if (code !== 1) return;
  const fp = getStructureKind(kind).footprint;
  const k = Math.min(fp.w, fp.h) / 120;
  g.circle(0, 0, PYLON_LAMP * 2.2 * k);
  _fill.color = SOOT; _fill.alpha = 1; g.fill(_fill);
  deadDisc(g, 0, 0, PYLON_LENS * k);
}

/** Unpowered lock: every claim-teal light goes dark (fin heads, tower slots,
 *  the hub emitter); spine, fins, tower and work lamps are the bake. */
function drawLockDark(g: GraphicsContext, code: number, kind: StructureKindId): void {
  if (code !== 1) return;
  const fp = getStructureKind(kind).footprint;
  const k = Math.min(fp.w / 400, fp.h / 300);
  for (const [fx, fl] of LOCK_FINS) {
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) deadDisc(g, sx * fx * k, sy * (fl - 6) * k, (LOCK_HEAD + 0.5) * k);
    }
  }
  for (let sy = -1; sy <= 1; sy += 2) {
    const y = sy > 0 ? LOCK_SLOT_Y_DOWN : LOCK_SLOT_Y_UP;
    g.rect((-LOCK_SLOT_W / 2 - 1) * k, (y - 1) * k, (LOCK_SLOT_W + 2) * k, (LOCK_SLOT_H + 2) * k);
    _fill.color = EMIT_DEAD; _fill.alpha = 1; g.fill(_fill);
  }
  deadDisc(g, 0, 0, (LOCK_HUB_LENS + 2) * k);
}

const unpoweredPylon: BodyStatusHook = { code: unpoweredCode, draw: drawPylonDark };
const unpoweredLock: BodyStatusHook = { code: unpoweredCode, draw: drawLockDark };

/** This family's live body state (`BodyStatusHook`, drawn on the socket-nub
 *  overlay, structureSocketNubs.ts): pylon and lock lights dark unpowered;
 *  the gate / airlock deck lights follow the decoded doors
 *  (docs/plans/door-power.md, slice 11). */
export const status: BodyStatusHookTable = {
  shield_pylon: unpoweredPylon,
  territory_lock: unpoweredLock,
  shield_gate: doorStatus,
  shield_airlock: doorStatus,
};

// The territory lock's beacon (the `lock-beacon` rig part's own art, in the
// part's Pixi frame, centred on the hub): a sweep arm reaching out from the
// hub's rim to a dish, with a counterweight behind. The arm starts at the
// hub's edge, so the body's hub and emitter stay uncovered as it turns.
// Drawn once, shared by every lock; posing only turns it. Laid out for the
// 400 × 300 footprint, scaled like the body (`territoryLock`).
const BEACON_ARM = 0x59626b;
const BEACON_DISH = 0x6b747d;
const BEACON_LIP = 0xb7c0c8;
const BEACON_WEIGHT = 0x3c4249;
const BEACON_EDGE = 0x0a0c0e;
let beaconCtx: GraphicsContext | null = null;

/** The shared art of every territory lock's beacon dish (built on first use). */
export function lockBeaconContext(): GraphicsContext {
  if (beaconCtx !== null) return beaconCtx;
  const fp = getStructureKind('territory_lock').footprint;
  const k = Math.min(fp.w / 400, fp.h / 300);
  const g = new GraphicsContext();
  // Arm out to the dish, and the short tail to the counterweight.
  g.rect(11 * k, -4 * k, 17 * k, 8 * k).fill({ color: BEACON_ARM }).stroke({ color: BEACON_EDGE, width: 1.2 });
  g.rect(-20 * k, -4 * k, 9 * k, 8 * k).fill({ color: BEACON_ARM }).stroke({ color: BEACON_EDGE, width: 1.2 });
  g.roundRect(-30 * k, -9 * k, 12 * k, 18 * k, 3 * k).fill({ color: BEACON_WEIGHT }).stroke({ color: BEACON_EDGE, width: 1.2 });
  // The dish: a shallow bowl facing out, a bright rim on its back, a feed pin.
  g.poly([24 * k, -20 * k, 34 * k, -14 * k, 36 * k, 0, 34 * k, 14 * k, 24 * k, 20 * k, 28 * k, 0])
    .fill({ color: BEACON_DISH }).stroke({ color: BEACON_EDGE, width: 1.4 });
  g.moveTo(24 * k, -20 * k).lineTo(34 * k, -14 * k).lineTo(36 * k, 0).lineTo(34 * k, 14 * k).lineTo(24 * k, 20 * k)
    .stroke({ color: BEACON_LIP, width: 1.6, alpha: 0.85 });
  g.circle(30 * k, 0, 1.8 * k).fill({ color: 0xe8ecef, alpha: 0.9 });
  beaconCtx = g;
  return g;
}

/** The beacon turns while the lock holds its sector (the rig's `running` hook). */
export function lockHolding(st: StructureRenderState | undefined): boolean {
  return st?.lockHolding === true;
}

/** This family's rig drawing hooks, by rig id (`RigDrawHook`,
 *  structureRigLook.ts); rigs not listed draw from their part roles only. */
export const rigs: RigDrawHookTable = {
  'lock-beacon': { partArt: () => lockBeaconContext(), running: lockHolding },
  'gate-doors': { partArt: doorLeafContext },
  'airlock-doors': { partArt: doorLeafContext },
};

