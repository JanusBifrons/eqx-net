/**
 * A non-shell hit (beam, ram, missile) on a target drawn on the DRONE
 * timeline shows when the DRAWN target gets there (off-pilot event timing,
 * slice 2/6; docs/architecture/shell-events.md "Stamped release"). Drones are
 * drawn ~100-150 ms in the past piloting and up to ~4 s off pilot; the
 * `damage` event fired its flash / number / health-bar hit / spark on
 * arrival, over a point the drawn drone had not reached. Owner decision
 * 2026-11-22: hits line up with the drawn target in BOTH views (piloting and
 * Command/Build), no mode switch.
 *
 * Contract: `handleDamage` holds a swarm target's FX stamped with the newest
 * snapshot tick (`NavalHitHold.holdStamped`); the per-frame `placeShells`
 * releases them when the drones' read point reaches that stamp. A killing
 * hit (zero-damage state carrier included) holds the death too (`deferKill`).
 * Pilot hulls (local and remote) are not held. Mock clocks only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { DamageEvent, DestroyEvent } from '../../shared-types/messages.js';
import type { ShipRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { STAMPED_HOLD_MARGIN_MS } from './navalHitHold.js';
import {
  getSwarmDisplayDelayMs, resetSwarmTickClock, setSwarmDisplayDelayMode, setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed, swarmArrivalStampMs,
} from './swarmInterpolation.js';

// Off pilot the drone delay grows to cover recent outages (S5-9 gap peak);
// reaching 2 s takes a simulated outage, so that test pins the delay the
// hold reads instead (the hold only reads the value, never sizes it).
const delayOverride = vi.hoisted(() => ({ ms: Number.NaN }));
vi.mock('./swarmInterpolation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./swarmInterpolation.js')>();
  return {
    ...real,
    getSwarmDisplayDelayMs: (): number =>
      (Number.isNaN(delayOverride.ms) ? real.getSwarmDisplayDelayMs() : delayOverride.ms),
  };
});

interface Internals {
  mirror: {
    swarm?: Map<number, SwarmRenderState>;
    ships: Map<string, ShipRenderState>;
    explodingShips?: Set<string>;
    projectiles?: Map<string, unknown>;
    pendingDamageNumbers?: Array<{ targetId: string; x: number; y: number; damage: number }>;
    pendingHealthBarHits?: unknown[];
    pendingEffectTriggers?: unknown[];
    localPlayerId: string | null;
  };
  _shellEvents: boolean;
  _damageFlashFrames: Map<string, number>;
  clockAnchorServerTick: number;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  handleDestroy(evt: DestroyEvent): void;
  placeShells(displayTick: number, frameWallMs?: number): void;
}

const WALL0 = 50_000;
const TICK = 1000;

function hit(targetId: string, damage = 40, newHealth = 60): DamageEvent {
  return {
    type: 'damage', targetId, damage, newHealth, shooterId: 'me',
    hitX: 500, hitY: 20, newShield: 0, shieldMax: 0, hullMax: 100, hitLayer: 'hull',
  };
}

function drone(): SwarmRenderState {
  return {
    x: 480, y: 20, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 20, kind: 1, shipKind: 'fighter',
    poseRing: [], ringHead: 0, sleeping: false, lastUpdateTick: TICK,
  } as unknown as SwarmRenderState;
}

function ship(): ShipRenderState {
  return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, health: 100 } as unknown as ShipRenderState;
}

describe('non-shell hits on drawn-timeline targets wait for the drawn target', () => {
  let clock: MockClock;
  let c: Internals;
  let delay: number;

  /** One frame at wall `t`, shells not as events. */
  const frame = (t: number): void => c.placeShells(Number.NaN, t);
  const flashed = (id: string): boolean => c._damageFlashFrames.has(id);

  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    clock = new MockClock(WALL0);
    c = new ColyseusGameClient(clock) as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.mirror.ships.set('me', ship());
    c.mirror.ships.set('p2', ship());
    c.mirror.swarm = new Map([[7, drone()]]);
    c.mirror.explodingShips = new Set();
    c.mirror.projectiles = new Map();
    c.mirror.pendingDamageNumbers = [];
    c.mirror.pendingHealthBarHits = [];
    c.mirror.pendingEffectTriggers = [];
    c._shellEvents = false;
    c.clockAnchorServerTick = TICK;
    // Seed the drone tick clock: tick TICK is stamped at WALL0.
    expect(swarmArrivalStampMs(TICK, WALL0)).toBe(WALL0);
    setSwarmDisplayDelayMs(150);
    delay = getSwarmDisplayDelayMs();
    expect(delay).toBeGreaterThanOrEqual(100);
  });
  afterEach(() => { delayOverride.ms = Number.NaN; resetSwarmTickClock(); setSwarmDisplaySpeed(1); });

  it('piloting: a beam hit on a drone drawn ~150 ms late shows when the read point reaches it', () => {
    c.handleDamage(hit('swarm-7'));
    frame(WALL0);
    frame(WALL0 + delay - 1);
    expect(flashed('swarm-7')).toBe(false);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(c.mirror.pendingHealthBarHits).toHaveLength(0);
    expect(c.mirror.pendingEffectTriggers).toHaveLength(0);
    frame(WALL0 + delay);
    expect(flashed('swarm-7')).toBe(true);
    // Number and spark at the event's hit point: the drawn drone is at the
    // stamped tick's pose now, which is where the server hit it.
    expect(c.mirror.pendingDamageNumbers).toEqual([{ targetId: 'swarm-7', x: 500, y: 20, damage: 40 }]);
    expect(c.mirror.pendingHealthBarHits).toHaveLength(1);
    expect(c.mirror.pendingEffectTriggers).toHaveLength(1);
  });

  it('off pilot: a hit on a drone drawn 2 s late waits the 2 s', () => {
    // Off pilot (Command / Build), drones drawn 2 s late.
    setSwarmDisplayDelayMode('offPilot');
    delayOverride.ms = 2000;
    delay = 2000;
    c.handleDamage(hit('swarm-7'));
    clock.advance(delay - 1);
    frame(WALL0 + delay - 1);
    expect(flashed('swarm-7')).toBe(false);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(0);
    clock.advance(1);
    frame(WALL0 + delay);
    expect(flashed('swarm-7')).toBe(true);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(1);
  });

  it('a killing beam hit defers the drone removal and explosion to the drawn arrival', () => {
    c.handleDamage(hit('swarm-7', 60, 0));
    c.handleDestroy({ type: 'destroy', targetId: 'swarm-7', shooterId: 'me' });
    frame(WALL0 + delay - 1);
    expect(c.mirror.swarm!.has(7), 'still drawn alive').toBe(true);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(false);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(0);
    frame(WALL0 + delay);
    expect(c.mirror.swarm!.has(7)).toBe(false);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(true);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(1);
  });

  it('a zero-damage killing event (state carrier) defers the death too, with no FX', () => {
    c.handleDamage(hit('swarm-7', 0, 0));
    c.handleDestroy({ type: 'destroy', targetId: 'swarm-7', shooterId: 'me' });
    frame(WALL0 + delay - 1);
    expect(c.mirror.swarm!.has(7)).toBe(true);
    frame(WALL0 + delay);
    expect(c.mirror.swarm!.has(7)).toBe(false);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(true);
    expect(flashed('swarm-7'), 'no flash for a 0').toBe(false);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(c.mirror.pendingEffectTriggers).toHaveLength(0);
  });

  it('a zero-damage event that does not kill is still state only (not held)', () => {
    c.handleDamage(hit('swarm-7', 0, 60));
    c.handleDestroy({ type: 'destroy', targetId: 'swarm-7', shooterId: 'me' });
    expect(c.mirror.swarm!.has(7), 'no held kill: dies at once').toBe(false);
  });

  it('local-ship and remote-ship hits are NOT held', () => {
    c.handleDamage(hit('me'));
    c.handleDamage(hit('p2'));
    expect(flashed('me')).toBe(true);
    expect(flashed('p2')).toBe(true);
    expect(c.mirror.pendingEffectTriggers).toHaveLength(2);
  });

  it('before the drone tick clock is seeded, a drone hit shows at once', () => {
    resetSwarmTickClock();
    c.handleDamage(hit('swarm-7'));
    expect(flashed('swarm-7')).toBe(true);
  });

  it('a tick-clock re-seed while held keeps the stamp taken at hold time', () => {
    c.handleDamage(hit('swarm-7'));
    // Packets suddenly arrive 5 s later than the fitted clock: re-seed.
    swarmArrivalStampMs(TICK + 1, WALL0 + 5000);
    frame(WALL0 + delay - 1);
    expect(flashed('swarm-7')).toBe(false);
    frame(WALL0 + delay);
    expect(flashed('swarm-7')).toBe(true);
  });

  it('a read point that never arrives (stalled stream) releases at the deadline', () => {
    c.handleDamage(hit('swarm-7'));
    clock.advance(delay + STAMPED_HOLD_MARGIN_MS - 1);
    frame(Number.NaN);
    expect(flashed('swarm-7')).toBe(false);
    clock.advance(1);
    frame(Number.NaN);
    expect(flashed('swarm-7')).toBe(true);
  });
});
