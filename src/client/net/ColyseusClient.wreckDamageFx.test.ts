/**
 * Sub-capital break-up review (hostile review 2026-11-13, 30-v-30 fleet
 * fight, sub-cap wrecks on): "Damage numbers keep climbing after a ship
 * dies. Shots hitting a dead ship's wreck pieces add to the dead ship's
 * floating damage number (168 → 180 → 192 → 204 after the explosion)."
 *
 * A wreck piece (swarm kind 4) is debris, not a ship: a hit on it shows the
 * impact spark (and the hit flash), but NO floating damage number and NO
 * health bar. The number coalesces by screen spot (`MERGE_RADIUS_PX`), so a
 * number for a piece folded into the dead ship's still-live bucket. Decided
 * for capitals too: no number on any wreck piece, whatever its profile.
 *
 * Test level: `handleDamage`, the seam both the authoritative path and the
 * naval-hit hold release go through (the predicted path shares the guard).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient, isWreckPieceTarget } from './ColyseusClient.js';
import type { DamageEvent } from '../../shared-types/messages.js';

interface MirrorSubset {
  ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>;
  swarm?: Map<number, { kind: number; x: number; y: number }>;
  localPlayerId: string | null;
  pendingDamageNumbers?: Array<{ targetId: string }>;
  pendingHealthBarHits?: Array<{ entityId: string }>;
  pendingEffectTriggers?: Array<{ kind: string }>;
}
interface Internals {
  mirror: MirrorSubset;
  _damageFlashFrames: Map<string, number>;
  handleDamage(evt: DamageEvent, suppressNumber?: boolean): void;
}

function hit(targetId: string): DamageEvent {
  return {
    type: 'damage', targetId, damage: 12, newHealth: 18, shooterId: 'me', hitX: 5, hitY: 6,
    newShield: 0, shieldMax: 0, hullMax: 30, hitLayer: 'hull',
  } as DamageEvent;
}

describe('a hit on a wreck piece: spark only, no damage number or health bar', () => {
  let internals: Internals;
  beforeEach(() => {
    internals = new ColyseusGameClient() as unknown as Internals;
    internals.mirror.localPlayerId = 'me';
    internals.mirror.swarm = new Map([
      [101, { kind: 4, x: 5, y: 6 }], // a wreck piece (sub-cap or capital alike)
      [102, { kind: 1, x: 9, y: 9 }], // a live drone
      [103, { kind: 3, x: 1, y: 1 }], // scrap (unchanged: still numbered)
    ]);
    internals.mirror.pendingDamageNumbers = [];
    internals.mirror.pendingHealthBarHits = [];
    internals.mirror.pendingEffectTriggers = [];
  });

  it('wreck piece: no number, no health bar; the spark and the flash stay', () => {
    internals.handleDamage(hit('swarm-101'));
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(0);
    expect(internals.mirror.pendingEffectTriggers!.map((t) => t.kind)).toEqual(['impact']);
    expect(internals._damageFlashFrames.has('swarm-101')).toBe(true);
  });

  it('a live drone and scrap keep their numbers (positive control)', () => {
    internals.handleDamage(hit('swarm-102'));
    internals.handleDamage(hit('swarm-103'));
    expect(internals.mirror.pendingDamageNumbers!.map((d) => d.targetId)).toEqual(['swarm-102', 'swarm-103']);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(2);
  });

  it('isWreckPieceTarget: only swarm-<id> whose entry is kind 4', () => {
    const swarm = internals.mirror.swarm as unknown as Parameters<typeof isWreckPieceTarget>[1];
    expect(isWreckPieceTarget('swarm-101', swarm)).toBe(true);
    expect(isWreckPieceTarget('swarm-102', swarm)).toBe(false);
    expect(isWreckPieceTarget('swarm-999', swarm)).toBe(false);
    expect(isWreckPieceTarget('swarm-', swarm)).toBe(false);
    expect(isWreckPieceTarget('swarm-10x', swarm)).toBe(false);
    expect(isWreckPieceTarget('player-101', swarm)).toBe(false);
    expect(isWreckPieceTarget('swarm-101', undefined)).toBe(false);
  });
});
