/**
 * Build a catalogue ship kind: validate, then scale it by the global ship
 * scale × its own `sizeScale` (engineering test hulls stay 1×). Every family
 * file defines its kinds through this, so every consumer of the catalogue
 * sees scaled ships and the 1× authoring values live only in the source.
 *
 * `unscaledShipKind(id)` returns the authored 1× kind (tests sweep scales
 * from it with `scaleShipKind`).
 */
import { ShipKindSchema, type ShipKind } from '../shipKinds/types.js';
import { effectiveScale, scaleShipKind } from './tuning.js';
import { KIND_SCALE_OVERRIDES } from './config.js';
import { applyArcadeHandling } from './arcadeHandling.js';

const UNSCALED = new Map<string, ShipKind>();

/**
 * Energy pool multiplier (owner, 2026-11-14): "increasing the total pool of
 * energy so at the start of fights after a lull there is lots of boosting,
 * then as a fight drags ships run out of boost. This also gives people joining
 * late an advantage. Don't boost regen."
 *
 * One row for every kind, whoever flies it (the pool belongs to the
 * ship, capitals included), × `energyMax` only. `energyRegenRate`, `BOOST_TICK_COST` and
 * weapon `energyCost` are untouched, so a dragging fight settles back to the
 * same regen-limited sustain while a rested ship opens with twice the
 * boost / fire reserve (fighter: 3.3 s → 6.7 s of continuous boost from
 * full). The family files keep the authored 1× pool. Server, client HUD and
 * client prediction all read the scaled record (invariant #15).
 */
export const ENERGY_POOL_MUL = 2;

function withEnergyPool(kind: ShipKind): ShipKind {
  return kind.energyMax === undefined ? kind : { ...kind, energyMax: kind.energyMax * ENERGY_POOL_MUL };
}

export function defineShipKind(raw: unknown): ShipKind {
  const parsed = ShipKindSchema.parse(raw);
  UNSCALED.set(parsed.id, parsed);
  // A per-kind override (EQX_SHIP_KIND_SCALE) retunes one kind's size, class
  // and engines without a catalogue edit (capital sandbox / tuning).
  const o = KIND_SCALE_OVERRIDES.get(parsed.id);
  const kind: ShipKind = o === undefined ? parsed : {
    ...parsed,
    sizeScale: (parsed.sizeScale ?? 1) * o.sizeScale,
    ...(o.sizeClass ? { sizeClass: o.sizeClass } : {}),
    ...(o.thrusters ? { thrusters: o.thrusters } : {}),
  };
  // Arcade (Micro Machines) handling + toughness layer, per handling class
  // (owner direction 2026-11-13; `arcadeHandling.ts`), then the energy pool
  // (every kind, `ENERGY_POOL_MUL`).
  return withEnergyPool(applyArcadeHandling(scaleShipKind(kind, effectiveScale(kind)), parsed));
}

/** The authored (1×) kind, before the catalogue scaled it. */
export function unscaledShipKind(id: string): ShipKind | undefined {
  return UNSCALED.get(id);
}

/** Every authored kind, in definition order. */
export function unscaledShipKinds(): ShipKind[] {
  return [...UNSCALED.values()];
}

/**
 * Build a capital-ship kind (capital-ship R&D): validate, but do NOT scale.
 * Capitals are authored in game units from the WW2-grounded solver
 * (`capitalReference.ts`), with their own physics, so neither the global ship
 * scale nor the generic size-based motion model applies. `appliedScale: 1`
 * marks the record as final for every later `scaleShipKind`.
 */
export function defineCapitalShipKind(raw: unknown): ShipKind {
  const parsed = ShipKindSchema.parse(raw);
  UNSCALED.set(parsed.id, parsed);
  return withEnergyPool(applyArcadeHandling({ ...parsed, appliedScale: 1 }, parsed));
}
