/**
 * Wreck-piece integrity: the pure numbers behind a piece wearing down and
 * breaking again (salvage stream PR 5; docs/architecture/capital-destruction.md
 * §S4 "Re-split"). The pool itself lives on the server's per-piece entry
 * (`CapitalWreckSubsystem`); it is hidden: never on the wire, never shown.
 *
 *   I_max = clamp(m_piece / shipBodyMass(kind), 0, 1) × maxHull(kind) × resplit.integrityMul,
 *           floored at resplit.integrityMinFrac × maxHull(kind).
 *
 * Wear per hit is `damage × weaponTargetFactor(def, 'wreck')` (ordinary guns
 * 0.1, the mining laser 1). At 0 a piece splits when it is big enough
 * (`wreckCanResplit`) and the piece cap has room, else it turns into salvage
 * worth `wreckSalvageQty`.
 *
 * Size-dependent numbers scale with the kind (#18): the least radius is a
 * share of `kind.radius`, the area floor a share of the hull's own area.
 */
import { getShipKind, type ShipKindId } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { wreckResplitOptions } from './wreckChildren.js';
import { WEAPONS, WRECK_DEFAULT_TARGET_FACTOR, weaponTargetFactor, type WeaponId } from '../combat/WeaponCatalogue.js';
import { shipHullOutline, shipShapeScale } from '../geometry/shipHullOutline.js';

/** Least radius of a piece that may still split, per unit of the kind's
 *  radius (#18). Below it the worn-out piece becomes salvage. */
export const WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS = 0.05;

/** Most re-splits the server runs in one tick (a resplit storm would spawn
 *  bodies and run fractures in a burst). A piece over the limit stays worn
 *  out and splits on its next hit. */
export const WRECK_RESPLITS_PER_TICK = 2;

/** A piece's full integrity (hidden hit points against wear). Infinite when
 *  the kind's pieces never break again (they never wear out). */
export function wreckPieceIntegrity(kindId: ShipKindId, pieceMass: number): number {
  const rs = wreckResplitOptions(kindId);
  if (rs === null) return Number.POSITIVE_INFINITY;
  const kind = getShipKind(kindId);
  const bodyMass = shipBodyMass(kind);
  const share = bodyMass > 0 ? Math.min(1, Math.max(0, pieceMass / bodyMass)) : 0;
  const maxHull = kind.maxHealth;
  return Math.max(share * maxHull * rs.integrityMul, rs.integrityMinFrac * maxHull);
}

/** How much of a hit's damage wears a piece's integrity: the weapon's
 *  'wreck' factor (ordinary guns 0.1, the mining laser 1); an untagged hit
 *  (unknown weapon) wears like an ordinary gun. Scalar, alloc-free (#14). */
export function wreckWearFactor(weaponId: WeaponId | undefined): number {
  const def = weaponId !== undefined ? WEAPONS.get(weaponId) : undefined;
  return def !== undefined ? weaponTargetFactor(def, 'wreck') : WRECK_DEFAULT_TARGET_FACTOR;
}

const hullAreaCache = new Map<ShipKindId, number>();

/** The whole hull's area in world units (scaled), memoised per kind. */
export function wreckHullArea(kindId: ShipKindId): number {
  let a = hullAreaCache.get(kindId);
  if (a !== undefined) return a;
  const kind = getShipKind(kindId);
  const r = shipHullOutline(kind);
  let s2 = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!;
    const q = r[(i + 1) % r.length]!;
    s2 += p[0] * q[1] - q[0] * p[1];
  }
  const s = shipShapeScale(kind);
  a = (Math.abs(s2) / 2) * s * s;
  hullAreaCache.set(kindId, a);
  return a;
}

/** Is a worn-out piece of this area and radius big enough to break again?
 *  (Too small ⇒ it turns into salvage.) */
export function wreckCanResplit(kindId: ShipKindId, area: number, radius: number): boolean {
  const rs = wreckResplitOptions(kindId);
  if (rs === null) return false;
  return area >= rs.minAreaFrac * wreckHullArea(kindId)
    && radius >= WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS * getShipKind(kindId).radius;
}

/** Salvage units a worn-out piece too small to split leaves: its mass share
 *  of the kind's `salvagePerHull`, at least 1. */
export function wreckSalvageQty(kindId: ShipKindId, pieceMass: number): number {
  const rs = wreckResplitOptions(kindId);
  const bodyMass = shipBodyMass(getShipKind(kindId));
  if (rs === null || !(bodyMass > 0)) return 1;
  return Math.max(1, Math.round((pieceMass / bodyMass) * rs.salvagePerHull));
}
