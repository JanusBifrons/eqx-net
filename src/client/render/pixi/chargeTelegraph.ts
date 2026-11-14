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
 * Times are game time: the ramp runs on the renderer's `fxNow` (#20) from a
 * start latched off the server tick, so a late joiner sees the true progress
 * (#16). Allocation-free per frame (#14).
 */
import { Container, Graphics } from 'pixi.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { getWeapon, type WeaponDef } from '../../../core/combat/WeaponCatalogue.js';
import { shipTurrets } from '../art/turretLayout.js';
import { buildChargeTelegraphGfx } from './spriteBuilders.js';

/** Game ms per server tick. */
const TICK_MS = 1000 / 60;
/** The glow's colour: a hot violet-white, the charge family's tint. */
const GLOW_COLOR = 0xd890ff;
const GLOW_CORE = 0xfff0ff;

export type ChargeTelegraphStyle = 'ring-line' | 'mount-glow';

/** A charge weapon's telegraph look (absent ⇒ the robot's ring + line). */
export function chargeTelegraphStyle(w: WeaponDef): ChargeTelegraphStyle {
  return w.chargeTelegraph ?? 'ring-line';
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
  /** Per kind mount: its glow ('mount-glow' charge weapons), else null. */
  readonly glows: ReadonlyArray<Graphics | null>;
  /** Per kind mount: its charge length in game ms (0 = no charge weapon). */
  readonly chargeMs: ReadonlyArray<number>;
  /** Per kind mount: its base angle (the glow turns with the gun). */
  readonly baseAngles: ReadonlyArray<number>;
  /** The latched start: the snapshot's start tick and its fxNow. */
  startTick: number;
  startFxMs: number;
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

/** Build a kind's telegraph (hidden), or null when it has no charge weapon. */
export function buildChargeTelegraph(kindId: string | undefined, radius: number): ChargeTelegraph | null {
  if (!kindId) return null;
  const mounts = getShipKind(kindId).mounts ?? [];
  let any = false;
  let ringMask = 0;
  let ringRange = 0;
  const glows: (Graphics | null)[] = [];
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
    if (ct <= 0) continue;
    any = true;
    if (chargeTelegraphStyle(w) === 'ring-line') {
      if (i < 31) ringMask |= 1 << i;
      if (w.mode === 'hitscan' && w.range > ringRange) ringRange = w.range;
      continue;
    }
    places ??= shipTurrets(kindId);
    const p = places[i];
    const r = p ? Math.max(p.ring, p.cap * 1.5, p.naval ? p.naval.houseW * 0.6 : 0) : radius * 0.15;
    const g = buildMountGlowGfx(r, p ? Math.max(p.len, p.muzzle) : 0, p ? p.wid : r * 0.3);
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
  return { root, ring, ringMask, glows, chargeMs, baseAngles, startTick: -1, startFxMs: 0 };
}

/**
 * Draw this frame's charge state. `mask` / `startTick` from the mirror,
 * `nowTick` the entity's latest server tick (to latch the start on the game
 * clock), `fxNowMs` the renderer's game-time clock, `mountAngles` the drawn
 * arc-local mount angles (the glow turns with its gun).
 */
export function updateChargeTelegraph(
  t: ChargeTelegraph, mask: number, startTick: number | undefined, nowTick: number, fxNowMs: number,
  mountAngles: ArrayLike<number> | undefined,
): void {
  if (mask === 0) {
    if (t.root.visible) t.root.visible = false;
    t.startTick = -1;
    return;
  }
  t.root.visible = true;
  const st = startTick ?? nowTick;
  if (st !== t.startTick) {
    t.startTick = st;
    t.startFxMs = fxNowMs - Math.max(0, nowTick - st) * TICK_MS;
  }
  const elapsed = fxNowMs - t.startFxMs;
  if (t.ring !== null) {
    const on = (mask & t.ringMask) !== 0;
    t.ring.visible = on;
    if (on) t.ring.alpha = 0.45 + 0.4 * Math.sin(fxNowMs / 70);
  }
  const glows = t.glows;
  for (let i = 0; i < glows.length; i++) {
    const g = glows[i];
    if (g === null || g === undefined) continue;
    const on = i < 31 && (mask & (1 << i)) !== 0;
    g.visible = on;
    if (!on) continue;
    const level = chargeGlowLevel(elapsed, t.chargeMs[i]!);
    const flicker = level >= 1 ? 0.85 + 0.15 * Math.sin(fxNowMs / 45) : 1;
    g.alpha = (0.15 + 0.85 * level) * flicker;
    g.scale.set(0.5 + 0.5 * level);
    g.rotation = -(t.baseAngles[i]! + (mountAngles?.[i] ?? 0));
  }
}
