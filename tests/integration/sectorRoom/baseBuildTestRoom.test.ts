/**
 * `?room=base-build-test` (Sunday base loop): boots the EXACT options the
 * server registers. Whoever joins first — ANY id, not just the showcase pilot
 * (live check 2026-11-20: a client that was not the base's owner placed
 * Solars that never cabled or filled) — owns a powered starter base with minerals banked, and a Solar they place fills in from
 * that bank on the room's own pulse timer, cabled and climbing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { BASE_BUILD_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';
import { randomUUID } from 'node:crypto';
import { getWallet } from '../../../src/server/db/PersistenceWorker.js';

/** A fresh id each test: the base must be the JOINER's, whatever their id. */
const PILOT = randomUUID();

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('base-build-test room', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a pilot joining base-build-test owns a Capital with minerals banked', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(BASE_BUILD_TEST_OPTS) as Record<string, unknown>);
    // connectActive: the pilot's hull is ACTIVE (#17), not a pending join.
    const cr = await harness.connectActive(PILOT);
    const internals = roomOf(cr.roomId)._internals;
    expect(internals.playerPose(PILOT), 'pilot is live').toBeDefined();
    const mine = [...internals.structureRegistry.all()].filter((s) => s.owner === PILOT);
    const cap = mine.find((s) => s.kind === 'capital');
    expect(cap?.isConstructed).toBe(true);
    expect(cap!.minerals).toBe(50_000);
    expect(mine.filter((s) => s.kind === 'solar' && s.isConstructed).length).toBe(2);
    expect(getWallet().balance(PILOT)).toBe(20_000);
    // Peaceful: no NPC ship in the room; the one rock is the seeded scenario rock.
    const swarm = [...internals.swarmRegistry.all()];
    expect(swarm.filter((r) => r.id.startsWith('scenario-rock-')).length).toBe(1);
    expect(swarm.filter((r) => r.id.startsWith('scenario-drone-')).length).toBe(0);
  });

  it('a placed Solar blueprint fills in', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(BASE_BUILD_TEST_OPTS) as Record<string, unknown>);
    const cr = await harness.connectActive(PILOT);
    const internals = roomOf(cr.roomId)._internals;
    expect(internals.playerPose(PILOT), 'pilot is live').toBeDefined();
    const before = new Set([...internals.structureRegistry.all()].map((s) => s.id));
    // North of the base, in reach of the Connector at (0, 350).
    cr.send('place_structure', { type: 'place_structure', kind: 'solar', x: 0, y: 850 });
    let id: string | undefined;
    for (let i = 0; i < 75 && id === undefined; i++) {
      await harness.advance(40);
      id = [...internals.structureRegistry.all()].find((s) => !before.has(s.id))?.id;
    }
    expect(id, 'solar placed').toBeDefined();
    const solar = internals.structureRegistry.get(id!)!;
    expect(solar.owner).toBe(PILOT);
    const eid = internals.swarmRegistry.get(id!)!.entityId;
    const row = () => (internals.getStructuresSlice() ?? []).find((r) => r.id === eid);
    // The room's own 100 ms pulse timer (no manual pulses): the client's view
    // (state rows) shows the blueprint CABLED and its build % climbing.
    let firstPct: number;
    for (let i = 0; i < 100 && !(row()?.connTo?.length && (row()?.buildPct ?? 0) > 0); i++) await harness.advance(50);
    expect(row()?.connTo?.length ?? 0, 'solar is cabled into the base').toBeGreaterThan(0);
    firstPct = row()?.buildPct ?? 0;
    expect(firstPct, 'build % started').toBeGreaterThan(0);
    for (let i = 0; i < 40 && (row()?.buildPct ?? 0) <= firstPct; i++) await harness.advance(50);
    expect(row()?.buildPct ?? 0, 'build % climbs').toBeGreaterThan(firstPct);
    for (let i = 0; i < 300 && !solar.isConstructed; i++) await harness.advance(50);
    expect(solar.isConstructed, 'solar filled in from the Capital bank').toBe(true);
    expect(row()?.built).toBe(true);
  });
});
