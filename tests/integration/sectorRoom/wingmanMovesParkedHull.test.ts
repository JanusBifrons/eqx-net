/**
 * RTS command layer, slice 4 — every lingering hull is flown by a wingman
 * brain (`FleetCommandSubsystem`, wired into `SectorRoom`) with the pilot's
 * own INPUT command on the hull's slot.
 *
 * Flow: join, Spectate (the active hull parks as a lingering hull and gets a
 * brain: Defend at its spot), issue a MOVE order through the owner-checked
 * fleet API (`_internals.fleet`, the test hook until the network handlers land),
 * and the parked hull flies there and stops inside the arrive radius. Then
 * `pilot_ship` reclaims it: the brain is detached and posts no more input.
 *
 * Failing-first: before slice 4 nothing attached a brain, so `isAttached` is
 * false and the hull never leaves its parking spot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';
import { wingmanConfigFor } from '../../../src/server/fleet/FleetCommandSubsystem.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

describe('SectorRoom integration — a wingman flies the parked hull (RTS slice 4)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    // No rocks: the hull's flight path must be clear (an asteroid in the way
    // stops it, which is physics, not the wingman).
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  // RTS Part B slice 9: the hull's keys go through `postHullInput` (the AI
  // pilot brain's one hull branch), so the "no input after reclaim" spy sits
  // there instead of the retired wingman INPUT post.
  it('a move order flies the parked hull to the point; pilot_ship takes it back from the brain', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;

    let shipId = '';
    for (const [, s] of state.ships) {
      if (s.playerId === pid && s.isActive) { shipId = s.shipInstanceId; break; }
    }
    expect(shipId).not.toBe('');

    // Latest snapshot pose of the hull, whatever its state.
    let last: { x: number; y: number; isActive: boolean } | null = null;
    client.onMessage('snapshot', (snap: unknown) => {
      const e = (snap as SnapshotMessage).states[shipId];
      if (e) last = { x: e.x, y: e.y, isActive: e.isActive };
    });

    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.lingeringSlots.has(shipId), 'precondition: the hull is parked').toBe(true);
    expect(internals.fleet.isAttached(shipId), 'the parked hull has a wingman brain').toBe(true);

    // Default brain: Defend at the parking spot. It must stay put.
    await harness.advance(500);
    const parked = last as { x: number; y: number } | null;
    expect(parked).not.toBeNull();
    expect(Math.hypot(parked!.x, parked!.y), 'a defending wingman holds its spot').toBeLessThan(50);

    // Order: move 800 u east.
    const TX = 800;
    const TY = 0;
    const accepted = internals.fleet.applyOrder(pid, [shipId], { kind: 'move', x: TX, y: TY });
    expect(accepted).toEqual([shipId]);
    // Another player's order for this hull is dropped (owner-checked per id).
    expect(internals.fleet.applyOrder(randomUUID(), [shipId], { kind: 'stop' })).toEqual([]);

    const { arriveRadius } = wingmanConfigFor(getShipKind('fighter'));
    const brain = internals.fleet.brainOf(shipId)!;
    let arrived = false;
    for (let i = 0; i < 80 && !arrived; i++) {
      await harness.advance(250);
      arrived = brain.order === null;
    }
    expect(arrived, 'the move order completes').toBe(true);
    await harness.advance(300);
    const at = last as { x: number; y: number } | null;
    expect(at).not.toBeNull();
    const miss = Math.hypot(at!.x - TX, at!.y - TY);
    expect(miss, `hull stopped ${miss.toFixed(1)} u from the target (arrive radius ${arriveRadius})`)
      .toBeLessThanOrEqual(arriveRadius);

    // Count AI pilot inputs for this hull from here on.
    let wingmanInputs = 0;
    const r = room as unknown as { postHullInput: (id: string, bits: number) => void };
    const orig = r.postHullInput.bind(room);
    r.postHullInput = (id, bits) => { if (id === shipId) wingmanInputs++; orig(id, bits); };

    // Reclaim: the owner takes the helm back.
    client.send('pilot_ship', { type: 'pilot_ship', shipId });
    client.send('client_ready', { type: 'client_ready' });
    await harness.advance(900);
    expect(internals.lingeringSlots.has(shipId)).toBe(false);
    expect(internals.fleet.isAttached(shipId), 'brain detached on reclaim').toBe(false);
    wingmanInputs = 0;
    await harness.advance(500);
    expect(wingmanInputs, 'no wingman input after reclaim').toBe(0);
    expect(state.ships.get(shipId)?.isActive, 'the owner flies it again').toBe(true);

    // The pilot's own thrust moves it (the held wingman input was cleared).
    const before = last as { x: number; y: number } | null;
    for (let i = 0; i < 10; i++) {
      harness.sendThrust(client);
      await harness.advance(50);
    }
    await harness.advance(150);
    const after = last as { x: number; y: number } | null;
    expect(Math.hypot(after!.x - before!.x, after!.y - before!.y), 'pilot thrust moves the reclaimed hull')
      .toBeGreaterThan(5);

    await harness.disconnectClient(client);
  }, 60_000);
});
