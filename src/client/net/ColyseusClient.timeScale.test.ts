/**
 * Game time scale (stream step 4a): the client turns time into TICKS on the
 * sector's game clock, so its prediction follows the sector's speed with no
 * other code. Two seams:
 *  - `handleSnapshot` reads the `timeScale` keyframe (#16), sets the client's
 *    game speed and re-anchors the tick clock HARD on that snapshot (not the
 *    EWMA ease), in game time;
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

  it('a snapshot keyframe sets the speed and re-anchors hard, in game time', () => {
    const clock = new MockClock(1000);
    const c = asInternals(new ColyseusGameClient(clock));
    c.handleSnapshot(snap(100)); // 1×: first anchor
    expect(c._anchorInitialised).toBe(true);
    clock.advance(50);
    c.handleSnapshot(snap(103, 2)); // the sector goes 2×
    expect(c.gameClock.scale).toBe(2);
    expect(c.clockAnchorServerTick).toBe(103);
    expect(c.clockAnchorPerfNow).toBe(c.gameClock.now());
    // From here 100 wall ms are 200 game ms: 12 ticks, not 6.
    const before = c.gameClock.now();
    clock.advance(100);
    expect(Math.floor((c.gameClock.now() - before) / (1000 / 60))).toBe(12);
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
