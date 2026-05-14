/**
 * Phase 6d — lingering-hull slot cap per player per sector. TDD failing
 * test FIRST, then implementation in `SectorRoom.ts`.
 *
 * THE BUG THIS LOCKS (currently UNSHIPPED — Phase C of
 * `humble-strolling-coral.md`):
 *   A player can accumulate unbounded lingering hulls in a single
 *   sector by repeatedly spawning fresh ships while old hulls linger
 *   within the 15-min reconnect window. Each fresh-spawn-displaces
 *   adds an entry to `lingeringSlots` without checking how many the
 *   player already has in this sector. Long-running sessions can
 *   accumulate 10+ lingering hulls per player, all rendering and all
 *   physics-active.
 *
 * THE FIX:
 *   - Add `LINGER_CAP_PER_PLAYER_PER_SECTOR = 3`.
 *   - At the fresh-spawn-displaces site (where `lingeringSlots.set`
 *     happens), AFTER the new lingering hull is added, count this
 *     player's lingering hulls. If count > 3, evict the OLDEST
 *     (earliest in insertion-order traversal of the Map).
 *   - The just-displaced hull is the NEWEST; we evict an OLDER one,
 *     so the count drops from 4 → 3 and the freshly displaced hull
 *     survives in this room.
 *
 * REGRESSION RECIPE: revert the cap check → these tests re-fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { matchMaker } from 'colyseus';
import type { Room as ServerRoom } from 'colyseus';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { ShipState, type SectorState } from '../../../src/server/rooms/schema/SectorState.js';

interface SectorRoomInternals {
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, unknown>;
  freeSlots: number[];
  state: SectorState;
  enforceLingerCap?: (playerId: string) => void;
}

function getRoomById(roomId: string): ServerRoom<SectorState> & SectorRoomInternals {
  return matchMaker.getLocalRoomById(roomId) as unknown as ServerRoom<SectorState> & SectorRoomInternals;
}

/** Build a synthetic lingering hull at the given slot, inserted into
 *  the room's state so the cap-enforcement code can iterate it. */
function seedLingeringHull(
  room: ServerRoom<SectorState> & SectorRoomInternals,
  playerId: string,
  slot: number,
  kind: string = 'fighter',
): string {
  const shipInstanceId = randomUUID();
  const ship = new ShipState();
  ship.shipInstanceId = shipInstanceId;
  ship.playerId = playerId;
  ship.kind = kind;
  ship.health = 50;
  ship.maxHealth = 100;
  ship.alive = true;
  ship.isActive = false;
  room.state.ships.set(shipInstanceId, ship);
  room.lingeringSlots.set(shipInstanceId, slot);
  room.lingeringPoseCache.set(shipInstanceId, {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    angvel: 0,
  });
  return shipInstanceId;
}

describe('Phase 6d — lingering-hull slot cap per player per sector', () => {
  let harness: SectorTestHarness;

  beforeEach(async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
    });
  }, 15_000);

  afterEach(async () => {
    if (harness) await harness.cleanup();
  }, 10_000);

  it('cap is enforced: after seeding 4 lingering hulls for one player, enforceLingerCap evicts down to 3', async () => {
    const pid = randomUUID();
    // We need a real connected player so the harness has a roomId.
    const client = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const room = getRoomById(client.roomId);

    // Seed 4 synthetic lingering hulls for the player. Insertion order
    // is the "age" order — the first one inserted is the oldest.
    const seeded: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Use slot ids in a range unlikely to collide with the harness
      // player's slot (0). 1000+ is safely beyond.
      seeded.push(seedLingeringHull(room, pid, 1000 + i));
    }
    expect(room.lingeringSlots.size).toBeGreaterThanOrEqual(4);

    expect(typeof room.enforceLingerCap).toBe('function');
    room.enforceLingerCap!(pid);

    // After enforcement, exactly 3 of the 4 seeded hulls remain in
    // lingeringSlots (and in state.ships). The oldest is gone.
    let stillPresent = 0;
    for (const shipId of seeded) {
      if (room.lingeringSlots.has(shipId)) stillPresent++;
    }
    expect(stillPresent).toBe(3);

    // The oldest (seeded[0]) is the one evicted.
    expect(room.lingeringSlots.has(seeded[0]!)).toBe(false);
    expect(room.state.ships.has(seeded[0]!)).toBe(false);
    // The 3 newer ones survive.
    for (let i = 1; i < 4; i++) {
      expect(room.lingeringSlots.has(seeded[i]!)).toBe(true);
    }
  });

  it('cap counts only the requesting player — does not evict another player\'s lingering hulls', async () => {
    const pid1 = randomUUID();
    const pid2 = randomUUID();
    const client = await harness.connectAs(pid1, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid1 });

    const room = getRoomById(client.roomId);

    // 4 hulls for pid1, 4 hulls for pid2.
    const p1 = [
      seedLingeringHull(room, pid1, 1000),
      seedLingeringHull(room, pid1, 1001),
      seedLingeringHull(room, pid1, 1002),
      seedLingeringHull(room, pid1, 1003),
    ];
    const p2 = [
      seedLingeringHull(room, pid2, 1100),
      seedLingeringHull(room, pid2, 1101),
      seedLingeringHull(room, pid2, 1102),
      seedLingeringHull(room, pid2, 1103),
    ];

    // Enforce for pid1 only.
    room.enforceLingerCap!(pid1);

    // pid1 → 3 remain. pid2 → all 4 untouched.
    let p1Remaining = 0;
    for (const s of p1) if (room.lingeringSlots.has(s)) p1Remaining++;
    let p2Remaining = 0;
    for (const s of p2) if (room.lingeringSlots.has(s)) p2Remaining++;

    expect(p1Remaining).toBe(3);
    expect(p2Remaining).toBe(4);
  });

  it('at-cap (3 hulls): enforceLingerCap is a no-op', async () => {
    const pid = randomUUID();
    const client = await harness.connectAs(pid, { shipKind: 'fighter' });
    await harness.events.waitFor({ tag: 'player_join', where: (d) => d['playerId'] === pid });

    const room = getRoomById(client.roomId);

    const seeded = [
      seedLingeringHull(room, pid, 1000),
      seedLingeringHull(room, pid, 1001),
      seedLingeringHull(room, pid, 1002),
    ];

    room.enforceLingerCap!(pid);

    // All 3 still present — nothing evicted.
    for (const s of seeded) {
      expect(room.lingeringSlots.has(s)).toBe(true);
      expect(room.state.ships.has(s)).toBe(true);
    }
  });
});
