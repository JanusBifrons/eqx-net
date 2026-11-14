/**
 * The load shedder must never remove a ship a player can see.
 *
 * Soak 2026-11-14: with the sector at its 0.7× floor and still over budget,
 * `LoadShedder.consider` quietly evicted the drones farthest from the nearest
 * player, up to 8 a tick, without asking whether anyone could see them, so
 * ~200–325 ships vanished in the middle of the fight. The rule (server
 * CLAUDE.md, SwarmEvictor) is that shedding is invisible: a drone in ANY
 * connected player's interest window is never shed.
 *
 * Seam: the room's private `shedder.consider(rate, busiestMs)`, forced at the
 * floor rate with a 30 ms tick, the same call `update()` makes under load.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

interface Internals {
  spawnTestDrone: (id: string, x: number, y: number) => boolean;
}
interface RoomView {
  _internals: Internals;
  shedder: { consider(rate: number, busiestMs: number): number };
  swarmRegistry: { get(id: string): unknown };  // null when gone
}

describe('SectorRoom integration — load shedding stays out of view', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  const roomOf = (h: SectorTestHarness): RoomView => h.getServerRoom() as unknown as RoomView;
  const alive = (r: RoomView, ids: string[]): number => ids.filter((id) => r.swarmRegistry.get(id) != null).length;

  it('a player in a big fight keeps every drone it can see; far unseen drones are still shed', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [], droneCount: 0, testMode: true });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: 0, spawnY: 0 });
    const room = roomOf(harness);

    // The fight: 30 drones all within ~900 u of the pilot (inside its 3×3 window).
    const near: string[] = [];
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * Math.PI * 2;
      const r = 400 + (i % 3) * 250;
      const id = `shed-near-${i}`;
      expect(room._internals.spawnTestDrone(id, Math.cos(a) * r, Math.sin(a) * r)).toBe(true);
      near.push(id);
    }
    // Let the interest grid and every client's interest window pick them up.
    await harness.advance(300);

    let shed = 0;
    for (let i = 0; i < 20; i++) shed += room.shedder.consider(0.7, 30);
    expect(shed).toBe(0);
    expect(alive(room, near)).toBe(near.length);

    // Far, unseen drones (well outside the pilot's window) are still shed.
    const far: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `shed-far-${i}`;
      expect(room._internals.spawnTestDrone(id, 9000, -1000 + i * 400)).toBe(true);
      far.push(id);
    }
    await harness.advance(300);
    for (let i = 0; i < 20; i++) room.shedder.consider(0.7, 30);
    expect(alive(room, far)).toBe(0);
    expect(alive(room, near)).toBe(near.length);
  }, 20_000);
});
