/**
 * Pure decision for re-anchoring the local predWorld body's PHYSICS stat
 * multipliers from the authoritative own-ship `statAlloc` snapshot slice
 * (Phase 4 WS-B2). Extracted from `ColyseusClient.applyLocalStatAlloc` so the
 * "did the allocation change + what multipliers" branch is unit-testable without
 * a predWorld (the Phase-A3 "decision logic is pure" rule + risk #1 lock).
 *
 * The MULTIPLIER math itself is `deriveStatMultipliers` (core) — read identically
 * to the server worker, so prediction scales movement the same on both sides.
 * This module only decides WHEN to re-push (a stable key guard so identical
 * allocations don't re-push every snapshot) and computes the physics pair.
 */

import { deriveStatMultipliers, type StatAlloc } from '../../core/leveling/shipStats.js';
import type { ShipInputMultipliers } from '../../core/physics/applyShipInput.js';

export interface StatAllocReanchor {
  /** Stable JSON key for the allocation (`''` = empty / un-upgraded). Caller
   *  stores it to suppress re-pushing an identical allocation. */
  key: string;
  /** True when `key` differs from `prevKey` (a re-push is warranted). */
  changed: boolean;
  /** The PHYSICS multipliers to push, or `undefined` to RESET to the
   *  un-upgraded factors (empty / absent allocation). Only meaningful when
   *  `changed` is true. */
  mul: ShipInputMultipliers | undefined;
}

/** Canonical stable key for an allocation (`''` when empty / absent). */
export function statAllocKey(alloc: Record<string, number> | undefined): string {
  return alloc !== undefined && Object.keys(alloc).length > 0 ? JSON.stringify(alloc) : '';
}

/**
 * Decide whether + how to re-anchor the local body's physics multipliers given
 * the authoritative `alloc` slice and the previously-applied `prevKey`.
 */
export function decideStatAllocReanchor(
  alloc: Record<string, number> | undefined,
  prevKey: string,
): StatAllocReanchor {
  const key = statAllocKey(alloc);
  const changed = key !== prevKey;
  const mul = key === '' ? undefined : toPhysicsMul(alloc as StatAlloc);
  return { key, changed, mul };
}

/** Derive ONLY the physics pair (topSpeed/turnRate) the input seam reads. */
function toPhysicsMul(alloc: StatAlloc): ShipInputMultipliers {
  const m = deriveStatMultipliers(alloc);
  return { topSpeed: m.topSpeed, turnRate: m.turnRate };
}
