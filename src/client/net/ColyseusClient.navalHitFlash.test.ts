/**
 * Naval hit flash leads the drawn shell (time scale stream, filmed
 * 2026-11-13, time-scale-capitals-4x clip at 0.25×): "a heavy cruiser's
 * whole-hull red hit flash came ~0.3–0.5 s BEFORE the battleship's 16"
 * shells were drawn arriving." Documented in docs/streams/time-scale.md:
 * the hit flash / damage tint fires when the `damage` event ARRIVES, but
 * shells are drawn at the display tick (100 game ms behind), so the flash
 * leads the drawn hit by ~6 ticks + RTT/2 (~0.5 s at 0.25×).
 *
 * Contract locked here (failing-first, invariant #13), at the seam where the
 * bug lives (ColyseusClient sequences `damage` vs the shell display clock):
 *  - a naval shell hit's FX (hull flash, damage number, health-bar hit,
 *    impact spark) wait until the display tick reaches that shell's
 *    `shell_end`, i.e. the frame its burst is drawn;
 *  - the STATE half of the event (shield-down bit) still applies at once;
 *  - a lost `shell_end` never swallows the flash (safety timeout);
 *  - non-shell damage (a beam with no shell on its line) is unchanged.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { DamageEvent } from '../../shared-types/messages.js';
import type { ShellEnd, ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';

interface Internals {
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; shieldDown?: boolean }>;
    localPlayerId: string | null;
    projectiles?: Map<string, unknown>;
    pendingDamageNumbers?: Array<{ targetId: string; damage: number }>;
    pendingHealthBarHits?: Array<{ entityId: string }>;
    pendingEffectTriggers?: Array<{ kind: string }>;
    pendingShellEnds?: number[];
  };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  _damageFlashFrames: Map<string, number>;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  applyShellEnd(msg: ShellEnd): void;
  placeShells(displayTick: number): void;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

// A battleship 16" shell fired at tick 1000 along +x at 1800 u/s
// (30 u/tick). It hits the cruiser at tick 1050, at x = 10 + 50·30 = 1510.
const SALVO: ShellSalvo = {
  type: 'shell_salvo', s: 1, o: 'swarm-3', w: 'naval_xl', t: 1000, n: 120,
  sh: [['proj-1', 10, 20, 1800, 0]],
};
const HIT_X = 1510;
const HIT_Y = 20;
const END: ShellEnd = { type: 'shell_end', e: [['proj-1', 1050, HIT_X, HIT_Y, 0]] };

function shellHit(overrides: Partial<DamageEvent> = {}): DamageEvent {
  return {
    type: 'damage', targetId: 'cruiser', damage: 900, newHealth: 5000,
    shooterId: 'bb-1', hitX: HIT_X, hitY: HIT_Y, newShield: 0, shieldMax: 100,
    hullMax: 6000, hitLayer: 'hull', ...overrides,
  };
}

describe('naval hit flash waits for the drawn shell (display tick)', () => {
  let clock: MockClock;
  let internals: Internals;

  beforeEach(() => {
    clock = new MockClock(10_000);
    internals = asInternals(new ColyseusGameClient(clock));
    internals.mirror.localPlayerId = 'bb-1';
    internals.mirror.ships.set('cruiser', { x: HIT_X, y: HIT_Y, vx: 0, vy: 0, angle: 0 });
    internals.mirror.projectiles = new Map();
    internals.mirror.pendingDamageNumbers = [];
    internals.mirror.pendingHealthBarHits = [];
    internals.mirror.pendingEffectTriggers = [];
    internals.mirror.pendingShellEnds = [];
    internals._shellEvents = true;
    internals._shellStore.applySalvo(SALVO);
  });

  it('the flash is held while the shell is still drawn in flight, and fires with the burst', () => {
    // The damage arrives (server tick 1050) while the display is ~6 ticks behind.
    internals.handleDamage(shellHit());
    expect(internals._damageFlashFrames.has('cruiser')).toBe(false);
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(0);
    expect(internals.mirror.pendingEffectTriggers).toHaveLength(0);
    // State is not held: the shield-down bit lands at once.
    expect(internals.mirror.ships.get('cruiser')!.shieldDown).toBe(true);

    internals.applyShellEnd(END);
    internals.placeShells(1045);
    expect(internals.mirror.projectiles!.has('proj-1')).toBe(true); // still drawn flying
    expect(internals._damageFlashFrames.has('cruiser')).toBe(false);

    internals.placeShells(1050);
    expect(internals.mirror.pendingShellEnds).toEqual([HIT_X, HIT_Y, expect.any(Number)]); // the burst
    expect(internals._damageFlashFrames.get('cruiser')).toBe(6);
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(1);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(1);
    expect(internals.mirror.pendingEffectTriggers).toHaveLength(1);
  });

  it('a splash victim of the same shell waits for the same burst', () => {
    internals.mirror.ships.set('escort', { x: HIT_X + 300, y: HIT_Y, vx: 0, vy: 0, angle: 0 });
    internals.handleDamage(shellHit());
    internals.handleDamage(shellHit({ targetId: 'escort', damage: 50 }));
    internals.applyShellEnd(END);
    internals.placeShells(1049);
    expect(internals._damageFlashFrames.size).toBe(0);
    internals.placeShells(1050.2);
    expect(internals._damageFlashFrames.has('cruiser')).toBe(true);
    expect(internals._damageFlashFrames.has('escort')).toBe(true);
  });

  it('a lost shell_end never swallows the flash (safety timeout)', () => {
    internals.handleDamage(shellHit());
    internals.placeShells(1040);
    expect(internals._damageFlashFrames.has('cruiser')).toBe(false);
    clock.advance(2000);
    internals.placeShells(1041);
    expect(internals._damageFlashFrames.get('cruiser')).toBe(6);
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(1);
  });

  it('a non-shell hit (nowhere near a shell path) flashes at once, as before', () => {
    internals.handleDamage(shellHit({ hitX: HIT_X, hitY: HIT_Y + 400 }));
    expect(internals._damageFlashFrames.get('cruiser')).toBe(6);
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(1);
  });

  it('with shell events off, nothing is held', () => {
    internals._shellEvents = false;
    internals.handleDamage(shellHit());
    expect(internals._damageFlashFrames.get('cruiser')).toBe(6);
  });
});
