/**
 * Passive drone AI — emits zero impulse and never fires. Used by engineering
 * rooms like `shield-test` where the player wants a stationary target gallery
 * (verify shield bubble math, ram drones, shoot beams at their shields) WITHOUT
 * the drones turning hostile and shooting back.
 *
 * `markHostile` / `purgeHostility` / `isHostileToPlayer` are intentionally
 * omitted — the controller's `markHostile` call from `DamageRouter`
 * still mutates the AiController's own `hostileTo` set, but since this
 * behaviour's `tick` never reads it, the drone stays stationary regardless.
 * Drones still take damage and die normally — the only thing suppressed is
 * the COMBAT state transition that would otherwise drive pursuit + fire.
 */

import type { AiEntity, AiIntent, AiWorldView, IAiBehaviour } from '../contracts/IAiBehaviour.js';

const ZERO_INTENT: AiIntent = Object.freeze({ fx: 0, fy: 0, torque: 0 });

export class PassiveDroneBehaviour implements IAiBehaviour {
  tick(_self: AiEntity, _view: AiWorldView): AiIntent {
    return ZERO_INTENT;
  }
}
