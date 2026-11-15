/**
 * THE charge telegraph (plan step 6): one per AI ship whose kind carries a
 * charge weapon, built once with the sprite and driven per frame from the
 * snapshot's `drones[].chargingMask` / `chargeStartTick` (mirror
 * `chargingMask` / `chargeStartTick`). Each charge weapon picks its look
 * (`chargeTelegraph` on its catalogue record):
 *  - 'ring-line' (default, the robot charge laser): the hot ring round the
 *    hull and the faint line out to the weapon's range (`buildChargeTelegraphGfx`),
 *    pulsing while any such mount charges.
 *  - 'mount-glow': a glow on the charging gun only (its mount and barrel),
 *    ramping up from the charge's start to full, no aim line.
 *  - 'rail-slot': the 'mount-glow' of a split-rail ('rail' family) gun, the
 *    railgun: blue-white light fills the slot between its rails, creeping
 *    from the breech to the muzzle and brightening as it nears full.
 * Times are game time: the ramp runs on the renderer's `fxNow` (#20) from a
 * start latched off the server tick, so a late joiner sees the true progress
 * (#16). Each mount ramps from its OWN start (`chargeOffsets`, ticks after
 * the earliest), so a battleship's main turrets that began charging apart
 * glow apart. Allocation-free per frame (#14).
 *
 * Discharge into the shot: the mask comes off the NEWEST snapshot, so it
 * clears the tick the server fires, but the slug and its muzzle flash are
 * drawn on the display timeline (`DISPLAY_DELAY_MS` behind). A gun whose
 * charge ended FULL therefore holds its glow full (flaring) until that gun's
 * shot shows (`shotMs`, MountVisualManager's last-shot time) or, with no
 * shot seen, `CHARGE_HOLD_MAX_MS` (snapshots alone converge, #16).
 */
import { Container, Graphics } from 'pixi.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { getWeapon, type WeaponDef } from '../../../core/combat/WeaponCatalogue.js';
import { shipTurrets } from '../art/turretLayout.js';
import { railGeom, railSlotCharge, type RailSlotCharge, type TurretFamily } from '../art/fx/turretFx.js';
import { buildChargeTelegraphGfx } from './spriteBuilders.js';
import { DISPLAY_DELAY_MS } from '../../net/swarmInterpolation.js';

/** Game ms per server tick. */
const TICK_MS = 1000 / 60;
/** The glow's colour: a hot violet-white, the charge family's tint. */
const GLOW_COLOR = 0xd890ff;
const GLOW_CORE = 0xfff0ff;
/** The railgun's charge: blue-white light in the slot between its rails. */
const RAIL_GLOW = 0x7fb4ff;
const RAIL_CORE = 0xeef6ff;
/** Longest a full charge holds after its mask clears with no shot seen: the
 *  display delay (the flash comes that much after the clear) plus a
 *  snapshot interval and some jitter. */
export const CHARGE_HOLD_MAX_MS = DISPLAY_DELAY_MS + 100;

export type ChargeTelegraphStyle = 'ring-line' | 'mount-glow' | 'rail-slot';

/** A charge weapon's telegraph look (absent ⇒ the robot's ring + line). A
 *  'mount-glow' weapon on a split-rail gun (`family` 'rail') fills the
 *  slot between its rails instead ('rail-slot'). */
export function chargeTelegraphStyle(w: WeaponDef, family?: TurretFamily): ChargeTelegraphStyle {
  const s = w.chargeTelegraph ?? 'ring-line';
  return s === 'mount-glow' && family === 'rail' ? 'rail-slot' : s;
}

/** How far a charge has built, 0..1, `elapsedMs` (game) into a charge of
 *  `chargeMs`. Pure. */
