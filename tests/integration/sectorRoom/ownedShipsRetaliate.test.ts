/**
 * RTS Part B slice 4 — owned ships hit back through the shared AI's
 * retaliation ledger (`AiController.markHostile`), never a fleet-side one.
 *
 * Player A owns three parked fighters (two in a squad). Player B, flying,
 * shoots one of the squad: it and its squadmate turn on B (the shot is keyed
 * by B's playerId, which covers B's active ship). A's hull outside the squad
 * stays out of it. A shooting their own hull (from their active ship or
 * from another of their hulls) never turns it.
 *
 * Failing first: before slice 4 a hit only fed the fleet's own
 * `noteDamage` / `recentAttackerOf` ledger, which the AI pilot brain flying
 * the hull never reads, so the hull never targeted B.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — owned ships retaliate (RTS Part B slice 4)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it("player B shoots A's parked hull: it and its squadmate target B; A's own fire never turns them", async () => {
    const pidA = randomUUID();
    const pidB = randomUUID();
    let clientA = await harness.connectActive(pidA, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    const internals = room._internals;
    const fleet = internals.fleet;
    const activeOf = (pid: string): string => {
      for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) return s.shipInstanceId;
      return '';
    };
    const targetOf = (id: string): string | null => internals.aiBrainOf(id)?.getTargetId?.() ?? null;

    // Three hulls for A: H1, H2 displaced by fresh spawns, H3 parked by Spectate.
    const H1 = activeOf(pidA);
    await harness.disconnectClient(clientA);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pidA });
    clientA = await harness.connectActive(pidA, { isNewShip: true, shipKind: 'fighter', spawnX: 400, spawnY: 0 });
    const H2 = activeOf(pidA);
    await harness.disconnectClient(clientA);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pidA });
    clientA = await harness.connectActive(pidA, { isNewShip: true, shipKind: 'fighter', spawnX: -400, spawnY: 0 });
    const H3 = activeOf(pidA);
    clientA.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    expect(new Set([H1, H2, H3]).size).toBe(3);
    for (const id of [H1, H2, H3]) expect(fleet.isAttached(id), `${id} is flown by an AI pilot`).toBe(true);
    expect(fleet.formSquad(pidA, [H1, H2])).not.toBeNull();

    // B flies nearby.
    const clientB = await harness.connectActive(pidB, { shipKind: 'fighter', spawnX: 0, spawnY: 600 });
    await harness.advance(300);
    for (const id of [H1, H2, H3]) expect(targetOf(id), `${id} starts with no target`).toBeNull();

    // A's own fire never turns a hull: from A (a playerId) or from A's other hull.
    internals.applyDamage(H1, pidA, 1);
    internals.applyDamage(H1, H3, 1);
    await harness.advance(500);
    for (const id of [H1, H2, H3]) expect(targetOf(id), `${id}: the owner's fire is not a hostile act`).toBeNull();

    // B shoots H1: H1 and its squadmate H2 turn on B; H3 (no squad) does not.
    internals.applyDamage(H1, pidB, 1);
    await harness.advance(500);
    expect(targetOf(H1), 'the hit hull targets B').toBe(pidB);
    expect(targetOf(H2), 'its squadmate targets B').toBe(pidB);
    expect(targetOf(H3), 'a hull outside the squad stays out of it').toBeNull();

    await harness.disconnectClient(clientB);
    await harness.disconnectClient(clientA);
  }, 60_000);
});
