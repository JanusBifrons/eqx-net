/**
 * Sub-cap wreck pieces stay asleep in a fight (wreck sleep fix, 2026-11-13).
 *
 * The debris soak (docs/architecture/capital-destruction.md "Soak results")
 * found only ~30 % of sub-cap pieces asleep in a live 10-a-side fight. The
 * worker's wake census showed why: ~40 % of wake-ups were small-arms knocks
 * on resting pieces and ~45 % slow ships brushing them, and every wake cost
 * ~9 s of drift down to Rapier's 0.4 u/s sleep threshold. The fix (shared
 * profile numbers, `destruction.ts`):
 *  - a hit on a RESTING piece shoves it only when its uncapped knock is at
 *    least `knockWakeScale` × `wreckKnockMax` (small arms: no);
 *  - a piece slower than `settlePerRadius` × radius and `settleSpin` for
 *    half a second is put to sleep (`World.setSleepSettle`, both twins).
 *
 * Real chain: projectile → DamageRouter → CapitalWreckSubsystem.onWreckHit →
 * the worker; FLAG_SLEEPING from the worker's sleep poll. Game speed 4.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const WRECK_KIND = 4;
const SPEED = 4;

describe('SectorRoom integration — sub-cap wreck pieces stay asleep (wreck sleep fix)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); }, 10_000);

  type Internals = SectorRoom['_internals'];
  async function boot(): Promise<() => Internals> {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime', droneCount: 0, testMode: true, peacefulDrones: true, asteroidConfig: [],
      timeScale: SPEED, subcapWrecks: true,
    });
    await harness.connectActive(randomUUID(), { shipKind: 'fighter', spawnX: -40_000, spawnY: -40_000 });
    const room = harness.getServerRoom() as unknown as SectorRoom;
    return () => room._internals;
  }

  /** Kill a fighter at rest at (x, 0) and wait until all its pieces sleep;
   *  returns their ids and the game seconds it took. */
  async function restingWreck(int: () => Internals, x: number): Promise<{ ids: string[]; s: number }> {
    expect(int().spawnTestDrone('f1', x, 0, 'fighter')).toBe(true);
    await harness.advance(100);
    const at = int().wreckState('f1')!;
    int().applyDamage('f1', 'shooter-x', 1e7, at.x + 20, at.y);
    const deathTick = int().serverTick;
    const ids = [...int().swarmRegistry.all()].filter((r) => r.kind === WRECK_KIND).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (;;) {
      if (ids.every((id) => int().swarmSleeping(id) === true)) break;
      if ((int().serverTick - deathTick) / 60 > 30) throw new Error('pieces never slept');
      await harness.advance(50);
    }
    return { ids, s: (int().serverTick - deathTick) / 60 };
  }

  /** The piece furthest left: a shot from the left meets it first. */
  function leftmost(int: Internals, ids: string[]): string {
    return ids.reduce((a, b) => (int.wreckState(a)!.x <= int.wreckState(b)!.x ? a : b));
  }

  it('small-arms fire leaves a resting piece asleep and still; a heavy hit wakes and shoves it', async () => {
    const int = await boot();
    const { ids } = await restingWreck(int, 3000);
    const id = leftmost(int(), ids);
    const rest = int().wreckState(id)!;

    // Three laser bolts (12 damage each: a fighter's gun) at its centre.
    for (let i = 0; i < 3; i++) {
      int().spawnTestProjectile('shooter-x', rest.x - 300, rest.y, 4000, 0, 'laser', 12);
      await harness.advance(150);
    }
    const after = int().wreckState(id)!;
    expect(int().swarmSleeping(id), 'small arms woke a resting piece').toBe(true);
    expect(Math.hypot(after.x - rest.x, after.y - rest.y), 'small arms moved a resting piece').toBeLessThan(1e-3);

    // A heavy hit (a 5" shell's worth and more) on the same line wakes it and
    // shoves it along the shot.
    int().spawnTestProjectile('shooter-x', rest.x - 300, rest.y, 4000, 0, 'laser', 400);
    await harness.advance(150);
    const shoved = int().wreckState(id)!;
    expect(int().swarmSleeping(id)).toBe(false);
    expect(shoved.x - rest.x, 'the heavy hit moved it along the shot').toBeGreaterThan(1);
  }, 40_000);

  it('a resting piece stays asleep beside a passing ship, and settles fast after a slow nudge; a hard ram still shoves it', async () => {
    const int = await boot();
    const { ids } = await restingWreck(int, 3000);
    const id = leftmost(int(), ids);
    const rest = int().wreckState(id)!;
    const r = int().swarmRegistry.get(id)!.radius;

    // A ship passing close by (60 u clear of the piece's bounding circle) at
    // 150 u/s: no contact, so the piece never wakes.
    expect(int().spawnTestDrone('p1', rest.x - 400, rest.y + r + 60 + 30, 'fighter')).toBe(true);
    await harness.advance(50);
    int().postToWorker({ type: 'SET_POSITION', entityId: 'p1', x: rest.x - 400, y: rest.y + r + 60 + 30, angle: -Math.PI / 2, vx: 150, vy: 0, angvel: 0 });
    for (let t = 0; t < 8; t++) {
      await harness.advance(100);
      expect(int().swarmSleeping(id), 'a passing ship woke the piece').toBe(true);
    }

    // A slow nudge: the ship drifts into the piece at 15 u/s, then is taken
    // away. The piece wakes (it bounces off at up to ~2x the ship speed), but
    // is asleep again within 6 game s (measured ~4 s; before the fix ~7 s:
    // the drift to 0.4 u/s plus Rapier's 2 s timer).
    const nudgeX = rest.x - r - 30;
    int().postToWorker({ type: 'SET_POSITION', entityId: 'p1', x: nudgeX, y: rest.y, angle: -Math.PI / 2, vx: 15, vy: 0, angvel: 0 });
    await harness.advance(400);
    int().postToWorker({ type: 'SET_POSITION', entityId: 'p1', x: rest.x - 5000, y: rest.y - 5000, angle: 0, vx: 0, vy: 0, angvel: 0 });
    const nudgeEnd = int().serverTick;
    const moved = int().wreckState(id)!;
    expect(Math.hypot(moved.x - rest.x, moved.y - rest.y), 'the nudge touched the piece').toBeGreaterThan(0.05);
    let s = Infinity;
    for (;;) {
      await harness.advance(50);
      const e = (int().serverTick - nudgeEnd) / 60;
      if (int().swarmSleeping(id) === true) { s = e; break; }
      if (e > 12) break;
    }
    console.log(`[subcap-wreck-sleep] asleep again ${s.toFixed(1)} game s after a slow nudge`);
    expect(s).toBeLessThan(6);

    // A hard ram (200 u/s) still knocks it about.
    const before = int().wreckState(id)!;
    int().postToWorker({ type: 'SET_POSITION', entityId: 'p1', x: before.x - r - 40, y: before.y, angle: -Math.PI / 2, vx: 200, vy: 0, angvel: 0 });
    await harness.advance(200);
    const rammed = int().wreckState(id)!;
    expect(int().swarmSleeping(id)).toBe(false);
    expect(rammed.x - before.x, 'the ram shoved it').toBeGreaterThan(5);
  }, 60_000);
});
