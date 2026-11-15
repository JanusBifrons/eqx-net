/**
 * A ship killed by an event shell dies when the DRAWN shell reaches it
 * (hostile review of rail take 6, 2026-11-15): "the cruiser visibly splits
 * 3-5 frames BEFORE the drawn slug reaches its hull (damage number at
 * 4.933 s, split at 4.950 s, slug tip at the hull ~5.0-5.03 s)".
 *
 * The mismatch, in `ColyseusClient`: the slug is drawn on the shell display
 * timeline (`placeShells(displayTick)`, ~`DISPLAY_DELAY_MS` behind the
 * server, plus RTT/2), and its hit's FX are held for it (`navalHitHold`).
 * But the `destroy` event, which arrives in the same server flush as the
 * damage, ran `killSwarmEntity` AT ONCE: the hull left the mirror (the
 * dying-hull hold handed it to its wreck pieces as soon as they arrived,
 * the next frame), the explosion fired, and `flushQueuedDamageFx` released
 * the held hit's number early. So the number (4.933) and the split (4.950)
 * came on the arrival timeline, ~100 ms before the drawn slug got there.
 *
 * Contract: a swarm ship whose death comes with a hit still held for its
 * drawn shell keeps its hull drawn until that shell's display reaches the
 * hit; then it dies (hull hand-over, explosion, number) in that frame. New
 * wreck pieces stay unbuilt until then (`mirror.wreckRevealFromTick`). A
 * lost `shell_end` never keeps a dead ship alive (#16: bounded by the hold's
 * safety deadline). A death with no held shell hit dies at once, as before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { DamageEvent, DestroyEvent } from '../../shared-types/messages.js';
import type { ShellEnd, ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import type { SwarmRenderState } from '../../core/contracts/IRenderer.js';

interface Internals {
  mirror: {
    swarm?: Map<number, SwarmRenderState>;
    explodingShips?: Set<string>;
    projectiles?: Map<string, unknown>;
    pendingDamageNumbers?: Array<{ targetId: string; damage: number }>;
    pendingHealthBarHits?: unknown[];
    pendingEffectTriggers?: unknown[];
    pendingShellEnds?: number[];
    wreckRevealFromTick?: number;
    localPlayerId: string | null;
  };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  clockAnchorServerTick: number;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  handleDestroy(evt: DestroyEvent): void;
  applyShellEnd(msg: ShellEnd): void;
  placeShells(displayTick: number): void;
}

// A slug from x = 0 at 6,000 u/s (100 u/tick), fired at tick 1000: it kills
// the cruiser (swarm entity 7) at tick 1010, x = 1000, and flies on.
const SALVO: ShellSalvo = {
  type: 'shell_salvo', s: 1, o: 'swarm-3', w: 'railgun', t: 1000, n: 600,
  sh: [['slug-1', 0, 0, 6000, 0]],
};
const KILL: DamageEvent = {
  type: 'damage', targetId: 'swarm-7', damage: 7500, newHealth: 0, shooterId: 'swarm-3',
  hitX: 1000, hitY: 0, newShield: 0, shieldMax: 100, hullMax: 6000, hitLayer: 'hull',
};
const DESTROY: DestroyEvent = { type: 'destroy', targetId: 'swarm-7', shooterId: 'swarm-3' };
const PASS_END: ShellEnd = { type: 'shell_end', e: [['slug-1', 1010, 1000, 0, 0, 1]] };

function cruiser(): SwarmRenderState {
  return {
    x: 1000, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, radius: 300, kind: 1, shipKind: 'battleship',
    poseRing: [], ringHead: 0, sleeping: false, lastUpdateTick: 1008,
  } as unknown as SwarmRenderState;
}

describe('a ship killed by an event shell dies when the drawn shell reaches it', () => {
  let clock: MockClock;
  let c: Internals;

  beforeEach(() => {
    clock = new MockClock(50_000);
    c = new ColyseusGameClient(clock) as unknown as Internals;
    c.mirror.localPlayerId = 'me';
    c.mirror.swarm = new Map([[7, cruiser()]]);
    c.mirror.explodingShips = new Set();
    c.mirror.projectiles = new Map();
    c.mirror.pendingDamageNumbers = [];
    c.mirror.pendingHealthBarHits = [];
    c.mirror.pendingEffectTriggers = [];
    c.mirror.pendingShellEnds = [];
    c._shellEvents = true;
    c.clockAnchorServerTick = 1010;
    c._shellStore.applySalvo(SALVO);
  });

  it('the hull, explosion and number wait for the drawn slug, then go in that frame', () => {
    // One server flush: the damage, the destroy, then the shell_end.
    c.handleDamage(KILL);
    c.handleDestroy(DESTROY);
    c.applyShellEnd(PASS_END);
    // The display is ~6 ticks behind: the slug is still drawn in flight.
    c.placeShells(1004);
    expect(c.mirror.projectiles!.has('slug-1')).toBe(true);
    expect(c.mirror.swarm!.has(7), 'the hull is still drawn').toBe(true);
    expect(c.mirror.explodingShips!.has('swarm-7'), 'no explosion yet').toBe(false);
    expect(c.mirror.pendingDamageNumbers, 'no number yet').toHaveLength(0);
    expect(c.mirror.wreckRevealFromTick, 'its new wreck pieces wait too').toBeDefined();
    expect(c.mirror.wreckRevealFromTick!).toBeLessThanOrEqual(1010);
    c.placeShells(1009.6);
    expect(c.mirror.swarm!.has(7)).toBe(true);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(false);
    // The display reaches the hit: it dies now, with its number.
    c.placeShells(1010.1);
    expect(c.mirror.swarm!.has(7), 'hull handed over').toBe(false);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(true);
    expect(c.mirror.pendingDamageNumbers).toHaveLength(1);
    expect(c.mirror.wreckRevealFromTick).toBeUndefined();
  });

  it('a lost shell_end never keeps a dead ship alive (#16)', () => {
    c.handleDamage(KILL);
    c.handleDestroy(DESTROY);
    c.placeShells(1004);
    expect(c.mirror.swarm!.has(7)).toBe(true);
    clock.advance(2_000);
    c.placeShells(1005);
    expect(c.mirror.swarm!.has(7)).toBe(false);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(true);
    expect(c.mirror.wreckRevealFromTick).toBeUndefined();
  });

  it('a death with no held shell hit dies at once, as before', () => {
    c.handleDestroy(DESTROY);
    expect(c.mirror.swarm!.has(7)).toBe(false);
    expect(c.mirror.explodingShips!.has('swarm-7')).toBe(true);
    expect(c.mirror.wreckRevealFromTick).toBeUndefined();
  });
});
