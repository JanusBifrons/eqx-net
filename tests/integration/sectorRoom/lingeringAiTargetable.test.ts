/**
 * Living World P1a-2 (plan peppy-jumping-pinwheel, user decision 7 — hardcore):
 * a hull whose pilot DISCONNECTED is AI-targetable. Logging off in the field is
 * a real risk; you can't combat-log a ship full of cargo to safety.
 *
 * This deliberately supersedes the Phase 6c rule for DISCONNECTED hulls only.
 * A connected-but-inactive hull (a just-joined, still-pending ship) stays
 * untargetable — `droneTargetActiveOnly.test.ts` keeps locking that.
 *
 * RED before the fix: the disconnected hull never appears in the AI view.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — a disconnected hull is AI-targetable (P1a-2, decision 7)', () => {
  let harness: SectorTestHarness;
  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true,
      // One drone so the AI tick runs (it early-outs with no AI entities).
      dronePoses: [{ kind: 'fighter', x: 3000, y: 3000 }],
    });
  }, 15_000);
  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('after the pilot disconnects, the lingering hull appears in the AI view', { timeout: 30_000 }, async () => {
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, { spawnX: 200, spawnY: 0 });
    const room = matchMaker.getLocalRoomById(cr.roomId) as unknown as SectorRoom;
    let shipId = '';
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) shipId = s.shipInstanceId;

    await harness.disconnectClient(cr);
    await harness.events.waitFor({ tag: 'player_lingered', where: (d) => d['playerId'] === pid });
    await harness.advance(300);

    const inView = room._internals.aiPlayerScratch.some((p) => p.id === pid || p.id === shipId || p.ownerId === pid);
    expect(inView, 'an offline (disconnected) hull must be in the drone AI view').toBe(true);
  });
});