export function chargeGlowLevel(elapsedMs: number, chargeMs: number): number {
  if (!(chargeMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return elapsedMs >= chargeMs ? 1 : elapsedMs / chargeMs;
}

export interface ChargeTelegraph {
  /** Parent of every telegraph graphic; a child of the ship sprite. */
  readonly root: Container;
  /** The ring + aim line, or null when no mount uses 'ring-line'. */
  readonly ring: Graphics | null;
  /** Mounts whose weapon uses 'ring-line'. */
  readonly ringMask: number;
  /** Per kind mount: its glow ('mount-glow' / 'rail-slot'), else null. */
  readonly glows: ReadonlyArray<Container | null>;
  /** Per kind mount: its slot fill ('rail-slot'), else null. */
  readonly rails: ReadonlyArray<RailSlotGfx | null>;
  /** Per kind mount: its charge length in game ms (0 = no charge weapon). */
  readonly chargeMs: ReadonlyArray<number>;
  /** Per kind mount: its base angle (the glow turns with the gun). */
  readonly baseAngles: ReadonlyArray<number>;
  /** The latched start: the snapshot's start tick and its fxNow. */
  startTick: number;
  startFxMs: number;
  /** Per kind mount: the catalogue mount id (the caller's last-shot lookup). */
  readonly mountIds: ReadonlyArray<string>;
  /** Per kind mount: the caller's scratch for each gun's last drawn shot
   *  (fx ms, −Infinity = none), filled before `updateChargeTelegraph`. */
  readonly shotMs: number[];
  /** Per kind mount: the level drawn last frame, and the fx ms its charge
   *  began (a shot after the charge's midpoint is this charge's shot). */
  readonly levels: number[];
  readonly chargeFromMs: number[];
  /** Mounts whose full charge ended and whose shot has not shown yet, and
   *  the fx ms each hold began. */
  heldMask: number;
  readonly heldSinceMs: number[];
  /** Last frame's mask (a set bit that clears starts a hold). */
  prevMask: number;
}

/** A glow on one gun: a soft disc on the mount plus a streak up the barrel
 *  (Pixi-up local: the barrel points to -y). Sizes come from the gun's own
 *  drawn geometry (`shipTurrets`, #18). */
function buildMountGlowGfx(r: number, len: number, wid: number): Graphics {
  const g = new Graphics();
  g.circle(0, 0, r * 1.6).fill({ color: GLOW_COLOR, alpha: 0.18 });
  g.circle(0, 0, r).fill({ color: GLOW_COLOR, alpha: 0.35 });
  g.circle(0, 0, r * 0.45).fill({ color: GLOW_CORE, alpha: 0.6 });
  if (len > 0) {
    const w = Math.max(wid, r * 0.25);
    g.rect(-w * 1.2, -len, w * 2.4, len).fill({ color: GLOW_COLOR, alpha: 0.3 });
    g.rect(-w * 0.5, -len, w, len).fill({ color: GLOW_CORE, alpha: 0.55 });
  }
  return g;
}

/** A railgun's slot charge: `fill` (scaled 0..1 along the slot from the
 *  breech) and the bright `head` at its front. Children of the mount glow. */
export interface RailSlotGfx { fill: Graphics; head: Graphics; y0: number; len: number }

/** A railgun's charge glow (Pixi-up local, barrel to −y): a soft glow in the
 *  breech bore, and the slot fill + head, sized from the drawn rails
 *  (`railGeom`, the same numbers the bake used, #18). */
function buildRailSlotGfx(houseW: number, houseL: number, len: number, wid: number): { g: Container; rail: RailSlotGfx } {
  const G = railGeom(houseW, houseL, len, wid);
  const g = new Container();
  const bore = new Graphics();
  bore.circle(0, 0, G.breechR * 0.5).fill({ color: RAIL_GLOW, alpha: 0.22 });
  bore.circle(0, 0, G.slotW * 0.9).fill({ color: RAIL_CORE, alpha: 0.5 });
  const L = G.railY0 - G.muzzleY;
  // The fill is drawn from its origin (the breech end) out to −L; scale.y
  // is the charge, so it grows from the breech toward the muzzle.
  const fill = new Graphics();
  // Inside the slot only (the rails stay dark either side of the light).
  fill.rect(-G.slotW * 0.5, -L, G.slotW, L).fill({ color: RAIL_GLOW, alpha: 0.55 });
  fill.rect(-G.slotW * 0.3, -L, G.slotW * 0.6, L).fill({ color: RAIL_GLOW, alpha: 0.8 });
  fill.rect(-G.slotW * 0.12, -L, G.slotW * 0.24, L).fill({ color: RAIL_CORE, alpha: 0.95 });
  fill.y = G.railY0;
  const head = new Graphics();
  head.ellipse(0, 0, G.slotW * 0.9, G.slotW * 2.6).fill({ color: RAIL_GLOW, alpha: 0.35 });
  head.ellipse(0, 0, G.slotW * 0.4, G.slotW * 1.4).fill({ color: RAIL_CORE, alpha: 0.9 });
  head.y = G.railY0;
  g.addChild(bore, fill, head);
  return { g, rail: { fill, head, y0: G.railY0, len: L } };
}

/** Build a kind's telegraph (hidden), or null when it has no charge weapon. */
export function buildChargeTelegraph(kindId: string | undefined, radius: number): ChargeTelegraph | null {
  if (!kindId) return null;
  const mounts = getShipKind(kindId).mounts ?? [];
  let any = false;
  let ringMask = 0;
  let ringRange = 0;
  const glows: (Container | null)[] = [];
  const rails: (RailSlotGfx | null)[] = [];
  const chargeMs: number[] = [];
  const baseAngles: number[] = [];
  const root = new Container();
  let places: ReturnType<typeof shipTurrets> | null = null;
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i]!;
    const w = getWeapon(m.weaponId);
    const ct = w.chargeTicks ?? 0;
    chargeMs.push(ct * TICK_MS);
    baseAngles.push(m.baseAngle);
    glows.push(null);
    rails.push(null);
    if (ct <= 0) continue;
    any = true;
    if (chargeTelegraphStyle(w) === 'ring-line') {
      if (i < 31) ringMask |= 1 << i;
      if (w.mode === 'hitscan' && w.range > ringRange) ringRange = w.range;
      continue;
    }
    places ??= shipTurrets(kindId);
    const p = places[i];
    let g: Container;
    if (p?.naval && chargeTelegraphStyle(w, p.family) === 'rail-slot') {
      const built = buildRailSlotGfx(p.naval.houseW, p.naval.houseL, p.len, p.wid);
      g = built.g;
      rails[i] = built.rail;
    } else {
      const r = p ? Math.max(p.ring, p.cap * 1.5, p.naval ? p.naval.houseW * 0.6 : 0) : radius * 0.15;
      g = buildMountGlowGfx(r, p ? Math.max(p.len, p.muzzle) : 0, p ? p.wid : r * 0.3);
    }
    g.x = p ? p.px : m.localX;
    g.y = p ? p.py : -m.localY;
    g.rotation = -m.baseAngle;
    g.blendMode = 'add';
    g.visible = false;
    root.addChild(g);
    glows[i] = g;
  }
  if (!any) { root.destroy(); return null; }
  let ring: Graphics | null = null;
  if (ringMask !== 0) {
    ring = buildChargeTelegraphGfx(radius, ringRange);
    ring.visible = false;
    root.addChildAt(ring, 0);
  }
  root.visible = false;
  const n = mounts.length;
  return {
    root, ring, ringMask, glows, rails, chargeMs, baseAngles, startTick: -1, startFxMs: 0,
    mountIds: mounts.map((m) => m.id), shotMs: new Array<number>(n).fill(-Infinity),
    levels: new Array<number>(n).fill(0), chargeFromMs: new Array<number>(n).fill(0),
    heldMask: 0, heldSinceMs: new Array<number>(n).fill(0), prevMask: 0,
  };
}

