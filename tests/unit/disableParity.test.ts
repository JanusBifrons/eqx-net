/**
 * v4 A — the DISABLED input gate is one contract on both sides of the wire
 * (invariant #15). A disabled ship's movement bits are stripped by the shared
 * `gateDisabledInput`: the server's `InputHandler` before the physics worker,
 * the client's `tickPhysics` before predicting. If either side stops using it
 * (or gates differently), prediction and authority disagree for the whole
 * disable, so this test fails when:
 *  - the shared gate stops clearing a bit,
 *  - the server handler stops honouring `isDisabled`,
 *  - either side's source stops calling the shared gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Client } from 'colyseus';
import type pino from 'pino';
import { gateDisabledInput, type ControlBits } from '../../src/core/combat/disable.js';
import { makeInputHandler } from '../../src/server/rooms/InputHandler.js';
import { MalformedMessageTracker } from '../../src/server/rooms/MalformedMessageTracker.js';
import type { WorkerCmd } from '../../src/server/rooms/PhysicsWorkerProxy.js';

const ALL_ON: ControlBits = { thrust: true, turnLeft: true, turnRight: true, boost: true, reverse: true };

describe('the disabled input gate (v4 A, #15)', () => {
  it('clears every movement bit when disabled, and nothing when not', () => {
    const off = { ...ALL_ON };
    expect(gateDisabledInput(true, off)).toBe(true);
    expect(off).toEqual({ thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false });
    const on = { ...ALL_ON };
    expect(gateDisabledInput(false, on)).toBe(false);
    expect(on).toEqual(ALL_ON);
  });

  it('the server strips a disabled pilot’s input before the physics worker', () => {
    const posted: WorkerCmd[] = [];
    let disabled = true;
    const handler = makeInputHandler({
      sessionToPlayer: new Map([['s', 'p']]),
      inputCountThisTick: new Map(),
      maxInputsPerTick: Number.POSITIVE_INFINITY,
      playerToSlot: new Map([['p', 0]]),
      boostingPlayers: new Set(),
      thrustingPlayers: new Set(),
      postToWorker: (cmd) => posted.push(cmd),
      serverTick: () => 1,
      shipEnergyOf: () => 1000,
      isDisabled: () => disabled,
      logger: { warn: () => {} } as unknown as pino.Logger,
      malformed: new MalformedMessageTracker({ warn: () => {} }),
    });
    const client = { sessionId: 's' } as unknown as Client;
    const msg = { type: 'input', tick: 1, thrust: true, turnLeft: true, turnRight: false, boost: true, reverse: false };
    handler(client, msg);
    expect(posted[0]).toMatchObject({ thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false });
    disabled = false;
    handler(client, { ...msg, tick: 2 });
    expect(posted[1]).toMatchObject({ thrust: true, turnLeft: true, boost: true });
  });

  it('both sides call the shared gate (no private copy on either side)', () => {
    const server = readFileSync(new URL('../../src/server/rooms/InputHandler.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../src/client/net/ColyseusClient.ts', import.meta.url), 'utf8');
    expect(server).toContain('gateDisabledInput(');
    // The per-tick path and the idle-heartbeat path both gate.
    expect(client.split('gateDisabledInput(').length - 1).toBeGreaterThanOrEqual(2);
  });
});
