/**
 * Game speed per sector (time scale stream, step 3b) through a real SectorRoom:
 *  - the testMode room option and join option set this sector's speed;
 *  - while the speed isn't 1 every snapshot carries the `timeScale` keyframe
 *    (#16: a late joiner converges from the snapshot alone), and back at 1 it
 *    is absent (zero bytes in normal play);
 *  - the speed is the SECTOR's: the process clock (cross-sector world time)
 *    is untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { gameClock } from '../../../src/server/time/gameTime.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

describe('SectorRoom integration — per-sector game speed', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  function room(): SectorRoom {
    return harness!.getServerRoom() as unknown as SectorRoom;
  }

  it('the room option sets the sector speed, and the snapshot carries the keyframe', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [], timeScale: 2 });
    const client = await harness.connectAs('player-1');
    expect(room().gameClock.scale).toBe(2);
    // Cross-sector world time keeps its own clock.
    expect(gameClock.scale).toBe(1);

    harness.sendThrust(client);
    const snap = await harness.waitForSnapshot(client, 3000);
    expect(snap.timeScale?.s).toBe(2);
    expect(typeof snap.timeScale?.fromTick).toBe('number');
  });

  it('back at 1× the keyframe is gone', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [], timeScale: 0.5 });
    const client = await harness.connectAs('player-1');
    expect(room().gameClock.scale).toBe(0.5);
    expect(room().setTimeScale(1)).toBe(1);
    harness.sendThrust(client);
    const snap = await harness.waitForSnapshot(client, 3000);
    expect(snap.timeScale).toBeUndefined();
  });

  it('a join option sets the speed (test/recording trigger), clamped to 0.25–4', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    await harness.connectAs('player-1', { timeScale: 4 });
    expect(room().gameClock.scale).toBe(4);
    expect(room().setTimeScale(100)).toBe(4);
    expect(room().setTimeScale(0.01)).toBe(0.25);
  });

  it('game time in the sector runs at its speed', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    await harness.connectAs('player-1');
    const r = room();
    r.setTimeScale(2);
    const g0 = r.gameClock.now();
    const w0 = Date.now();
    await new Promise((res) => setTimeout(res, 200));
    const dg = r.gameClock.now() - g0;
    const dw = Date.now() - w0;
    // Count-free: the clock is closed-form, so this holds on any host.
    expect(dg).toBeCloseTo(dw * 2, -1);
  });
});
