/**
 * Phase 6c — drone retargeting (active-only). TDD failing test FIRST,
 * then implementation in `SectorRoom.ts`.
 *
 * THE BUG THIS LOCKS (currently UNSHIPPED — Phase B of
 * `humble-strolling-coral.md`):
 *   When a player's hull is in the lingering state (`ship.isActive === false`,
 *   typically after the player disconnects but within the 15-min linger
 *   window), `SectorRoom`'s AI view construction at the drone-tick site
 *   still includes that player in `aiPlayerScratch`. Combined with the
 *   drone's persistent `hostileTo` set (which keeps the playerId in
 *   memory even after the player drops), the drone targets the
 *   lingering hull — drones fire at a ship the player no longer controls,
 *   which feels broken in gameplay.
 *
 * THE FIX:
 *   Gate the `for (const [pid] of this.playerToSlot)` loop in
 *   `SectorRoom.update()`'s AI-tick block on `ship.isActive === true`.
 *   The matching client-side prediction site in `ColyseusClient.ts`
 *   needs the same filter for AI lockstep (Input Symmetry Rule per
 *   `src/core/CLAUDE.md`).
 *
 * WHY THIS IS A CORRECTNESS TEST AT THIS LEVEL:
 *   - The pure `HostileDroneBehaviour.tick(self, view)` is correct as
 *     written — it picks the nearest hostile from `view.players`. The
 *     bug is in the INPUT to that pure function, specifically the
 *     view-construction site that copies poses out of `playerToSlot`.
 *   - Unit-testing the pure behaviour cannot catch this because the
 *     view is the input boundary; the bug lives between the two.
 *   - Integration test against a real SectorRoom is the right level —
 *     `aiPlayerScratch` is the field that the bug lives on.
 *
 * REGRESSION RECIPE (if you revert the SectorRoom fix):
 *   1. Reverting the `&& ship.isActive === true` (or the filter
 *      equivalent) in `SectorRoom.update()`'s AI view rebuild block
 *      makes test "lingering hull is excluded from the AI view"
 *      fail loudly.
 *   2. Reverting the matching filter in `ColyseusClient` does NOT
 *      affect this server-side integration test; the client-side
 *      symmetry is locked by feel-test-lockstep.spec.ts separately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

function getRoomById(roomId: string): SectorRoom {
  return matchMaker.getLocalRoomById(roomId) as unknown as SectorRoom;
}

describe('Phase 6c — drone retargeting (active-only)', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 1,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('lingering hull is excluded from the AI view (aiPlayerScratch)', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, {
      shipKind: 'fighter',
      spawnX: 200,
      spawnY: 0,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const room = getRoomById(client.roomId);

    // Sanity: the freshly-joined active player IS in the AI view after
    // a tick. (If this fails, the test premise is wrong.)
    await harness.advance(150);
    expect(
      room._internals.aiPlayerScratch.find((p) => p.id === pid),
      'sanity: active player must be in aiPlayerScratch',
    ).toBeDefined();

    // Force-flip the ship to lingering state. This is what the real
    // disconnect-linger branch does in onLeave (Phase 6b). We bypass
    // the disconnect dance entirely — the test is about the AI view
    // gate, not the lifecycle that produces the lingering state.
    for (const [, ship] of room.state.ships) {
      if (ship.playerId === pid) {
        ship.isActive = false;
        break;
      }
    }

    // Advance several ticks so the AI view is rebuilt against the
    // new isActive=false ship.
    await harness.advance(300);

    expect(
      room._internals.aiPlayerScratch.find((p) => p.id === pid),
      'lingering hull (isActive=false) must NOT appear in the drone AI view',
    ).toBeUndefined();
  });

  it('AI view tracks rebind: ship flipped back to isActive=true is visible again', async () => {
    const pid = randomUUID();
    const client = await harness.connectActive(pid, {
      shipKind: 'fighter',
      spawnX: 250,
      spawnY: 0,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const room = getRoomById(client.roomId);
    await harness.advance(150);
    expect(room._internals.aiPlayerScratch.find((p) => p.id === pid)).toBeDefined();

    // Linger → AI view excludes.
    for (const [, ship] of room.state.ships) {
      if (ship.playerId === pid) ship.isActive = false;
    }
    await harness.advance(200);
    expect(room._internals.aiPlayerScratch.find((p) => p.id === pid)).toBeUndefined();

    // Rebind (simulates the player reconnecting + binding the same
    // hull). Flip back to active.
    for (const [, ship] of room.state.ships) {
      if (ship.playerId === pid) ship.isActive = true;
    }
    await harness.advance(200);
    expect(
      room._internals.aiPlayerScratch.find((p) => p.id === pid),
      'rebound (isActive=true) ship must reappear in the AI view',
    ).toBeDefined();
  });

  it('multiple players: only the active one is in the AI view when one is lingering', async () => {
    const activePid = randomUUID();
    const lingerPid = randomUUID();

    const lingerClient = await harness.connectActive(lingerPid, {
      shipKind: 'fighter',
      spawnX: 200,
      spawnY: 100,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === lingerPid });

    await harness.connectActive(activePid, {
      shipKind: 'scout',
      spawnX: -200,
      spawnY: -100,
    });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === activePid });

    const room = getRoomById(lingerClient.roomId);

    // Force linger on the first player.
    for (const [, ship] of room.state.ships) {
      if (ship.playerId === lingerPid) ship.isActive = false;
    }
    await harness.advance(200);

    expect(room._internals.aiPlayerScratch.find((p) => p.id === lingerPid)).toBeUndefined();
    expect(room._internals.aiPlayerScratch.find((p) => p.id === activePid)).toBeDefined();
  });
});
