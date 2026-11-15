/**
 * Ticks stay whole when a stall is skipped at a slowed sector speed.
 *
 * Symptom (tests/e2e/warp-engage-cancel.spec.ts on a loaded box): a
 * main-thread `TypeError: Cannot set properties of undefined (setting 'tick')`
 * from `Reconciler.recordInput` on the first frames after the loading curtain.
 *
 * Cause: the lead is scaled by the sector speed (`gameLeadTicks()` =
 * `leadTicks × gameClock.scale`), so at a slowed speed (the load controller
 * drops to 0.7–1×) `targetTick` is fractional. Skipping the loading-curtain
 * stall set `inputTick = targetTick - 1`, a fractional tick; every later tick
 * kept the fraction, and `recordInput` indexed its ring buffer with
 * `tick % 128` = a fractional index, i.e. an undefined slot. The RAF loop died
 * on every frame. The starvation recovery (`ackedTick + lead`) had the same
 * hole.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { Reconciler } from '../../core/prediction/Reconciler.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { GameClock } from '../../core/clock/GameClock.js';

interface Internals {
  room: unknown;
  keyboard: unknown;
  gameClock: GameClock;
  welcomePerfNow: number;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  _anchorFreshAtMs: number;
  inputTick: number;
  leadTicks: number;
  predWorld: PhysicsWorld | null;
  reconciler: Reconciler | null;
  mirror: { localPlayerId: string | null };
}

describe('a stall skipped at a slowed sector speed keeps inputTick whole', () => {
  it('tickPhysics records inputs without throwing at 0.87x after a curtain stall', async () => {
    const clock = new MockClock(10_000);
    const client = new ColyseusGameClient(clock);
    const c = client as unknown as Internals;
    const sent: unknown[] = [];
    c.room = { send: (_t: string, m: unknown) => sent.push(m) };
    c.keyboard = {
      read: () => ({ thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false, fire: false }),
    };
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('p1', 0, 0, 'interceptor');
    c.reconciler = new Reconciler(c.predWorld, 'p1', clock);
    c.mirror.localPlayerId = 'p1';
    c.leadTicks = 6;
    // The welcome anchored the clock at tick 1000, then the loading curtain
    // held tickPhysics for 2 s while the sector ran slowed by load.
    c.gameClock.setScale(0.873);
    c.welcomePerfNow = clock.now();
    c.clockAnchorServerTick = 1000;
    c.clockAnchorPerfNow = c.gameClock.now();
    c.inputTick = 1000;
    clock.advance(2000);
    c._anchorFreshAtMs = clock.now(); // a snapshot just re-synced: the stall is skipped

    expect(() => client.tickPhysics(16)).not.toThrow();
    expect(Number.isInteger(c.inputTick)).toBe(true);
    expect(c.inputTick).toBeGreaterThan(1030); // the backlog was skipped, not replayed
    for (let i = 0; i < 5; i++) {
      clock.advance(16);
      expect(() => client.tickPhysics(16)).not.toThrow();
      expect(Number.isInteger(c.inputTick)).toBe(true);
    }
  });
});