/** Scratch for one rail slot's charge (alloc-free per frame). */
const _slot: RailSlotCharge = { fill: 0, bright: 0 };

/**
 * Draw this frame's charge state. `mask` / `startTick` from the mirror,
 * `nowTick` the entity's latest server tick (to latch the start on the game
 * clock), `fxNowMs` the renderer's game-time clock, `mountAngles` the drawn
 * arc-local mount angles (the glow turns with its gun), `offsets` each
 * charging mount's start after `startTick` (one per set bit; absent = 0),
 * `shotMs` each kind mount's last drawn shot (fx ms; absent = none seen).
 */
export function updateChargeTelegraph(
  t: ChargeTelegraph, mask: number, startTick: number | undefined, nowTick: number, fxNowMs: number,
  mountAngles: ArrayLike<number> | undefined, offsets?: ArrayLike<number>, shotMs?: ArrayLike<number>,
): void {
  const held = updateHolds(t, mask, fxNowMs, shotMs);
  t.prevMask = mask;
  if (mask === 0 && held === 0) {
    if (t.root.visible) t.root.visible = false;
    t.startTick = -1;
    return;
  }
  t.root.visible = true;
  if (mask !== 0) {
    const st = startTick ?? nowTick;
    if (st !== t.startTick) {
      t.startTick = st;
      t.startFxMs = fxNowMs - Math.max(0, nowTick - st) * TICK_MS;
    }
  } else {
    t.startTick = -1;
  }
  const elapsed = fxNowMs - t.startFxMs;
  if (t.ring !== null) {
    const on = (mask & t.ringMask) !== 0;
    t.ring.visible = on;
    if (on) t.ring.alpha = 0.45 + 0.4 * Math.sin(fxNowMs / 70);
  }
  const glows = t.glows;
  let bit = 0; // index of mount i among the set bits (the offsets' order)
  for (let i = 0; i < glows.length; i++) {
    const on = i < 31 && (mask & (1 << i)) !== 0;
    const k = bit;
    if (on) bit++;
    const g = glows[i];
    if (g === null || g === undefined) continue;
    const hold = !on && i < 31 && (held & (1 << i)) !== 0;
    g.visible = on || hold;
    if (!on && !hold) { t.levels[i] = 0; continue; }
    g.rotation = -(t.baseAngles[i]! + (mountAngles?.[i] ?? 0));
    const rail = t.rails[i];
    if (hold) {
      // Discharging: full and flaring until the shot shows.
      const f = Math.min(1, (fxNowMs - t.heldSinceMs[i]!) / DISPLAY_DELAY_MS);
      g.alpha = 1;
      if (rail) {
        rail.fill.scale.y = 1;
        rail.head.y = rail.y0 - rail.len;
        rail.head.scale.set(1 + 0.6 * f);
      } else {
        g.scale.set(1 + 0.2 * f);
      }
      continue;
    }
    const off = offsets !== undefined && k < offsets.length ? offsets[k]! * TICK_MS : 0;
    t.chargeFromMs[i] = t.startFxMs + off;
    const level = chargeGlowLevel(elapsed - off, t.chargeMs[i]!);
    t.levels[i] = level;
    const flicker = level >= 1 ? 0.85 + 0.15 * Math.sin(fxNowMs / 45) : 1;
    if (rail) {
      // The railgun: the slot fills from the breech to the muzzle and
      // brightens as it nears full; the glow stays the gun's own size.
      const c = railSlotCharge(level, _slot);
      g.alpha = c.bright * flicker;
      rail.fill.scale.y = Math.max(0.001, c.fill);
      rail.head.y = rail.y0 - rail.len * c.fill;
      rail.head.scale.set(0.6 + 0.4 * c.fill);
      continue;
    }
    g.alpha = (0.15 + 0.85 * level) * flicker;
    g.scale.set(0.5 + 0.5 * level);
  }
}

