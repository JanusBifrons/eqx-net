/**
 * Passive drone AI — emits zero impulse and never fires. Used by engineering
 * rooms like `shield-test` where the player wants a stationary target gallery
 * (verify shield bubble math, ram drones, shoot beams at their shields) WITHOUT
 * the drones turning hostile and shooting back.
 *
 * It still KEEPS hostility (`markHostile` / `purgeHostility` /
 * `isHostileToPlayer`), but only as a ledger: `tick` never reads it, so the
 * drone stays stationary and never fires. Lock-to-fire needs the ledger: a
 * pilot's AUTO group locks only drones hostile to them (`npcHostileTo` →
 * `isEntityHostileToPlayer`), so a passive drone shot at, or marked by
 * `startHostile`, must answer "hostile" or AUTO never engages it. Drones
 * still take damage and die normally.
 */

import type { AiEntity, AiIntent, AiWorldView, IAiBehaviour } from '../contracts/IAiBehaviour.js';

const ZERO_INTENT: AiIntent = Object.freeze({ fx: 0, fy: 0, torque: 0 });

export class PassiveDroneBehaviour implements IAiBehaviour {
  /** Players this drone counts as hostile to (ledger only; never acted on).
   *  Deliberately NOT named `hostileTo`: the mount ticker duck-reads that
   *  field to aim turrets, and a passive drone must never aim or fire. */
  private readonly hostile = new Set<string>();

  tick(_self: AiEntity, _view: AiWorldView): AiIntent {
    return ZERO_INTENT;
  }

  markHostile(playerId: string, _atTick: number): void {
    this.hostile.add(playerId);
  }

  purgeHostility(playerId: string): void {
    this.hostile.delete(playerId);
  }

  isHostileToPlayer(playerId: string): boolean {
    return this.hostile.has(playerId);
  }
}
