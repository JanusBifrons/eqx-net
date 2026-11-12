/**
 * Game time scale (stream step 4a): the client turns time into TICKS on the
 * sector's game clock, so its prediction follows the sector's speed with no
 * other code. Two seams:
 *  - `handleSnapshot` reads the `timeScale` keyframe (#16) and sets the client's
 *    game speed; the tick anchor (game ms) stays valid across the change and
 *    the usual eased path absorbs the timing difference (the server glides
 *    speed changes, the dimmer);
 *  - the render dead-reckon between ticks measures elapsed GAME time, so at
 *    0.5× a ship is drawn moving half as far per wall ms.
 * And at 1× nothing changes: the game clock IS the injected clock, exactly.
 */
import { describe, it, expect } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { GameClock } from '../../core/clock/GameClock.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';

interface Internals {
  gameClock: GameClock;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  _anchorInitialised: boolean;
  handleSnapshot(snap: SnapshotMessage): void;
  updateMirror(): void;
  predWorld: PhysicsWorld | null;
  reconciler: unknown;
  mirror: { ships: Map<string, { x: number; y: number }>; localPlayerId: string | null };
  lastFrameMs: number;
  _lastLocalTickAtMs: number;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function snap(serverTick: number, s?: number): SnapshotMessage {
  return {
    type: 'snapshot', serverTick, ackedTick: 0, states: {},
    ...(s !== undefined ? { timeScale: { s, fromTick: serverTick } } : {}),
  } as SnapshotMessage;
}

describe('client game time follows the sector speed (time scale 4a)', () => {
  it('at 1× the game clock is the injected clock, exactly', () => {
    const clock = new MockClock(1234.567);
    const c = asInternals(new ColyseusGameClient(clock));
    expect(c.gameClock.now()).toBe(1234.567);
    clock.advance(0.1);
    expect(c.gameClock.now()).toBe(clock.now());
    expect(c.gameClock.at(99.3)).toBe(99.3);
  });

  it('a snapshot keyframe sets the speed; the anchor stays continuous in game time', () => {
    const clock = new MockClock(1000);
    const c = asInternals(new ColyseusGameClient(clock));
    c.handleSnapshot(snap(100)); // 1×: first anchor
    expect(c._anchorInitialised).toBe(true);
    clock.advance(50);
    const gameBefore = c.gameClock.now();
    c.handleSnapshot(snap(103, 2)); // the sector glides to 2× (dimmer step)
    expect(c.gameClock.scale).toBe(2);
    // No jump in game time at the change, and the anchor stays a valid
    // (serverTick ↔ game ms) pair: the eased path moved it, no hard snap.
    expect(c.gameClock.now()).toBe(gameBefore);
    expect(Math.abs(c.clockAnchorPerfNow - c.gameClock.now())).toBeLessThan(100);
    // From here 100 wall ms are 200 game ms: 12 ticks, not 6.
    const before = c.gameClock.now();
    clock.advance(100);
    expect(Math.floor((c.gameClock.now() - before) / (1000 / 60))).toBe(12);
  });

  it('through a glide the client extrapolates the server speed (no lag)', () => {
    const clock = new MockClock(1000);
    const client = new ColyseusGameClient(clock);
    const c = asInternals(client) as Internals & { followSpeedGlide(): void; _lastSnapshotRecvAtMs: number };
    c._lastSnapshotRecvAtMs = 1000;
    c.handleSnapshot({ ...snap(100), timeScale: { s: 1, fromTick: 100, t: 2 } } as SnapshotMessage);
    expect(c.gameClock.scale).toBe(1);
    clock.advance(500); // 0.5 s later, no new snapshot: the server is at √2×
    c.followSpeedGlide();
    expect(c.gameClock.scale).toBeCloseTo(Math.SQRT2, 5);
    clock.advance(5000);
    c.followSpeedGlide();
    expect(c.gameClock.scale).toBe(2); // arrives, never overshoots
  });

  it('a snapshot without a keyframe returns the speed to 1×', () => {
    const clock = new MockClock(0);
    const c = asInternals(new ColyseusGameClient(clock));
    c.handleSnapshot(snap(10, 0.5));
    expect(c.gameClock.scale).toBe(0.5);
    c.handleSnapshot(snap(11));
    expect(c.gameClock.scale).toBe(1);
  });

  it('the render dead-reckon between ticks measures GAME time', async () => {
    const clock = new MockClock(0);
    const client = new ColyseusGameClient(clock);
    const c = asInternals(client);
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('p1', 100, 200, 'interceptor');
    c.predWorld.setShipState('p1', { x: 100, y: 200, vx: 60, vy: 0, angle: 0, angvel: 0 });
    c.reconciler = { lerpOffset: { x: 0, y: 0 }, lerpAngleOffset: 0, isLerping: false, advanceLerp() {} };
    c.mirror.localPlayerId = 'p1';
    c.lastFrameMs = 16;
    c.gameClock.setScale(0.5);
    c._lastLocalTickAtMs = c.gameClock.now();
    clock.advance(16); // 16 wall ms = 8 game ms at 0.5×
    c.updateMirror();
    expect(c.mirror.ships.get('p1')!.x).toBeCloseTo(100 + 60 * 0.008, 3);
  });
});

describe('world motion between snapshots follows the speed (time scale)', () => {
  it('a projectile is extrapolated by GAME time: half as far per frame at 0.5×', async () => {
    const clock = new MockClock(0);
    const client = new ColyseusGameClient(clock);
    const c = asInternals(client) as Internals & { mirror: { projectiles?: Map<string, { x: number; y: number; vx: number; vy: number }> } };
    c.predWorld = await PhysicsWorld.create();
    c.predWorld.spawnShip('p1', 0, 0, 'interceptor');
    c.reconciler = { lerpOffset: { x: 0, y: 0 }, lerpAngleOffset: 0, isLerping: false, advanceLerp() {} };
    c.mirror.localPlayerId = 'p1';
    c.mirror.projectiles = new Map([['b1', { x: 0, y: 0, vx: 100, vy: 0 }]]);
    c.lastFrameMs = 100;
    c.gameClock.setScale(0.5);
    c.updateMirror();
    expect(c.mirror.projectiles.get('b1')!.x).toBeCloseTo(5, 5); // 100 u/s × 50 game ms
  });
});
