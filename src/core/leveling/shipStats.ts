/**
 * Per-ship-instance stat upgrades — pure, zone-blind (Phase 4 WS-B2, plan:
 * effervescent-umbrella).
 *
 * A ship earns one upgrade POINT per level (WS-B1 grants the levels). The
 * player spends those points FREELY across a small stat pool (D11): +max hull,
 * +energy, +damage %, +top speed, +turn rate, +shield/regen. This module is the
 * single source of truth for:
 *
 *   - the stat-pool ids + their order (the upgrade modal renders them),
 *   - the per-point multiplier (a balance knob),
 *   - the available-point budget for a `level` (`pointBudget`),
 *   - validation of a `StatAlloc` against that budget (`isAllocValid`),
 *   - the pure derivation `StatAlloc → ShipStatMultipliers` (`deriveStatMultipliers`).
 *
 * CRITICAL (plan risk #1 — the canonical failure mode): the PHYSICS multipliers
 * (`topSpeed`, `turnRate`) feed the ONE seam where the per-tick movement clamps
 * live (`applyShipInput`), read IDENTICALLY by the server sim AND the client
 * prediction, so reconciliation stays clean (invariants #4 / #12). Same inputs ⇒
 * same `ShipStatMultipliers` on any caller; this module does no I/O and never
 * touches a body — it only computes scalar factors.
 *
 * The non-physics multipliers (`maxHull`, `energy`, `damage`, `shield`) are
 * applied server-authoritatively in the damage/shield/energy calcs (via the
 * `effectiveShip*` helpers below + `mul.damage` in the fire resolvers — NOT
 * physics-clamped, so unlike `topSpeed`/`turnRate` they need NO client-
 * prediction mirror); they ride the same per-instance `StatAlloc`, so this one
 * derivation feeds both surfaces. Each `effectiveShip*` helper is the SINGLE
 * source for its effective cap, so the seed (`ship.maxHealth` / shield-max /
 * energy-max) and the hull-pct denominator the client's bar reads always agree
 * (mirrors `effectiveStructureMaxHealth` in `structureLevel.ts`).
 *
 * Zone-pure (`src/core`): no allocation in any hot path beyond the small result
 * literal `deriveStatMultipliers` returns (called on spawn + on an upgrade — a
 * LOW-frequency discrete event, never per-tick, so invariant #14's hot-loop ban
 * does not bite; `applyShipInput` reads the already-derived multipliers, it does
 * not re-derive).
 */

/**
 * The stat-pool ids, in modal-render order. Append-only by intent — adding a
 * stat is a new id at the END; never reorder/remove (the order is the modal's
 * row order, and persisted `StatAlloc` maps are keyed by these ids).
 */
export const STAT_IDS = [
  'hull',
  'energy',
  'damage',
  'topSpeed',
  'turnRate',
  'shield',
] as const;

export type StatId = (typeof STAT_IDS)[number];

/** Per-ship spent allocation — `statId → points spent`. `{}` = nothing spent.
 *  Mirrors the roster `StatAlloc` (`PlayerShipStore`), kept structurally
 *  identical so the roster column IS this map. */
export type StatAlloc = Partial<Record<StatId, number>>;

/**
 * Per-point multiplier increment (D11 — "stat point ≈ +5 %/point"). A balance
 * knob: each point spent on a stat multiplies that stat's base by an extra
 * `STAT_POINT_FRAC` (so N points ⇒ `1 + N·STAT_POINT_FRAC`). Adjust on-device;
 * the architecture is unchanged when it moves.
 */
export const STAT_POINT_FRAC = 0.05;

/**
 * Available upgrade points at a given level. A fresh ship is level 1 with 0
 * points; each level-up grants exactly one point (D11 — "points earned per
 * level"). Defensive: a sub-1 level yields 0.
 */
export function pointBudget(level: number): number {
  if (!(level > 1)) return 0;
  return Math.floor(level) - 1;
}

/** Sum of points spent across an allocation. Ignores negative / non-finite
 *  entries (treated as 0) so a malformed wire map can't under-count the spend
 *  and sneak past the budget gate. */
export function spentPoints(alloc: StatAlloc): number {
  let total = 0;
  for (const id of STAT_IDS) {
    const n = alloc[id];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += Math.floor(n);
  }
  return total;
}

/**
 * Validate an allocation against the budget for `level`. Rejects when:
 *   - any entry is negative / non-integer / non-finite, OR
 *   - any key is not a known `StatId`, OR
 *   - the total spend exceeds `pointBudget(level)`.
 *
 * This is the SERVER's authoritative gate (the budget can't be exceeded) and is
 * pure so the client can pre-validate the modal identically.
 */
