/**
 * RTS Part A S1 — the remote ship's input bits, both sides of the wire (#15).
 *
 * Bug (every remote ship): the server dropped a ship's `lastInput` from the
 * snapshot whenever the bits were UNCHANGED since the last send to that viewer
 * (a per-recipient dedupe), while the client DELETED its copy of the bits when
 * the field was absent. So a remote pilot holding thrust or a turn was
 * forward-predicted for one snapshot, then coasted: the body fell behind
 * between snapshots and the drawn ship jumped forward at 20 Hz.
 *
 * Contract now: `lastInput` rides every snapshot while any bit is held, and is
 * absent exactly when the ship's controls are idle (absent = idle). Nothing to
 * dedupe, nothing to carry, and a dropped snapshot can never leave a control
 * stuck on: the next snapshot says the whole truth.
 *
 * This test runs a REAL room with two pilots and feeds every snapshot the
 * observer receives through the client's real `preResetRemoteShips`:
 *   1. the other pilot holds thrust → the client keeps the thrust bits on
 *      every snapshot (RED before: the second snapshot omitted them);
 *   2. the pilot lets go and the snapshot that carries the change is DROPPED
 *      (the coalescer keeps only the newest) → the client still ends up idle
 *      (RED for a client-only "absent = keep previous" fix).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import RAPIER from '@dimforge/rapier2d-compat';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages/snapshotMessages.js';
import { PhysicsWorld } from '../../../src/core/physics/World.js';
import type { RenderMirror } from '../../../src/core/contracts/IRenderer.js';
import { preResetRemoteShips, type PreResetRemoteCtx } from '../../../src/client/net/snapshotRemoteSync.js';

type Bits = { thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean };

function input(thrust: boolean): Record<string, unknown> {
  return { type: 'input', tick: 0, thrust, turnLeft: false, turnRight: false };
}

describe('remote input bits — held controls keep predicting, a dropped release never sticks', () => {
  let harness: SectorTestHarness;
  beforeAll(async () => { await RAPIER.init(); });
  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('two pilots: the observer forward-predicts held thrust on every snapshot and goes idle after a dropped release', { timeout: 20_000 }, async () => {
    const pilotId = randomUUID();
    const observerId = randomUUID();
    const pilot = await harness.connectActive(pilotId);
    const observer = await harness.connectActive(observerId);

    const snaps: SnapshotMessage[] = [];
    observer.onMessage('snapshot', (s: unknown) => { snaps.push(s as SnapshotMessage); });

    // Hold thrust: one message; the worker re-applies the held input every tick.
    pilot.send('input', input(true));
    const holdStart = Date.now();
    while (Date.now() - holdStart < 6_000) {
      const keyed = snaps.filter((s) => Object.values(s.states).some((e) => e.playerId === pilotId && e.lastInput?.thrust));
      if (keyed.length >= 1 && snaps.length >= 10) break;
      await harness.advance(25);
    }
    // The first snapshot showing the thrust, plus everything after it.
    const firstIdx = snaps.findIndex((s) => Object.values(s.states).some((e) => e.playerId === pilotId && e.lastInput?.thrust));
    expect(firstIdx, 'no snapshot ever showed the held thrust').toBeGreaterThanOrEqual(0);
    await harness.advance(400); // ~8 more snapshots while still held
    const heldSnaps = snaps.slice(firstIdx);
    expect(heldSnaps.length).toBeGreaterThanOrEqual(5);

    // Client side: one predWorld body per ship, keyed as the snapshot keys them.
    const world = await PhysicsWorld.create();
    const mirror = { ships: new Map() } as unknown as RenderMirror;
    const ctx: PreResetRemoteCtx = {
      predWorld: world,
      mirror,
      preResetRemotePosScratch: new Map(),
      preResetRemotePosEntries: [],
      remoteLastInputs: new Map(),
      remoteForwardTicks: new Map(),
    };
    let pilotKey = '';
    let observerKey = '';
    for (const [k, e] of Object.entries(heldSnaps[0]!.states)) {
      if (e.playerId === pilotId) pilotKey = k;
      if (e.playerId === observerId) observerKey = k;
    }
    expect(pilotKey).not.toBe('');
    world.spawnShip(pilotKey, 0, 0, 'fighter');

    const heldBits = (): Bits | undefined => {
      const b = ctx.remoteLastInputs.get(pilotKey) as (Bits & { held?: boolean }) | undefined;
      return b && b.held !== false ? b : undefined;
    };

    // 1. Held thrust stays held across EVERY snapshot.
    for (let i = 0; i < heldSnaps.length; i++) {
      preResetRemoteShips(heldSnaps[i]!, observerKey, ctx);
      expect(heldBits()?.thrust, `snapshot ${i} of a held thrust left the observer not predicting it`).toBe(true);
    }

    // 2. Let go. Drop every snapshot that carries an explicit idle change for
    //    the pilot (what the coalescer would do if it was superseded).
    const releaseFrom = snaps.length;
    pilot.send('input', input(false));
    await harness.advance(600);
    const after = snaps.slice(releaseFrom);
    let fed = 0;
    for (const s of after) {
      const e = s.states[pilotKey];
      if (e?.lastInput && !e.lastInput.thrust) continue; // dropped
      preResetRemoteShips(s, observerKey, ctx);
      fed++;
    }
    expect(fed, 'too few snapshots after the release to judge').toBeGreaterThanOrEqual(3);
    expect(heldBits()?.thrust ?? false, 'a dropped release left the remote ship thrusting on the observer').toBe(false);
    world.dispose();
  });
});
