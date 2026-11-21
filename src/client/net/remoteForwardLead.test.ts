/**
 * Remote forward prediction must reach the client's present at ANY input lead.
 *
 * The client draws remote ships on its own prediction timeline: each snapshot
 * resets a remote to its `serverTick` pose, the reconciler replays the lead
 * (`inputTick − serverTick` ≈ `leadTicks`) and the input loop then steps ~3
 * more ticks before the next 20 Hz snapshot. Every one of those ticks applies
 * the remote's held bits (`applyRemoteShipInputs`). The per-snapshot stall cap
 * was a fixed 8 ticks, sized when the lead sat on its 3-tick floor (3 + 3 + 2
 * spare). Once the lead is sized from the server's input margin (#1099) it
 * grows past 5 on any real link (~9 on a ~100 ms tunnel) and an idle client
 * that sends no input keeps its initial lead of 6: the cap then cut the last
 * held ticks of every snapshot, every snapshot landed a correction, and the
 * hysteresis guard switched forward prediction off
 * (`tests/e2e/remote-ship-held-thrust.spec.ts`: mean 13 u per snapshot).
 *
 * The flight drives the client's real functions as `ColyseusClient` does:
 * `preResetRemoteShips` → replay `lead` ticks (`applyRemoteShipInputs` +
 * `tick`) → `computeRemoteLerpOffsets` per snapshot, one live tick per server
 * tick between snapshots.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type ShipInput } from '../../core/physics/World.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages.js';
import { applyRemoteShipInputs, preResetRemoteShips, type PreResetRemoteCtx } from './snapshotRemoteSync.js';
import { computeRemoteLerpOffsets, type RemoteShipOffset } from './remoteLerpOffsets.js';
import { createRemotePredictionGuard } from './remotePredictionGuard.js';

const ID = 'R1';
const IDS = [ID];
const HELD: ShipInput = { thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false };
/** Same bound as the e2e spec (`MAX_MEAN_CORRECTION_U`). */
const MAX_MEAN_CORRECTION_U = 0.06;

function snapshotOf(server: PhysicsWorld, tick: number): SnapshotMessage {
  const s = server.getShipState(ID)!;
  return {
    type: 'snapshot',
    serverTick: tick,
    states: {
      [ID]: {
        x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel,
        playerId: 'pilot', isActive: true,
        lastInput: { thrust: true, turnLeft: true, turnRight: false, boost: false, reverse: false },
      },
    },
  } as unknown as SnapshotMessage;
}

/** Mean reset correction per snapshot for an observer running `lead` ticks
 *  ahead of the server while the remote holds thrust + turn. */
async function meanCorrection(lead: number): Promise<number> {
  const server = await PhysicsWorld.create();
  const client = await PhysicsWorld.create();
  server.spawnShip(ID, 0, 0, 'fighter');
  client.spawnShip(ID, 0, 0, 'fighter');
  const ctx: PreResetRemoteCtx = {
    predWorld: client,
    mirror: { ships: new Map() } as unknown as RenderMirror,
    preResetRemotePosScratch: new Map(),
    preResetRemotePosEntries: [],
    remoteLastInputs: new Map(),
    remoteForwardTicks: new Map(),
  };
  const guard = createRemotePredictionGuard();
  const offsets = new Map<string, RemoteShipOffset>();
  const stats = { remoteCorrTotalUnits: 0, remoteCorrSamples: 0 };
  const step = (): void => {
    applyRemoteShipInputs(client, IDS, ctx.remoteLastInputs, ctx.remoteForwardTicks, guard, lead);
    client.tick(1 / 60);
  };
  let tick = 0;
  const deliver = (measure: boolean): void => {
    const preReset = preResetRemoteShips(snapshotOf(server, tick), 'me', ctx);
    for (let i = 0; i < lead; i++) step(); // the reconciler's replay
    computeRemoteLerpOffsets({
      predWorld: client, preResetRemotePos: preReset, remoteShipOffsets: offsets, predGuard: guard,
      ...(measure ? { stats } : {}),
    });
  };
  // Reach a steady turn, then let the client pick the remote up.
  for (let i = 0; i < 30; i++) { server.applyInput(ID, HELD); server.tick(1 / 60); tick++; }
  client.setShipState(ID, server.getShipState(ID)!);
  deliver(false);
  for (let t = 1; t <= 150; t++) {
    server.applyInput(ID, HELD);
    server.tick(1 / 60);
    tick++;
    step(); // the live input loop keeps the client `lead` ticks ahead
    if (t % 3 === 0) deliver(t > 6);
  }
  server.dispose();
  client.dispose();
  return stats.remoteCorrTotalUnits / stats.remoteCorrSamples;
}

describe('remote forward prediction holds at the input lead the client runs', () => {
  beforeAll(async () => { await RAPIER.init(); });

  it('the 3-tick floor lead (LAN): no correction while the keys are held', async () => {
    expect(await meanCorrection(3)).toBeLessThan(MAX_MEAN_CORRECTION_U);
  });

  it('lead 6 (an idle observer keeps its initial lead): no correction while the keys are held', async () => {
    expect(await meanCorrection(6)).toBeLessThan(MAX_MEAN_CORRECTION_U);
  });

  it('lead 9 (the margin-sized lead on a ~100 ms tunnel): no correction while the keys are held', async () => {
    expect(await meanCorrection(9)).toBeLessThan(MAX_MEAN_CORRECTION_U);
  });
});
