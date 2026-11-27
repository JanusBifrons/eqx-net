/**
 * Escort any ship (owner 2026-11-27): a fleet ship may follow a ship its owner
 * does not own. The client's Follow names an NPC ship by its wire id
 * (`swarm-<n>`); the server keys it by the swarm record id, the AI pilot packs
 * on it, and when the NPC is evicted (dies / despawns) the escort falls back to
 * holding where it is, as when an own escorted ship dies. A rock is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — escort any live ship', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({ sectorKey: 'sol-prime', droneCount: 0, testMode: true, asteroidConfig: [] });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('follows an NPC ship named swarm-<n>; falls back to holding when it is evicted', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = harness.getServerRoom()! as unknown as SectorRoom;
    const state = room.state as SectorState;
    let sid = '';
    for (const [, s] of state.ships) if (s.playerId === pid && s.isActive) sid = s.shipInstanceId;
    client.send('spectate', { type: 'spectate' });
    await harness.advance(300);
    const internals = room._internals;
    const fleet = internals.fleet;
    expect(fleet.isAttached(sid)).toBe(true);
    expect(internals.spawnTestDrone('npc1', 600, 0, 'fighter')).toBe(true);
    const rec = internals.swarmRegistry.get('npc1')!;
    expect(rec).not.toBeNull();

    client.send('set_mode', { type: 'set_mode', shipIds: [sid], mode: 'escort', escortId: `swarm-${rec.entityId}` });
    await harness.advance(300);
    expect(fleet.ordersOf(sid)!.mode).toBe('escort');
    expect(fleet.escortTargetOf(sid), 'keyed by the swarm record id').toBe('npc1');
    const brain = internals.aiBrainOf(sid)!;
    expect(brain.getFlockLeaderId?.(), 'packs on the NPC').toBe('npc1');

    internals.evictSwarm('npc1');
    await harness.advance(100);
    expect(brain.getFlockLeaderId?.() ?? null, 'no longer follows the gone NPC').not.toBe('npc1');
    expect(brain.getGuardPostX?.() ?? null, 'holds a post again').not.toBeNull();

    // A non-ship (an unknown / rock id) is refused: the ship defends.
    client.send('set_mode', { type: 'set_mode', shipIds: [sid], mode: 'escort', escortId: 'swarm-999999' });
    await harness.advance(100);
    expect(fleet.ordersOf(sid)!.mode).toBe('defend');
    expect(fleet.escortTargetOf(sid)).toBeNull();

    await harness.disconnectClient(client);
  }, 60_000);
});
