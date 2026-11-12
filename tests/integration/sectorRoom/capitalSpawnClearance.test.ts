/**
 * Owner bug report 2026-11-12 (filmed clip, `showcase-capitals-combat`):
 * "Two of the ships were overlapping?!" A pilot joining as a `heavy-cruiser`
 * with no spawn coordinates appeared INSIDE the NPC heavy cruiser's hull and
 * the two hulls stayed interpenetrated for the whole take. With a fighter the
 * default spawn was clear: the join path only nudged spawns out of
 * STRUCTURES, never out of other ships, so a big joining hull landed on the
 * line-up (the room's default spawn sits 1,200 u off the largest stern, less
 * than a heavy cruiser's own radius).
 *
 * Root invariant #18: spawn clearance follows the JOINING hull's size.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import { SHOWCASE_CAPITALS_COMBAT_OPTS } from '../../../src/server/rooms/showcaseRooms.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

function roomOf(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('a capital joining the capital line-up spawns clear of every hull', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  for (const kind of ['heavy-cruiser', 'battleship', 'fighter'] as const) {
    it(`a ${kind} with no spawn coordinates does not overlap any NPC hull`, { timeout: 30_000 }, async () => {
      harness = await bootSectorTestServer(structuredClone(SHOWCASE_CAPITALS_COMBAT_OPTS) as unknown as Record<string, unknown>);
      const pilot = randomUUID();
      const cr = await harness.connectActive(pilot, { shipKind: kind, initialHull: 1_000_000, noselfdmg: 1 });
      const internals = roomOf(cr.roomId)._internals;
      const pose = internals.playerPose(pilot);
      expect(pose).not.toBeNull();
      const ownR = getShipKind(kind).radius;
      const room = roomOf(cr.roomId);
      const at = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
      const overlaps: string[] = [];
      for (const rec of internals.swarmRegistry.all()) {
        if (rec.kind !== 1) continue;
        expect(room.swarmEntityPoseInto(rec.id, at)).toBe(true);
        const otherR = getShipKind(rec.shipKind!).radius;
        const d = Math.hypot(at.x - pose!.x, at.y - pose!.y);
        if (d < ownR + otherR) overlaps.push(`${rec.shipKind} at ${d.toFixed(0)} u (needs ${(ownR + otherR).toFixed(0)})`);
      }
      expect(overlaps, `spawned at (${pose!.x.toFixed(0)}, ${pose!.y.toFixed(0)})`).toEqual([]);
    });
  }
});
