/**
 * Room-side ship energy tick: the per-tick regen + boost drain over the
 * room's ships. Moved verbatim out of `SectorRoom.tickEnergy` (god-file
 * split slice 41). The pool RULES stay in `core/combat/Energy.ts` (the
 * shared client/server brain, scalar-in / scalar-out); this file is only the
 * server loop that applies them to `ShipState`, the way `ShieldHullRouter`
 * applies shield regen.
 */
import { getShipKind } from '../../shared-types/shipKinds.js';
import { isPilotedActive } from '../../core/entity/shipLiveness.js';
import { effectiveShipEnergyMax } from '../../core/leveling/shipStats.js';
import { regenEnergyStep, spendEnergy, BOOST_TICK_COST } from '../../core/combat/Energy.js';
import type { ShipState } from './schema/SectorState.js';

/** The narrow room surface the energy tick reads. */
export interface ShipEnergyTickHost {
  ships(): Iterable<[string, ShipState]>;
  readonly boostingPlayers: Iterable<string>;
  getActiveShip(playerId: string): ShipState | undefined;
}

/**
 * Energy authority (weapons/energy/AI overhaul §3.1). The single owner of
 * the energy pool lives on the main thread, alongside shield regen + the
 * fire-path drain. Each tick: regen every active ship's pool (no
 * post-spend delay — the bar always feels alive), then drain one boost
 * tick for every player currently boosting (`boostingPlayers` = boost held,
 * regardless of thrust). The boost bit was stripped in the input handler
 * when the pool couldn't afford a tick, so this drain can't drive it
 * negative; `spendEnergy` clamps at 0 anyway. Scalar core helpers ⇒ zero
 * per-tick allocation (Invariant #14).
 */
export function tickShipEnergy(host: ShipEnergyTickHost): void {
  for (const [, ship] of host.ships()) {
    // Covers ACTIVE hulls only (invariant #17) — semantics unchanged,
    // now via the named shared predicate.
    if (!isPilotedActive(ship)) continue;
    const kind = getShipKind(ship.kind);
    // Effective energy cap = kind base × per-instance energy upgrade (review
    // must-fix #1) so an energy-upgraded ship regenerates to its larger pool.
    const energyMax = effectiveShipEnergyMax(kind.energyMax ?? 100, ship.statAlloc);
    ship.energy = regenEnergyStep(ship.energy, energyMax, kind.energyRegenRate ?? 0.25);
  }
  // Keys: a pilot's playerId (ACTIVE ship, #17).
  for (const id of host.boostingPlayers) {
    const ship = host.getActiveShip(id);
    if (!ship) continue;
    ship.energy = spendEnergy(ship.energy, BOOST_TICK_COST);
  }
  // An AI-flown LINGERING hull's pool (boost AND guns) is regenerated and
  // its boost paid ONCE per tick by its AI pilot brain (RTS Part B: the
  // brain owns the pool, `HostileDroneBehaviour.tick`), never here too. A
  // brainless parked hull (wingmen off) idles.
}
