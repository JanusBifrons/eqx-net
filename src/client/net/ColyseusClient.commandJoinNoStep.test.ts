/**
 * The input loop's over-prediction cap with no acked input (capital-fixes S1).
 *
 * Symptom (phone capture 2026-11-22T15-01-03Z-p7uotg): joining a sector
 * straight into Command view ran at ~14 fps; a pilot swap restored 90 Hz.
 *
 * Cause: the cap in `tickPhysics` only applied once `lastAckedTick > 0`. A
 * Command join never pilots, so nothing is acked and the loop stepped the
 * whole-sector prediction world 4 ticks a frame forever.
 *
 * Fix: no own body to predict (no Reconciler) ⇒ no stepping at all; an own
 * body with nothing acked yet is capped from the latest server tick (the clock
 * anchor) instead of not at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { Reconciler } from '../../core/prediction/Reconciler.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import { MAX_OVER_PREDICTION_TICKS } from './prediction/inputStep.js';

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
  stats: { lastAckedTick: number };
}

async function makeClient(): Promise<{ client: ColyseusGameClient; c: Internals; clock: MockClock }> {
  const clock = new MockClock(10_000);
  const client = new ColyseusGameClient(clock);
  const c = client as unknown as Internals;
  c.room = { send: () => {} };
  c.keyboard = {
    read: () => ({ thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false, fire: false }),
  };
  c.predWorld = await PhysicsWorld.create();
  c.mirror.localPlayerId = 'p1';
  c.welcomePerfNow = clock.now();
  c.clockAnchorServerTick = 1000;
  c.clockAnchorPerfNow = c.gameClock.now();
  c._anchorFreshAtMs = clock.now();
  c.stats.lastAckedTick = 0; // nothing acked yet
  return { client, c, clock };
}

describe('tickPhysics with no acked input', () => {
  it('a Command join (no own body, no Reconciler) does not step the prediction world', async () => {
    const { client, c, clock } = await makeClient();
    c.predWorld!.spawnShip('remote-1', 50, 0, 'interceptor'); // a remote / AI-flown hull
    c.reconciler = null;
    c.leadTicks = 6;
    c.inputTick = 1000;
    const tickSpy = vi.spyOn(c.predWorld!, 'tick');
    for (let i = 0; i < 30; i++) {
      clock.advance(70); // a slow phone frame: >4 ticks due every frame
      c._anchorFreshAtMs = clock.now();
      client.tickPhysics(70);
    }
    expect(tickSpy).not.toHaveBeenCalled();
    // The stall skip may move the counter (no physics), never past the cap.
    expect(c.inputTick).toBeLessThanOrEqual(1000 + MAX_OVER_PREDICTION_TICKS);
  });

  it('an own body with nothing acked stops at the anchor tick + the cap', async () => {
    const { client, c, clock } = await makeClient();
    c.predWorld!.spawnShip('p1', 0, 0, 'interceptor');
    c.reconciler = new Reconciler(c.predWorld!, 'p1', clock);
    c.leadTicks = MAX_OVER_PREDICTION_TICKS + 20; // target well past the cap
    c.inputTick = 1000 + MAX_OVER_PREDICTION_TICKS - 25; // inside the stall-skip bound: plain stepping
    const tickSpy = vi.spyOn(c.predWorld!, 'tick');
    for (let i = 0; i < 20; i++) {
      client.tickPhysics(16);
      expect(c.inputTick).toBeLessThanOrEqual(1000 + MAX_OVER_PREDICTION_TICKS);
    }
    expect(c.inputTick).toBe(1000 + MAX_OVER_PREDICTION_TICKS);
    expect(tickSpy).toHaveBeenCalledTimes(25);
    // A fresh snapshot moves the anchor (the latest server tick): stepping resumes.
    c.clockAnchorServerTick = 1010;
    c.clockAnchorPerfNow = c.gameClock.now();
    client.tickPhysics(16);
    expect(c.inputTick).toBeGreaterThan(1000 + MAX_OVER_PREDICTION_TICKS);
    expect(c.inputTick).toBeLessThanOrEqual(1010 + MAX_OVER_PREDICTION_TICKS);
  });
});
