/**
 * Capital turret targeting rules (capitals review, 2026-11-07). Pure and
 * shared by every side that aims a capital's turrets (#15).
 *
 * A priority list with a practical limit, never a hard ban (user, 2026-11-07):
 *  - each gun size PREFERS a class (mains: capitals; 5" secondaries:
 *    sub-capitals and small capitals; AA: small craft) but will take any
 *    hostile it can actually engage;
 *  - it can engage a target only if it can TRACK it: the target's bearing,
 *    seen from the mount, must change slower than the turret turns. A fighter
 *    darting past a battleship is hopeless for the 16" guns (4 deg/s) and the
 *    mediums; a slow or distant one is not. Range does the rest: big guns
 *    out-range everything, so capitals fight at stand-off.
 * Capitals are deadly at range and vulnerable up close: they need escorts.
 * This is TARGETING only: a shell or bolt hits whatever it runs into.
 *
 * Fire mask: a gun fires only when its line of fire leaves the hull soon
 * after the muzzle, i.e. outwards, never down the length of its own ship.
 */
import type { ShipKind, WeaponMount } from '../../shared-types/shipKinds/types.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipHullOutline } from '../geometry/shipHullOutline.js';
import { shipMountMuzzle } from './muzzle.js';

export type TargetClass = 'small' | 'subcapital' | 'small-capital' | 'capital';

/** A sub-capital is this many fighter radii across or more. */
const SUBCAPITAL_RADII = 4;
/** A capital up to this fraction of the largest capital is a "small" one. */
const SMALL_CAPITAL_FRAC = 0.7;

let fighterRadius = 0;
let largestCapital = 0;
function refs(): void {
  if (fighterRadius > 0) return;
  fighterRadius = getShipKind('fighter').radius;
  for (const id of ['destroyer', 'light-cruiser', 'heavy-cruiser', 'battlecruiser', 'battleship']) {
    largestCapital = Math.max(largestCapital, getShipKind(id).radius);
  }
}

/** What class a ship of this kind is, as a target. Size-relative (#18). */
export function targetClass(kind: Pick<ShipKind, 'sizeClass' | 'radius'>): TargetClass {
  refs();
  if (kind.sizeClass === 'capital') return kind.radius <= largestCapital * SMALL_CAPITAL_FRAC ? 'small-capital' : 'capital';
  return kind.radius >= fighterRadius * SUBCAPITAL_RADII ? 'subcapital' : 'small';
}

/** Preference of a mount of this size for a target class: 0 = first
 *  choice. Lower wins; distance breaks ties. Every class is allowed. */
export function mountPriority(size: WeaponMount['size'], cls: TargetClass): number {
  switch (size) {
    case 'AA': return cls === 'small' ? 0 : cls === 'subcapital' ? 1 : 2;
    case 'S': return cls === 'subcapital' || cls === 'small-capital' ? 0 : cls === 'capital' ? 1 : 2;
    case 'M': case 'L': case 'XL': return cls === 'capital' ? 0 : cls === 'small-capital' ? 1 : cls === 'subcapital' ? 2 : 3;
    default: return 0; // ordinary (non-naval) mounts: anything hostile, nearest first
  }
}

/** A turret can follow a target whose bearing changes at most this share of
 *  its traverse rate (the rest is margin to close the gap). */
export const TRACK_MARGIN = 0.8;

/** Can a turret turning at `rotationSpeed` (rad/s) track a target at offset
 *  (dx, dy) moving at (rvx, rvy) relative to the mount? Bearing rate =
 *  |r x v| / |r|^2. Pure, alloc-free. */
export function canTrack(rotationSpeed: number, dx: number, dy: number, rvx: number, rvy: number): boolean {
  const d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) return false;
  return Math.abs(dx * rvy - dy * rvx) / d2 <= rotationSpeed * TRACK_MARGIN;
}

/** Distance from (px, py) along (dx, dy) to where the ray leaves `poly`. */
function exitDistance(poly: ReadonlyArray<readonly [number, number]>, px: number, py: number, dx: number, dy: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - px) * ey - (a[1] - py) * ex) / den;
    const u = ((a[0] - px) * dy - (a[1] - py) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best === Infinity ? 0 : best;
}

const maskCache = new WeakMap<WeaponMount, Uint8Array>();

/** 1° fire mask for a mount: entry d = 1 when a shot at ship-frame bearing d°
 *  (0 = bow, + = to port, the mount-angle convention) leaves the hull within
 *  the muzzle reach plus a quarter beam. Built once per mount. */
function fireMask(kind: ShipKind, m: WeaponMount): Uint8Array {
  let mask = maskCache.get(m);
  if (mask) return mask;
  mask = new Uint8Array(360);
  const hull = shipHullOutline(kind);
  let beam = 0;
  for (const p of hull) beam = Math.max(beam, Math.abs(p[0]) * 2);
  const reach = (shipMountMuzzle(kind, m) ?? 0) + beam * 0.25;
  // Shape frame: x as-is, y = -localY (bow at -y). A ship-frame bearing a
  // points along (-sin a, cos a) in game space = (-sin a, -cos a) here.
  const px = m.localX, py = -m.localY;
  for (let d = 0; d < 360; d++) {
    const a = (d * Math.PI) / 180;
    mask[d] = exitDistance(hull, px, py, -Math.sin(a), -Math.cos(a)) <= reach ? 1 : 0;
  }
  maskCache.set(m, mask);
  return mask;
}

/** Is a shot from mount `m` at ship-frame bearing `bearing` (radians, mount
 *  convention) clear of the ship's own hull? Ordinary mounts: always. */
export function mountLineClear(kind: ShipKind, m: WeaponMount, bearing: number): boolean {
  if (m.size === undefined || kind.sizeClass !== 'capital') return true;
  let d = Math.round((bearing * 180) / Math.PI) % 360;
  if (d < 0) d += 360;
  return fireMask(kind, m)[d] === 1;
}
