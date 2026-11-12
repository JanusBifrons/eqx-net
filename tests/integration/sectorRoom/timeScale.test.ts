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
import type { SnapshotMessage } from '../../../src/shared-types/messages.js';

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

/**
 * Step 3c: the sector's physics world and room loop really tick at 60 × its
 * speed, so ONE GAME SECOND is ~60 ticks at any speed. Host-safe by design
 * (root CLAUDE.md "gate on counts"): a busy host only LOSES ticks, so
 *  - at 0.5× the gate is an UPPER bound (a world ignoring its speed would run
 *    ~120 ticks per game second; load can never push the count up);
 *  - at 2× the gate is a LOWER bound (ignoring the speed gives ~30), and a run
 *    whose worker dropped ticks is INCONCLUSIVE (logged), never a pass or fail.
 */
describe('SectorRoom integration — ticks per game second follow the sector speed', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  async function ticksPerGameSecond(scale: number): Promise<{ ticks: number; dropped: number }> {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    await harness.connectAs('player-1');
    const r = harness.getServerRoom() as unknown as SectorRoom;
    r.setTimeScale(scale);
    // Let the worker take the new schedule, then measure one game second.
    await new Promise((res) => setTimeout(res, 100));
    const i0 = r._internals;
    const t0 = i0.serverTick; const d0 = i0.droppedTicks; const g0 = r.gameClock.now();
    while (r.gameClock.now() - g0 < 1000) await new Promise((res) => setTimeout(res, 20));
    const i1 = r._internals;
    const gameS = (r.gameClock.now() - g0) / 1000;
    return { ticks: (i1.serverTick - t0) / gameS, dropped: i1.droppedTicks - d0 };
  }

  it('at 0.5× a game second is ~60 ticks, not ~120 (upper bound: load-proof)', async () => {
    const { ticks } = await ticksPerGameSecond(0.5);
    console.log(`[time-scale 3c] 0.5x: ${ticks.toFixed(1)} ticks per game second`);
    expect(ticks).toBeLessThan(80);
  }, 20_000);

  it('at 2× a game second is ~60 ticks, not ~30 (lower bound; INCONCLUSIVE on a starved host)', async () => {
    const { ticks, dropped } = await ticksPerGameSecond(2);
    console.log(`[time-scale 3c] 2x: ${ticks.toFixed(1)} ticks per game second, dropped ${dropped}`);
    if (dropped > 0) {
      console.warn('[time-scale 3c] INCONCLUSIVE: the worker dropped ticks (host starved); not asserting');
      return;
    }
    expect(ticks).toBeGreaterThan(45);
  }, 20_000);
});

/**
 * Step 5a: the automatic slowdown. A sector whose ticks run over budget
 * (`tickBurnMs`: real CPU spent each tick) slows ITSELF: its whole game speed
 * drops (not just the physics worker, the old TiDi path that clients saw as
 * jitter), `state.clockRate` mirrors the factor, and each change is a
 * `time_scale_changed` audit event with reason 'load'. A forced speed is the
 * ceiling: load pulls a 2× sector down from 2×, never past it.
 */
describe('SectorRoom integration — the automatic slowdown (time scale 5a)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a sector over its tick budget slows its whole game, and audits it', async () => {
    const { getRecentAudit } = await import('../../../src/server/audit/GameplayAuditLog.js');
    harness = await bootSectorTestServer({ asteroidConfig: [], tickBurnMs: 18, autoTimeScale: true });
    await harness.connectAs('player-1');
    const r = harness.getServerRoom() as unknown as SectorRoom & { state: { clockRate: number } };
    const deadline = Date.now() + 15_000;
    while (r.gameClock.scale >= 1 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    expect(r.gameClock.scale).toBeLessThan(1);
    expect(r.gameClock.scale).toBeGreaterThanOrEqual(0.7);
    // clockRate mirrors the TARGET load factor; the speed glides down to it (dimmer).
    expect(r.state.clockRate).toBeLessThan(1);
    expect(r.gameClock.scale).toBeGreaterThanOrEqual(r.state.clockRate);
    const ev = getRecentAudit().find((e) => e.event === 'time_scale_changed' && e.reason === 'load');
    expect(ev).toBeDefined();
  }, 20_000);

  it('load pulls a forced 2× sector down from 2×, never above it', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [], tickBurnMs: 18, timeScale: 2, autoTimeScale: true });
    await harness.connectAs('player-1');
    const r = harness.getServerRoom() as unknown as SectorRoom;
    const deadline = Date.now() + 15_000;
    while (r.gameClock.scale >= 2 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    expect(r.gameClock.scale).toBeLessThan(2);
    expect(r.gameClock.scale).toBeGreaterThanOrEqual(1.4);
  }, 20_000);
});

/**
 * The dimmer (owner 2026-11-12: "a dial like a dimmer so it transitions
 * smoothly"): a smooth speed change glides at a steady ratio (glideToward) instead
 * of jumping. 1× → 2× takes ~1 s of wall time, passing through the speeds in
 * between; a setup speed (snap) still applies at once.
 */
describe('SectorRoom integration — the speed dimmer', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a smooth change glides through the speeds between, then arrives', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    const cRoom = await harness.connectAs('player-1');
    const r = harness.getServerRoom() as unknown as SectorRoom;
    // Every snapshot sent mid-glide carries the target, so clients glide in
    // step (#15). Collect them all rather than trusting the first one to land
    // mid-glide: on a loaded host the first can arrive after the glide ends.
    const keys: Array<{ s: number; t?: number }> = [];
    cRoom.onMessage('snapshot', (snap: SnapshotMessage) => { if (snap.timeScale) keys.push(snap.timeScale); });
    expect(r.setTimeScale(4, true)).toBe(4); // returns the target (1× → 4× glides for ~2 s)
    expect(r.gameClock.scale).toBe(1); // not yet: it glides
    harness.sendThrust(cRoom);
    const seen: number[] = [];
    const deadline = Date.now() + 8_000;
    while (r.gameClock.scale < 4 && Date.now() < deadline) {
      seen.push(r.gameClock.scale);
      harness.sendThrust(cRoom); // keep the sector broadcasting
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(r.gameClock.scale).toBe(4);
    const midGlide = keys.filter((k) => k.s < 4);
    expect(midGlide.length, 'no snapshot arrived mid-glide').toBeGreaterThan(0);
    for (const k of midGlide) expect(k.t).toBe(4);
    // It passed through intermediate speeds, rising monotonically.
    const between = seen.filter((s) => s > 1.05 && s < 3.9);
    expect(between.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  }, 15_000);

  it('a setup speed (snap) applies at once', async () => {
    harness = await bootSectorTestServer({ asteroidConfig: [] });
    await harness.connectAs('player-1');
    const r = harness.getServerRoom() as unknown as SectorRoom;
    r.setTimeScale(0.5);
    expect(r.gameClock.scale).toBe(0.5);
  });
});
