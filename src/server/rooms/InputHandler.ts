/**
 * `onMessage('input')` handler — lifted out of SectorRoom.onCreate so
 * the rate-limit / zod-parse / SAB-post / boost-thrust set update /
 * diagnostic event paths read together as one input-pipeline unit.
 *
 *   - Per-tick rate limit: max `MAX_INPUTS_PER_TICK` inputs per
 *     entity (Phase 4 micro rate limit).
 *   - Strict zod parse via `InputMessageSchema`; malformed packets
 *     are dropped with a sampled warn.
 *   - SAB post via `INPUT` worker command (the worker writes the
 *     claim into the per-slot input queue).
 *   - `boostingPlayers` / `thrustingPlayers` set updates so the
 *     snapshot broadcasts the visual-exhaust state to observers.
 *     boostingPlayers requires BOTH `boost` AND `thrust` (shift alone
 *     doesn't visually do anything); thrustingPlayers is the superset.
 *   - Sampled `input_received` diagnostic (every 30th tick + any
 *     tick-delta over 5 — surfaces client/server clock drift).
 */

import type { Client } from 'colyseus';
import { InputMessageSchema } from '../../shared-types/messages.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { canAfford, BOOST_TICK_COST } from '../../core/combat/Energy.js';
import type pino from 'pino';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

export interface InputHandlerCtx {
  sessionToPlayer: Map<string, string>;
  inputCountThisTick: Map<string, number>;
  maxInputsPerTick: number;
  playerToSlot: Map<string, number>;
  boostingPlayers: Set<string>;
  thrustingPlayers: Set<string>;
  postToWorker: (cmd: WorkerCmd) => void;
  serverTick: () => number;
  /** Energy-gate for boost (weapons/energy/AI overhaul §3.1). Returns the
   *  player's current energy pool, or `undefined` if the ship is gone. The
   *  handler strips the boost bit BEFORE forwarding to the worker when the
   *  pool can't afford a tick of boost — the worker stays oblivious (no new
   *  command, no SAB field). */
  shipEnergyOf: (playerId: string) => number | undefined;
  logger: pino.Logger;
}

export function makeInputHandler(
  ctx: InputHandlerCtx,
): (client: Client, raw: unknown) => void {
  return (client, raw) => {
    const playerId = ctx.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    const count = ctx.inputCountThisTick.get(playerId) ?? 0;
    if (count >= ctx.maxInputsPerTick) return;
    ctx.inputCountThisTick.set(playerId, count + 1);

    const result = InputMessageSchema.safeParse(raw);
    if (!result.success) {
      ctx.logger.warn({ sessionId: client.sessionId }, 'malformed input message');
      return;
    }
    const { tick, thrust, turnLeft, turnRight } = result.data;
    let boost = result.data.boost ?? false;
    const reverse = result.data.reverse ?? false;
    // Energy-gate boost: strip the bit before it reaches the worker when the
    // ship can't afford a tick of boost. One owner / two sites, same tick —
    // this gate prevents applying a boost the drain (tickEnergy) would make
    // negative (Invariant #12). The worker is unchanged.
    if (boost && !canAfford(ctx.shipEnergyOf(playerId) ?? 0, BOOST_TICK_COST)) {
      boost = false;
    }
    const slot = ctx.playerToSlot.get(playerId);
    if (slot !== undefined) {
      ctx.postToWorker({
        type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight, boost, reverse,
      });
    }
    // Boost is now an independent forward thrust along the ship's facing,
    // applied whenever boost is held (energy-affordable — the bit was stripped
    // above when the pool couldn't afford a tick). It no longer requires
    // thrust. `boostingPlayers` drives both the per-tick energy drain
    // (tickEnergy) and the exhaust trail (renderer layers it on top of the
    // baseline thrust flame).
    if (boost) ctx.boostingPlayers.add(playerId);
    else ctx.boostingPlayers.delete(playerId);
    if (thrust) ctx.thrustingPlayers.add(playerId);
    else ctx.thrustingPlayers.delete(playerId);
    // Diagnostic: log every 30th input plus any input whose claimed tick is
    // far from the current server tick (indicates clock drift).
    const serverTick = ctx.serverTick();
    const tickDelta = tick - serverTick;
    if ((tick % 30) === 0 || Math.abs(tickDelta) > 5) {
      serverLogEvent('input_received', {
        playerId,
        claimedTick: tick,
        serverTick,
        tickDelta,
        thrust,
        turnLeft,
        turnRight,
      });
    }
  };
}
