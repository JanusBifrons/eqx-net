/**
 * Per-ship energy pool math (pure logic).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ SHARED BRAIN (unlike `ShieldHull.ts`, which is server-authority-only).│
 * │ Energy is driven entirely by the player's OWN fire/boost input, so it │
 * │ is predictable like position: the server owns the authoritative value │
 * │ and the client calls these SAME helpers to predict + reconcile its    │
 * │ local `predEnergy`. Core owns the rules; both zones consume them. See │
 * │ `docs/plans/weapons-energy-ai-overhaul.md` §3.                        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Rules (locked design decisions):
 *  - ALL weapon SLOT triggers and boosting drain from one pool. A slot
 *    trigger drains its cost ONCE (not per mount — the interceptor's twin
 *    beams cost one beam-slot's energy). Boost drains `BOOST_TICK_COST`
 *    per tick while held+thrusting.
 *  - The pool regenerates by `energyRegenRate` every tick with NO post-spend
 *    delay (unlike shield) — so the bar always feels alive.
 *  - A fire/boost action is gated: it only happens if the ship `canAfford`
 *    it. Spending never drives the pool negative (clamped at 0).
 *  - Energy is TRANSIENT: respawns full, never persisted. Drones are NOT
 *    energy-gated — these helpers are called only on the player path.
 *
 * Allocation-free: every function is scalar-in / scalar-out (no objects, no
 * mutation of a passed wrapper), safe to call from the per-tick hot loop
 * (Invariant #14).
 */

import { getWeapon } from './WeaponCatalogue.js';
import { resolveSlot, resolveSlotMounts } from '../../shared-types/shipKinds/slots.js';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';

/** Per-tick energy drained while boost is held AND the ship is thrusting.
 *  Sized so continuous boost empties a full pool in ~3-4 s, making
 *  boost-vs-shoot a real tradeoff (plan §3.3). At 60 Hz, 1.0/tick drains a
 *  240-pool in 4 s; a 120-pool in 2 s. */
export const BOOST_TICK_COST = 1.0;

/** Can the ship afford a `cost` energy spend right now? `cost <= 0` is
 *  always affordable. Floating-point slop is tolerated by a tiny epsilon so
 *  a pool sitting at exactly the cost (modulo regen rounding) still fires. */
export function canAfford(energy: number, cost: number): boolean {
  if (!(cost > 0)) return true;
  return energy + 1e-6 >= cost;
}

/**
 * Spend `cost` energy, returning the new pool value (clamped at 0). The
 * caller MUST gate with `canAfford` first — calling this when the pool is
 * short still clamps at 0 (never negative) but silently under-charges, so
 * the gate is what enforces "only fire when you can pay". `cost <= 0` is a
 * no-op.
 */
export function spendEnergy(energy: number, cost: number): number {
  if (!(cost > 0)) return energy;
  const next = energy - cost;
  return next > 0 ? next : 0;
}

/**
 * Advance the pool by one tick of regen, returning the new value (clamped at
 * `energyMax`). No post-spend delay — regen runs every tick. Already-full
 * pools are returned unchanged.
 */
export function regenEnergyStep(energy: number, energyMax: number, energyRegenRate: number): number {
  if (energy >= energyMax) return energyMax;
  const next = energy + energyRegenRate;
  return next < energyMax ? next : energyMax;
}

/**
 * Resolve the energy cost of firing a ship-kind's active slot once. The
 * slot's own `energyCost` override wins when present (e.g. the gunship's
 * two-barrel slot); otherwise it is the MAX `energyCost` across the slot's
 * mounts' weapons (homogeneous slots collapse to a single value, and the
 * MAX makes "drain once per slot" the twin-beam / twin-rack cost rather than
 * the sum). Returns 0 for a slot with no resolvable mounts (defensive).
 */
export function resolveSlotEnergyCost(kind: ShipKind, slotId?: string): number {
  const slot = resolveSlot(kind, slotId);
  if (slot?.energyCost !== undefined) return slot.energyCost;
  const mounts = resolveSlotMounts(kind, slotId);
  let cost = 0;
  for (let i = 0; i < mounts.length; i++) {
    const c = getWeapon(mounts[i]!.weaponId).energyCost;
    if (c > cost) cost = c;
  }
  return cost;
}
