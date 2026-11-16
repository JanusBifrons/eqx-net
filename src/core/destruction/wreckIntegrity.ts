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
 *
 * Rock cut: every helper takes a ship kind or a wreck source
 * (`wreckSource.ts`), so a mined rock and its pieces wear, split and turn
 * into pods through the same numbers (the rock's area, mass and
 * `ROCK_INTEGRITY_PER_AREA` stand in for a hull's).
 */
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import { WEAPONS, WRECK_DEFAULT_TARGET_FACTOR, weaponTargetFactor, type WeaponId } from '../combat/WeaponCatalogue.js';
import { asWreckSource, type WreckSource } from './wreckSource.js';

/** Least radius of a piece that may still split, per unit of the kind's
 *  radius (#18). Below it the worn-out piece becomes salvage. */
export const WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS = 0.05;

/** Most re-splits the server runs in one tick (a resplit storm would spawn
 *  bodies and run fractures in a burst). A piece over the limit stays worn
 *  out and splits on its next hit. */
export const WRECK_RESPLITS_PER_TICK = 2;

/** A piece's full integrity (hidden hit points against wear). Infinite when
 *  the kind's pieces never break again (they never wear out). */
export function wreckPieceIntegrity(source: ShipKindId | WreckSource, pieceMass: number): number {
  const src = asWreckSource(source);
  const rs = src.profile.resplit;
  if (rs === null) return Number.POSITIVE_INFINITY;
  const bodyMass = src.bodyMass;
  const share = bodyMass > 0 ? Math.min(1, Math.max(0, pieceMass / bodyMass)) : 0;
  const maxHull = src.maxHull;
  return Math.max(share * maxHull * rs.integrityMul, rs.integrityMinFrac * maxHull);
}

/** How much of a hit's damage wears a piece's integrity: the weapon's
 *  'wreck' factor (ordinary guns 0.1, the mining laser 1); an untagged hit
 *  (unknown weapon) wears like an ordinary gun. A ROCK (an uncut rock or a
 *  rock's piece, `rock` true) wears by the weapon's 'rock' factor instead:
 *  0 for every weapon but the mining laser, 0 for an untagged hit. Scalar,
 *  alloc-free (#14). */
export function wreckWearFactor(weaponId: WeaponId | undefined, rock = false): number {
  const def = weaponId !== undefined ? WEAPONS.get(weaponId) : undefined;
  if (rock) return def !== undefined ? weaponTargetFactor(def, 'rock') : 0;
  return def !== undefined ? weaponTargetFactor(def, 'wreck') : WRECK_DEFAULT_TARGET_FACTOR;
}

/** The whole hull's (or rock's) area in world units (scaled). */
export function wreckHullArea(source: ShipKindId | WreckSource): number {
  return asWreckSource(source).area;
}

/** Is a worn-out piece of this area and radius big enough to break again?
 *  (Too small ⇒ it turns into salvage, or a rock's into an ore pod.) */
export function wreckCanResplit(source: ShipKindId | WreckSource, area: number, radius: number): boolean {
  const src = asWreckSource(source);
  const rs = src.profile.resplit;
  if (rs === null) return false;
  return area >= rs.minAreaFrac * src.area
    && radius >= WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS * src.radius;
}

/** Salvage units a worn-out piece too small to split leaves: its mass share
 *  of the kind's `salvagePerHull`, at least 1. */
export function wreckSalvageQty(source: ShipKindId | WreckSource, pieceMass: number): number {
  const src = asWreckSource(source);
  const rs = src.profile.resplit;
  const bodyMass = src.bodyMass;
  if (rs === null || !(bodyMass > 0)) return 1;
  return Math.max(1, Math.round((pieceMass / bodyMass) * rs.salvagePerHull));
}
