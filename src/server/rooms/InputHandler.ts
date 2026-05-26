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
    const boost = result.data.boost ?? false;
    const reverse = result.data.reverse ?? false;
    const slot = ctx.playerToSlot.get(playerId);
    if (slot !== undefined) {
      ctx.postToWorker({
        type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight, boost, reverse,
      });
    }
    // Boost = "shift held AND thrust held". Renderer layers boost on top of
    // the baseline thrust flame; shift alone doesn't visually do anything.
    if (boost && thrust) ctx.boostingPlayers.add(playerId);
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