/**
 * This frame's holds: a glow mount whose bit cleared after a FULL charge
 * starts one; a hold ends when that gun's shot shows (a shot after its
 * charge's midpoint) or after `CHARGE_HOLD_MAX_MS`. A charging mount is
 * never held. Returns (and stores) the held mask.
 */
function updateHolds(t: ChargeTelegraph, mask: number, fxNowMs: number, shotMs: ArrayLike<number> | undefined): number {
  const cleared = t.prevMask & ~mask;
  let held = t.heldMask & ~mask;
  if (cleared === 0 && held === 0) { t.heldMask = 0; return 0; }
  const glows = t.glows;
  const n = glows.length < 31 ? glows.length : 31;
  for (let i = 0; i < n; i++) {
    const bit = 1 << i;
    if (glows[i] === null) continue;
    if ((cleared & bit) !== 0) {
      if (t.levels[i]! >= 1) { held |= bit; t.heldSinceMs[i] = fxNowMs; }
      t.levels[i] = 0;
    }
    if ((held & bit) === 0) continue;
    const shot = shotMs !== undefined && i < shotMs.length ? shotMs[i]! : -Infinity;
    if (shot >= t.chargeFromMs[i]! + t.chargeMs[i]! * 0.5 || fxNowMs - t.heldSinceMs[i]! > CHARGE_HOLD_MAX_MS) held &= ~bit;
  }
  t.heldMask = held;
  return held;
}
