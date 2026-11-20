/**
 * `?room=base-build-test` (Sunday base loop): boots the EXACT options the
 * server registers. A pilot joining as the showcase pilot owns a powered
 * starter base with minerals banked, and a Solar they place fills in from
 * that bank. Grid pulses are driven deterministically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { BASE_BUILD_TEST_OPTS } from '../../../src/server/rooms/testRooms/engineeringRooms.js';
import { SHOWCASE_PILOT_ID } from '../../../src/server/rooms/showcaseRooms.js';
import { getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { getStructureKind } from '../../../src/shared-types/structureKinds.js';
import { CONSTRUCTION_PULSE_AMOUNT } from '../../../src/core/structures/structureGridConstants.js';

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
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID);
    const internals = roomOf(cr.roomId)._internals;
    expect(internals.playerPose(SHOWCASE_PILOT_ID), 'pilot is live').toBeDefined();
    const mine = [...internals.structureRegistry.all()].filter((s) => s.owner === SHOWCASE_PILOT_ID);
    const cap = mine.find((s) => s.kind === 'capital');
    expect(cap?.isConstructed).toBe(true);
    expect(cap!.minerals).toBe(50_000);
    expect(mine.filter((s) => s.kind === 'solar' && s.isConstructed).length).toBe(2);
    expect(getWallet().balance(SHOWCASE_PILOT_ID)).toBe(20_000);
    // Peaceful: no NPC ship in the room; the one rock is the seeded scenario rock.
    const swarm = [...internals.swarmRegistry.all()];
    expect(swarm.filter((r) => r.id.startsWith('scenario-rock-')).length).toBe(1);
    expect(swarm.filter((r) => r.id.startsWith('scenario-drone-')).length).toBe(0);
  });

  it('a placed Solar blueprint fills in', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer(structuredClone(BASE_BUILD_TEST_OPTS) as Record<string, unknown>);
    const cr = await harness.connectActive(SHOWCASE_PILOT_ID);
    const internals = roomOf(cr.roomId)._internals;
    expect(internals.playerPose(SHOWCASE_PILOT_ID), 'pilot is live').toBeDefined();
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
    expect(solar.owner).toBe(SHOWCASE_PILOT_ID);
    expect(solar.isConstructed).toBe(false);
    const pulses = Math.ceil(getStructureKind('solar').constructionCost / CONSTRUCTION_PULSE_AMOUNT);
    for (let i = 0; i < pulses + 2 && !solar.isConstructed; i++) internals.pulseStructureGrid();
    expect(solar.isConstructed, 'solar filled in from the Capital bank').toBe(true);
  });
});
