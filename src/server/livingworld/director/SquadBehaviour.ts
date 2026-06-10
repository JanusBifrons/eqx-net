/**
 * SquadBehaviour — the squad strategic "brain" (wave-system plan, Phase 3).
 *
 * A pure Strategy (Open/Closed seam): given a squad's record + a per-tick
 * decision context, return the ACTION the director should execute this tick.
 * The director owns the side effects (issue the coordinated warp, mark members
 * hostile, purge + retreat); the behaviour owns only the DECISION. New squad
 * tactics (flanking, harassment, siege) are new `SquadBehaviour` classes — the
 * director composes one and never branches on squad "type".
 *
 * Individual drones still fly + pick targets independently via
 * `HostileDroneBehaviour`; this is the layer ABOVE that — the squad as one
 * strategic unit (warp together, go hostile together, retreat together).
 */

import type { SquadRecord } from './SquadPool.js';

export type SquadAction =
  | { kind: 'hold' }
  | { kind: 'warp'; to: string }
  | { kind: 'attack'; factionId: string }
  | { kind: 'retreat' };

export interface SquadDecisionContext {
  /** Members currently active (spawned + alive) in the squad's `sectorKey`. */
  membersInSector: number;
  /** Members active anywhere. */
  membersActive: number;
  /** Whether the squad's assigned faction is still a live wave target. False ⇒
   *  the wave was de-escalated (Phase 6) and the squad must retreat. Only
   *  meaningful while the squad has a `targetFactionId`. */
  factionStillHostile: boolean;
}

export interface SquadBehaviour {
  decide(squad: SquadRecord, ctx: SquadDecisionContext): SquadAction;
}

/**
 * v1 wave behaviour: form up, wait for a wave assignment, warp to the target
 * faction's sector, attack until the wave de-escalates, then retreat.
 *
 * State → action:
 *   - forming / retreating  → hold (the director manages spawn-in / return-to-idle).
 *   - idle, assigned        → warp to the target sector.
 *   - idle, unassigned      → hold.
 *   - warping, arrived      → attack (members present in the target sector).
 *   - warping, not arrived  → hold (still spooling / in flight).
 *   - attacking             → attack (the director re-pulses hostility each tick).
 *   - assigned & faction no longer hostile → retreat (overrides warp/attack).
 */
export class WaveSquadBehaviour implements SquadBehaviour {
  decide(squad: SquadRecord, ctx: SquadDecisionContext): SquadAction {
    // De-escalation overrides an in-flight or active engagement.
    if (
      squad.targetFactionId !== null &&
      !ctx.factionStillHostile &&
      (squad.state === 'warping' || squad.state === 'attacking')
    ) {
      return { kind: 'retreat' };
    }

    switch (squad.state) {
      case 'forming':
      case 'retreating':
        return { kind: 'hold' };
      case 'idle':
        return squad.targetFactionId !== null
          ? { kind: 'warp', to: squad.sectorKey }
          : { kind: 'hold' };
      case 'warping':
        return ctx.membersInSector > 0 && squad.targetFactionId !== null
          ? { kind: 'attack', factionId: squad.targetFactionId }
          : { kind: 'hold' };
      case 'attacking':
        return squad.targetFactionId !== null
          ? { kind: 'attack', factionId: squad.targetFactionId }
          : { kind: 'retreat' };
    }
  }
}
