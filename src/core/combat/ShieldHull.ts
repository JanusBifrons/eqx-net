/**
 * Two-layer shield + hull damage model (pure logic).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │ SERVER-AUTHORITY-ONLY. Unlike the shared `HostileDroneBehaviour`     │
 * │ brain (which runs identically on server AND client for lockstep      │
 * │ prediction), the damage/regen functions here are called EXCLUSIVELY  │
 * │ by the authoritative server (`SectorRoom`). The client must NEVER    │
 * │ run them — predicting the shield 0-cross client-side would flap the  │
 * │ collider (circle⇄polygon) every RTT. The client only consumes the   │
 * │ authoritative shield value (discrete damage/broke/restored events)   │
 * │ and tweens the HUD bar cosmetically. This module lives in `src/core` │
 * │ purely for testability + shared types. Do NOT "share it like the AI".│
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Rules (locked design decisions):
 *  - Shield fully absorbs a hit while `shield > 0`. The final hit before
 *    the shield drops is FULLY absorbed — NO spillover. A 1 HP shield eats
 *    an arbitrarily large single hit and then is 0; the overkill is lost.
 *  - Only once `shield === 0` does damage reach the hull. Hull never heals
 *    and persists; at `hull <= 0` the ship explodes (caller's concern).
 *  - ANY damage (to shield OR hull) resets the regen delay timer.
 *  - Halo regen: after `shieldRegenDelayTicks` of zero damage, shield
 *    refills by `shieldRegenRate` per tick until `shieldMax`.
 *
 * The shield 0-cross transitions reported here (`brokeThisHit`,
 * `restoredThisStep`) are what drive the authoritative collider swap
 * (`SET_HULL_EXPOSED`) and the discrete `SHIELD_BROKEN` / `SHIELD_RESTORED`
 * bus events.
 */

/** Mutable per-entity layered-health state owned by the server. */
export interface ShieldHullState {
  /** Current shield. `0` ⇒ hull is exposed (polygon collision). */
  shield: number;
  /** Current hull (today's `health`). `<= 0` ⇒ destroyed. */
  hull: number;
  /** Server tick of the most recent damage of ANY kind. Regen waits
   *  `shieldRegenDelayTicks` past this. */
  lastDamageTick: number;
}

/** The three per-kind shield knobs (subset of `ShipKind`). */
export interface ShieldRegenParams {
  shieldMax: number;
  shieldRegenDelayTicks: number;
  shieldRegenRate: number;
}

export interface DamageResult {
  /** Which layer this hit landed on. */
  hitLayer: 'shield' | 'hull';
  /** Shield was `> 0` before and is exactly `0` after THIS hit. Triggers
   *  the collider→polygon swap + `SHIELD_BROKEN`. */
  brokeThisHit: boolean;
  /** Amount the shield actually absorbed (≤ damage; the no-spillover
   *  overkill is NOT counted here). */
  shieldAbsorbed: number;
  /** Amount the hull actually lost (0 while the shield was up). */
  hullDamage: number;
}

export interface RegenResult {
  /** Shield was `0` before and is `> 0` after this step. Triggers the
   *  collider→circle swap + `SHIELD_RESTORED`. */
  restoredThisStep: boolean;
  /** Shield reached full (`shieldMax`) on this step (was below before).
   *  Used for the discrete "regen complete" client broadcast. */
  regenComplete: boolean;
  /** Shield value changed at all this step (worth a throttle-free
   *  discrete broadcast decision upstream). */
  regenerated: boolean;
}

/**
 * Apply one damage event. Mutates `state` in place and returns what
 * happened. `damage <= 0` is a no-op that does NOT reset the regen timer
 * (a 0-damage "hit" must not deny a ship its regen).
 */
export function applyLayeredDamage(
  state: ShieldHullState,
  damage: number,
  nowTick: number,
): DamageResult {
  if (!(damage > 0)) {
    return {
      hitLayer: state.shield > 0 ? 'shield' : 'hull',
      brokeThisHit: false,
      shieldAbsorbed: 0,
      hullDamage: 0,
    };
  }

  const prevShield = state.shield;

  if (prevShield > 0) {
    // Shield fully absorbs. No spillover even when damage > shield: the
    // overkill is discarded (1 HP shield eats an arbitrarily large hit).
    const newShield = Math.max(0, prevShield - damage);
    state.shield = newShield;
    state.lastDamageTick = nowTick;
    return {
      hitLayer: 'shield',
      brokeThisHit: newShield === 0,
      shieldAbsorbed: prevShield - newShield,
      hullDamage: 0,
    };
  }

  // Shield already down — hull takes it (clamped at 0).
  const newHull = Math.max(0, state.hull - damage);
  const hullDamage = state.hull - newHull;
  state.hull = newHull;
  state.lastDamageTick = nowTick;
  return { hitLayer: 'hull', brokeThisHit: false, shieldAbsorbed: 0, hullDamage };
}

/**
 * Advance shield regen by one tick. Mutates `state`. No-op (and reports
 * nothing changed) when the ship is dead, the shield is already full, or
 * the post-damage delay has not elapsed.
 */
export function regenStep(
  state: ShieldHullState,
  kind: ShieldRegenParams,
  nowTick: number,
): RegenResult {
  const none: RegenResult = {
    restoredThisStep: false,
    regenComplete: false,
    regenerated: false,
  };
  if (state.hull <= 0) return none; // dead ships do not regen
  if (state.shield >= kind.shieldMax) return none; // already full
  if (nowTick - state.lastDamageTick < kind.shieldRegenDelayTicks) return none;

  const prevShield = state.shield;
  const newShield = Math.min(kind.shieldMax, prevShield + kind.shieldRegenRate);
  state.shield = newShield;
  return {
    restoredThisStep: prevShield === 0 && newShield > 0,
    regenComplete: prevShield < kind.shieldMax && newShield >= kind.shieldMax,
    regenerated: newShield !== prevShield,
  };
}
