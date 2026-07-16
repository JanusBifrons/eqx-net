/**
 * Campaign PR 1.2 (anti-patterns review 2026-07, A10 / Part D #3) — the
 * CLIENT half of the 0-damage guard.
 *
 * Playtest history ("Equinox Tweaks" Phase 3): "Sparks and damage still
 * shows for collisions… it just now shows 0s. Which means the entire
 * downstream damage pipeline fires even if its 0 damage." The server RAM
 * path was fixed (P3.3 rounds-before-emit) but the guard landed on ONE
 * side of a two-sided contract (invariant #15): other server sources
 * (missile splash, mining chip) can still emit fractional/0 damage, and
 * `handleDamage` renders whatever arrives — flash, a floating "0", a
 * health-bar hit, and an impact spark.
 *
 * Contract locked here (failing-first, invariant #13):
 *  - a DamageEvent with damage <= 0 produces NO visual FX (no damage
 *    number, no health-bar hit, no impact spark, no damage flash);
 *  - it still applies STATE: the shield-down bit must update, because a
 *    fractional hit can round to 0 while genuinely breaking the shield
 *    (0.4 dmg vs 0.2 shield), and the collider swap keys off this event;
 *  - a damage > 0 event keeps full FX (positive control).
 *
 * Test level: the seam where the bug lives is handleDamage itself (the
 * mountAnglesPreservation.test.ts piercing pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import type { DamageEvent } from '../../shared-types/messages.js';

interface MirrorSubset {
  ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; shieldDown?: boolean }>;
  localPlayerId: string | null;
  pendingDamageNumbers?: Array<{ targetId: string; x: number; y: number; damage: number }>;
  pendingHealthBarHits?: Array<{ entityId: string }>;
  pendingEffectTriggers?: Array<{ kind: string }>;
}

interface Internals {
  mirror: MirrorSubset;
  _damageFlashFrames: Map<string, number>;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

function makeEvent(overrides: Partial<DamageEvent>): DamageEvent {
  return {
    type: 'damage',
    targetId: 'swarm-7',
    damage: 0,
    newHealth: 100,
    shooterId: 'shooter-1',
    hitX: 5,
    hitY: 6,
    newShield: 3,
    shieldMax: 10,
    hullMax: 100,
    hitLayer: 'shield',
    ...overrides,
  } as DamageEvent;
}

describe('handleDamage — 0-damage events carry state but render NO FX (campaign 1.2)', () => {
  let client: ColyseusGameClient;
  let internals: Internals;

  beforeEach(() => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.mirror.localPlayerId = 'me';
    internals.mirror.ships.set('swarm-7', { x: 1, y: 2, vx: 0, vy: 0, angle: 0 });
    internals.mirror.pendingDamageNumbers = [];
    internals.mirror.pendingHealthBarHits = [];
    internals.mirror.pendingEffectTriggers = [];
  });

  it('damage: 0 → no number, no health bar, no spark, no flash', () => {
    internals.handleDamage(makeEvent({ damage: 0, shooterId: 'me' }));
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(0);
    expect(internals.mirror.pendingEffectTriggers).toHaveLength(0);
    expect(internals._damageFlashFrames.has('swarm-7')).toBe(false);
  });

  it('damage: 0 with a shield 0-cross still updates the shieldDown state bit', () => {
    internals.handleDamage(makeEvent({ damage: 0, newShield: 0, hitLayer: 'shield' }));
    expect(internals.mirror.ships.get('swarm-7')!.shieldDown).toBe(true);
    // ...and still no FX.
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(internals.mirror.pendingEffectTriggers).toHaveLength(0);
  });

  it('positive control: damage > 0 keeps the full FX pipeline', () => {
    internals.handleDamage(makeEvent({ damage: 5, shooterId: 'me' }));
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(1);
    expect(internals.mirror.pendingDamageNumbers![0]!.damage).toBe(5);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(1);
    expect(internals.mirror.pendingEffectTriggers).toHaveLength(1);
    expect(internals._damageFlashFrames.get('swarm-7')).toBeGreaterThan(0);
  });
});