export function isAllocValid(alloc: StatAlloc, level: number): boolean {
  const budget = pointBudget(level);
  let total = 0;
  for (const key of Object.keys(alloc)) {
    if (!(STAT_IDS as readonly string[]).includes(key)) return false;
    const n = (alloc as Record<string, unknown>)[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return false;
    total += n;
  }
  return total <= budget;
}

/**
 * Effective per-stat multipliers derived from a spent allocation. Each is
 * `1 + points·STAT_POINT_FRAC`; an unspent stat is exactly `1` (no-op). The
 * PHYSICS pair (`topSpeed`, `turnRate`) feeds `applyShipInput`; the rest feed
 * the server-side damage/shield/energy calcs.
 */
export interface ShipStatMultipliers {
  /** Multiplies `maxHealth` (server-authoritative hull cap). */
  maxHull: number;
  /** Multiplies `energyMax` (server-authoritative energy pool). */
  energy: number;
  /** Multiplies outgoing weapon damage (server-authoritative). */
  damage: number;
  /** Multiplies `maxSpeed` AND `thrustImpulse` (so the ship can actually reach
   *  the raised cap). Physics — read by `applyShipInput` on BOTH sides. */
  topSpeed: number;
  /** Multiplies `maxAngvel` (yaw rate). Physics — read by `applyShipInput`. */
  turnRate: number;
  /** Multiplies `shieldMax` AND `shieldRegenRate` (server-authoritative). */
  shield: number;
}

/** The identity multiplier set — every factor 1 (a fresh, un-upgraded ship). */
export const NEUTRAL_STAT_MULTIPLIERS: Readonly<ShipStatMultipliers> = Object.freeze({
  maxHull: 1,
  energy: 1,
  damage: 1,
  topSpeed: 1,
  turnRate: 1,
  shield: 1,
});

/** `1 + clamp(points, ≥0)·STAT_POINT_FRAC`. A malformed (negative / NaN) entry
 *  resolves to the neutral `1`. */
function factorFor(alloc: StatAlloc, id: StatId): number {
  const n = alloc[id];
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return 1 + Math.floor(n) * STAT_POINT_FRAC;
  return 1;
}

/**
 * Derive the per-stat multipliers from a spent allocation. Pure, allocation of
 * one small literal (low-frequency — spawn / upgrade only). An empty / undefined
 * allocation returns multipliers structurally equal to `NEUTRAL_STAT_MULTIPLIERS`
 * (every factor 1), so an un-upgraded ship is byte-identical to pre-WS-B2.
 */
export function deriveStatMultipliers(alloc: StatAlloc | undefined): ShipStatMultipliers {
  if (alloc === undefined) {
    return {
      maxHull: 1,
      energy: 1,
      damage: 1,
      topSpeed: 1,
      turnRate: 1,
      shield: 1,
    };
  }
  return {
    maxHull: factorFor(alloc, 'hull'),
    energy: factorFor(alloc, 'energy'),
    damage: factorFor(alloc, 'damage'),
    topSpeed: factorFor(alloc, 'topSpeed'),
    turnRate: factorFor(alloc, 'turnRate'),
    shield: factorFor(alloc, 'shield'),
  };
}

/**
 * Leveled effective max HULL for a player ship (`baseMaxHealth · mul.maxHull`,
 * rounded to a whole hull point — the schema/store keep hull as integers). The
 * SINGLE helper the server's `ship.maxHealth` seed AND the hull-pct denominator
 * read, so an upgraded ship's bar always reads correctly on the client.
 * Un-upgraded ⇒ `Math.round(baseMaxHealth)` (byte-identical for whole bases).
 */
export function effectiveShipMaxHealth(baseMaxHealth: number, alloc: StatAlloc | undefined): number {
  return Math.round(baseMaxHealth * factorFor(alloc ?? {}, 'hull'));
}

/**
 * Leveled effective SHIELD max for a player ship (`baseShieldMax · mul.shield`,
 * rounded). The single helper every server shield read-site uses — the spawn
 * seed, the `tickShieldRegen` cap, and the `DamageEvent.shieldMax` the client's
 * shield bar divides by — so they always agree.
 */
export function effectiveShipShieldMax(baseShieldMax: number, alloc: StatAlloc | undefined): number {
  return Math.round(baseShieldMax * factorFor(alloc ?? {}, 'shield'));
}

/**
 * Leveled effective ENERGY max for a player ship (`baseEnergyMax · mul.energy`,
 * rounded). The single helper the energy spawn seed, the per-tick regen cap, and
 * the fire-path affordance gate read, so an energy-upgraded ship's pool is
 * larger end-to-end.
 */
export function effectiveShipEnergyMax(baseEnergyMax: number, alloc: StatAlloc | undefined): number {
  return Math.round(baseEnergyMax * factorFor(alloc ?? {}, 'energy'));
}
