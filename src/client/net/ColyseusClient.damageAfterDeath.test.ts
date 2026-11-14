/**
 * Damage numbers after death (hostile review of filmed fight clips,
 * 2026-11-13): "floating damage numbers keep CLIMBING over a ship AFTER it
 * has exploded."
 *
 * Two client queues deliberately delay a hit's number past its arrival:
 *  - smooth-beam splits (`_scheduledDamageSpawns`): a predicted hitscan hit
 *    is shown as 5 ticks spread over the weapon cooldown;
 *  - the naval hit hold (`navalHitHold.ts`): a shell hit's FX wait for the
 *    drawn burst.
 * When the target is destroyed while some of these are still queued, they
 * used to land AFTER the explosion (the number climbs over the wreck). The
 * hits are real (dealt before the death), so they are not dropped: the kill
 * releases them at once, in the explosion's frame.
 *
 * Contract locked here (failing-first, invariant #13), at the seam where the
 * bug lives (ColyseusClient sequences the queues vs the `destroy` event).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { MockClock } from '../../core/clock/Clock.js';
import type { DamageEvent, DestroyEvent } from '../../shared-types/messages.js';
import type { ShellSalvo } from '../../shared-types/messages/shellEvents.js';
import type { ShellSalvoStore } from './shellSalvoStore.js';
import type { NavalHitHold } from './navalHitHold.js';

interface Scheduled { atMs: number; targetId: string; x: number; y: number; damage: number; tag: string }
interface Internals {
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>;
    localPlayerId: string | null;
    projectiles?: Map<string, unknown>;
    pendingDamageNumbers?: Array<{ targetId: string; damage: number; tag?: string }>;
    pendingShellEnds?: number[];
  };
  _shellEvents: boolean;
  _shellStore: ShellSalvoStore;
  _navalHitHold: NavalHitHold;
  _scheduledDamageSpawns: Scheduled[];
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
  handleDestroy(evt: DestroyEvent): void;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

const destroy = (targetId: string): DestroyEvent =>
  ({ type: 'destroy', targetId } as unknown as DestroyEvent);

describe('queued damage numbers land with the explosion, never after it', () => {
  let clock: MockClock;
  let internals: Internals;

  beforeEach(() => {
    clock = new MockClock(10_000);
    internals = asInternals(new ColyseusGameClient(clock));
    internals.mirror.localPlayerId = 'me';
    internals.mirror.ships.set('target', { x: 100, y: 0, vx: 0, vy: 0, angle: 0 });
    internals.mirror.ships.set('other', { x: 900, y: 0, vx: 0, vy: 0, angle: 0 });
    internals.mirror.pendingDamageNumbers = [];
  });

  it('smooth-beam splits still queued for the killed target spawn at the kill', () => {
    const now = clock.now();
    internals._scheduledDamageSpawns.push(
      { atMs: now + 40, targetId: 'target', x: 100, y: 0, damage: 4, tag: 's1' },
      { atMs: now + 80, targetId: 'other', x: 900, y: 0, damage: 4, tag: 's2' },
      { atMs: now + 120, targetId: 'target', x: 100, y: 0, damage: 6, tag: 's1' },
    );
    internals.handleDestroy(destroy('target'));
    const pending = internals.mirror.pendingDamageNumbers!;
    expect(pending.map((p) => [p.targetId, p.damage, p.tag])).toEqual([
      ['target', 4, 's1'],
      ['target', 6, 's1'],
    ]);
    // Nothing for the dead target is left to land later; the live one's
    // split keeps its schedule.
    expect(internals._scheduledDamageSpawns.map((s) => s.targetId)).toEqual(['other']);
  });

  it('a held naval hit on the killed target releases at the kill', () => {
    const salvo: ShellSalvo = {
      type: 'shell_salvo', s: 1, o: 'bb-1', w: 'naval_xl', t: 1000, n: 120,
      sh: [['proj-1', 10, 0, 1800, 0]],
    };
    internals.mirror.projectiles = new Map();
    internals.mirror.pendingShellEnds = [];
    internals._shellEvents = true;
    internals._shellStore.applySalvo(salvo);
    const hit: DamageEvent = {
      type: 'damage', targetId: 'target', damage: 900, newHealth: 0,
      shooterId: 'bb-1', hitX: 100, hitY: 0, newShield: 0, shieldMax: 100,
      hullMax: 6000, hitLayer: 'hull',
    };
    internals.handleDamage(hit);
    expect(internals._navalHitHold.size).toBe(1); // held for the drawn burst
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);

    internals.handleDestroy(destroy('target'));
    expect(internals._navalHitHold.size).toBe(0);
    expect(internals.mirror.pendingDamageNumbers!.map((p) => [p.targetId, p.damage])).toEqual([
      ['target', 900],
    ]);
  });
});
