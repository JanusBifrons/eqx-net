/**
 * RTS Part A S2 — an AI-flown parked hull's engine flame rides the SAME
 * snapshot carriers every ship uses (`thrustingIds` / `boostingIds`), keyed by
 * its shipInstanceId, read from the slot FLAGS input bits the worker mirrors.
 *
 * Flow: a pilot parks a fighter (Spectate) and orders a long move. An observer
 * pilot's snapshots must list the hull in `thrustingIds` (and `boostingIds`
 * while it boosts); after a stop order it must leave `thrustingIds`.
 *
 * Failing-first: before S2 hulls were only in `states[].lastInput`, never in
 * the id lists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

interface Snap { thrustingIds?: string[]; boostingIds?: string[] }

describe('SectorRoom integration — wingman flame rides thrustingIds / boostingIds (RTS A S2)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  // RTS Part B slice 9: a long move boosts (travel flag); today a move flies at the calm cruise, never boosting.
  it.skip('a moving hull is in thrustingIds (and boostingIds while boosting), and leaves when stopped', async () => {
    const owner = randomUUID();
    const observer = randomUUID();
    const ownerClient = await harness.connectActive(owner, { shipKind: 'fighter', spawnX: -3000, spawnY: 0 });
    const obsClient = await harness.connectActive(observer, { shipKind: 'fighter', spawnX: -2800, spawnY: 300 });
    const room = harness.getServerRoom()!;
    const state = room.state as SectorState;
    const internals = room._internals;

    let hull = '';
    for (const [, s] of state.ships) if (s.playerId === owner && s.isActive) hull = s.shipInstanceId;
    expect(hull).not.toBe('');

    let last: Snap = {};
    obsClient.onMessage('snapshot', (snap: Snap) => { last = snap; });

    ownerClient.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(internals.fleet.isAttached(hull)).toBe(true);
    // Let the pool fill so the long leg can boost.
    const ship = state.ships.get(hull)!;
    for (let i = 0; i < 40 && ship.energy < 95; i++) await harness.advance(250);

    expect(internals.fleet.applyOrder(owner, [hull], { kind: 'move', x: 3000, y: 0 })).toEqual([hull]);
    let sawThrust = false;
    let sawBoost = false;
    for (let i = 0; i < 30 && !(sawThrust && sawBoost); i++) {
      await harness.advance(100);
      if (last.thrustingIds?.includes(hull)) sawThrust = true;
      if (last.boostingIds?.includes(hull)) sawBoost = true;
    }
    expect(sawThrust, 'the moving hull is in the observer snapshot thrustingIds').toBe(true);
    expect(sawBoost, 'the boosting hull is in boostingIds').toBe(true);
    // Never duplicated (the energy-drain entry in boostingPlayers is filtered out).
    expect((last.boostingIds ?? []).filter((id) => id === hull).length).toBeLessThanOrEqual(1);

    expect(internals.fleet.applyOrder(owner, [hull], { kind: 'stop' })).toEqual([hull]);
    let left = false;
    for (let i = 0; i < 80 && !left; i++) {
      await harness.advance(100);
      if (!(last.thrustingIds ?? []).includes(hull) && !(last.boostingIds ?? []).includes(hull)) left = true;
    }
    expect(left, 'a stopped hull leaves thrustingIds / boostingIds').toBe(true);

    await harness.disconnectClient(ownerClient);
    await harness.disconnectClient(obsClient);
  }, 60_000);
});
