/**
 * Perf scenes (plan prancy-squishing-donut P1) — a room's `sceneScript` plays
 * its timed steps in a real room: nothing spawns before the first pilot is
 * ready, the warp-in raid arrives on time with the `warp_in` effect, drones
 * and robots placed together fight unprovoked, and the scene reaches `end`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SceneStatus } from '../../../src/server/rooms/scene/SceneScriptRunner.js';

type SceneRoom = { sceneStatus(): SceneStatus | null; swarmRegistry: { size(): number } };

describe('SectorRoom integration — scene script', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  it('plays timed spawns after the pilot is ready and reaches end', { timeout: 40_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: null,
      droneCount: 0,
      asteroidConfig: [],
      sceneScript: [
        { atMs: 0, action: 'spawn', tag: 'blue', kind: 'fighter', count: 6, x: -150, y: 1500, spread: 100 },
        { atMs: 0, action: 'spawn', tag: 'red', kind: 'robot-square', count: 6, x: 150, y: 1500, spread: 100 },
        { atMs: 1500, action: 'spawn', tag: 'raid', kind: 'fighter', count: 10, x: 0, y: -1500, spread: 200, warpIn: true },
        { atMs: 3000, action: 'end' },
      ],
    });
    const pid = randomUUID();
    const pending = await harness.connectAs(pid);
    const room = harness.getServerRoom() as unknown as SceneRoom;
    // Joined but not ready: the scene clock has not started.
    await new Promise((r) => setTimeout(r, 300));
    expect(room.sceneStatus()).toMatchObject({ started: false, spawned: 0 });
    void pending; // stays connected so the room lives on

    const pilot = randomUUID();
    const cr = await harness.connectActive(pilot);
    const warps: string[] = [];
    cr.onMessage('warp_in', (m: { playerId: string }) => { warps.push(m.playerId); });
    let damageBetweenSides = 0;
    cr.onMessage('damage', (m: { targetId: string; shooterId?: string }) => {
      if (m.targetId !== pilot && m.shooterId !== pilot) damageBetweenSides++;
    });

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(room.sceneStatus()?.ended && damageBetweenSides > 0)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const st = room.sceneStatus()!;
    expect(st).toMatchObject({ started: true, ended: true, spawned: 22, refused: 0, played: 4 });
    expect(warps.filter((id) => id.startsWith('scene-raid-'))).toHaveLength(10);
    expect(warps.some((id) => id.startsWith('scene-blue-'))).toBe(false);
    expect(damageBetweenSides, 'the two sides never fought').toBeGreaterThan(0);
  });

  it('refuses a bad script at room creation', { timeout: 20_000 }, async () => {
    harness = await bootSectorTestServer({ sectorKey: null, sceneScript: [{ atMs: 0, action: 'spawn', tag: 'x', kind: 'nope', count: 1, x: 0, y: 0 }] });
    await expect(harness.connectAs(randomUUID())).rejects.toThrow();
  });
});
