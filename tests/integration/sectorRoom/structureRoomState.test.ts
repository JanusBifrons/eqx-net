/**
 * A2 (plan soft-leaping-truffle v2) — structure grid state lives in ROOM STATE.
 * Invariant #16: a client must converge from the join payload + patches alone.
 *  - a client that joins a seeded base sees every structure row on join;
 *  - a change (a hit on a structure) reaches an already-joined client as a
 *    patch, and a LATE joiner reads the changed value from its join payload;
 *  - a removed structure's row disappears for everyone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { SectorState } from '../../../src/server/rooms/schema/SectorState.js';

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('structure state in room state (A2)', () => {
  let h: SectorTestHarness | undefined;
  afterEach(async () => {
    if (h) await h.cleanup();
    h = undefined;
  }, 20_000);

  it('join payload carries every structure; changes patch live clients and late joiners', async () => {
    h = await bootSectorTestServer({ droneCount: 0, asteroidConfig: [], scaleGrid: { n: 60, seed: 3, fence: true }, defaultSpawnX: 0, defaultSpawnY: -6000 });
    const a = await h.connectAs(randomUUID());
    const room = matchMaker.getLocalRoomById(a.roomId) as unknown as SectorRoom;
    const internal = room._internals;
    const count = internal.structureRegistry.size;
    const stateA = (): SectorState => a.state as unknown as SectorState;
    await until(() => (a.state as unknown as SectorState).structures?.size === count);

    // Pick a non-pylon structure and hit it (pylons with an active wall absorb).
    let targetId = '';
    for (const rec of internal.structureRegistry.all()) if (rec.kind === 'solar') { targetId = rec.id; break; }
    const entityId = internal.swarmRegistry.get(targetId)!.entityId;
    const key = String(entityId);
    expect(stateA().structures.get(key)!.hpPct ?? 100).toBe(100);
    internal.applyDamage(targetId, 'test-shooter', 150, 0, 0);
    internal.pulseStructureGrid();
    await until(() => (stateA().structures.get(key)!.hpPct ?? 100) < 100);
    const hpAfter = stateA().structures.get(key)!.hpPct;

    // Late joiner: reconstructs from the join payload alone.
    const b = await h.connectAs(randomUUID());
    const stateB = (): SectorState => b.state as unknown as SectorState;
    await until(() => (b.state as unknown as SectorState).structures?.size === count);
    expect(stateB().structures.get(key)!.hpPct).toBe(hpAfter);
    expect(stateB().structures.get(key)!.connTo.length).toBeGreaterThan(0);

    // Removal: the row disappears for both.
    internal.applyDamage(targetId, 'test-shooter', 1_000_000, 0, 0);
    internal.pulseStructureGrid();
    await until(() => !stateA().structures.has(key) && !stateB().structures.has(key));
  }, 60_000);
});
