/**
 * Warp route check (warp S2): the input handler asks the room's route check
 * with the PILOT (its pose and hull decide the line), forwards only an
 * accepted warp point to the worker, and drops a rejected one.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import type pino from 'pino';
import { makeInputHandler, type InputHandlerCtx } from './InputHandler.js';
import { MalformedMessageTracker } from './MalformedMessageTracker.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

function setup(valid: (pid: string, x: number, y: number) => boolean) {
  const posted: WorkerCmd[] = [];
  const asked: Array<[string, number, number]> = [];
  const requests: Array<[string, number, number]> = [];
  const ctx: InputHandlerCtx = {
    sessionToPlayer: new Map([['sess-1', 'player-1']]),
    inputCountThisTick: new Map(),
    maxInputsPerTick: Number.POSITIVE_INFINITY,
    playerToSlot: new Map([['player-1', 0]]),
    boostingPlayers: new Set(),
    thrustingPlayers: new Set(),
    postToWorker: (cmd) => { posted.push(cmd); },
    serverTick: () => 100,
    shipEnergyOf: () => 100,
    validWarpPoint: (pid, x, y) => { asked.push([pid, x, y]); return valid(pid, x, y); },
    onWarpRequest: (pid, x, y) => { requests.push([pid, x, y]); },
    logger: { warn: () => {} } as unknown as pino.Logger,
    malformed: new MalformedMessageTracker({ warn: () => {} }),
  };
  return { handler: makeInputHandler(ctx), posted, asked, requests };
}

const client = { sessionId: 'sess-1' } as unknown as Client;
const input = (warpX: number, warpY: number) =>
  ({ type: 'input', tick: 100, thrust: false, turnLeft: false, turnRight: false, warpX, warpY });

describe('input handler — warp route check', () => {
  it('asks with the pilot and forwards an accepted point', () => {
    const { handler, posted, asked, requests } = setup(() => true);
    handler(client, input(4_000, 0));
    expect(asked).toEqual([['player-1', 4_000, 0]]);
    expect(requests).toEqual([['player-1', 4_000, 0]]);
    expect(posted[0]).toMatchObject({ type: 'INPUT', warpX: 4_000, warpY: 0 });
  });

  it('drops a rejected point (blocked line or random point): input still flows, no warp', () => {
    const { handler, posted, requests } = setup((_p, x) => x === 4_000);
    handler(client, input(9_000, 0));
    expect(requests).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty('warpX');
  });
});
