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
import { ColyseusGameClient, isNoDamageNumberTarget, isUnseenSwarmTarget, isWreckPieceTarget } from './ColyseusClient.js';
import type { DamageEvent } from '../../shared-types/messages.js';

interface MirrorSubset {
  ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number }>;
  swarm?: Map<number, { kind: number; x: number; y: number; shipKind?: string }>;
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
      [104, { kind: 0, x: 2, y: 2 }], // a field rock (mining is not combat: no number)
      [105, { kind: 3, x: 3, y: 3, shipKind: 'cargo-pod' }], // an ore/loot pod (salvage: no number)
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

  /**
   * Round-2 review: "12" and "36" seen over unlabelled wreckage at 30 s / 40 s
   * of the fleet-fight take. Every server damage path (player and NPC bolts,
   * NPC beams, missile splash, rams, the killing blow) reaches the client
   * through the ONE `damage` broadcast (`DamageRouter.applyInteraction`) and
   * this one handler, so the guard covers each of them; one case per shape.
   * (The numbers in the frames sat on loot pods: scrap, kind 3, numbered by
   * design, see the positive control below.)
   */
  for (const [what, evt] of [
    ['an NPC bolt', { ...hit('swarm-101'), shooterId: 'swarm-102' }],
    ['an NPC beam (impact point from the beam)', { ...hit('swarm-101'), shooterId: 'swarm-102', hitX: 4.5, hitY: 6.5 }],
    ['missile splash (no hit point)', { ...hit('swarm-101'), hitX: undefined, hitY: undefined }],
    ['a shield-layer hit', { ...hit('swarm-101'), hitLayer: 'shield', newShield: 3, shieldMax: 10 }],
    ['the killing blow', { ...hit('swarm-101'), newHealth: 0 }],
  ] as const) {
    it(`wreck piece, ${what}: no number, no health bar`, () => {
      internals.handleDamage(evt as DamageEvent);
      expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
      expect(internals.mirror.pendingHealthBarHits).toHaveLength(0);
    });
  }

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
it('a field rock (kind 0): no number; health bar and flash stay; a ship still gets one', () => {
    internals.mirror.ships.set('player-7', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    internals.handleDamage(hit('swarm-104'));
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(internals.mirror.pendingHealthBarHits).toHaveLength(1);
    expect(internals._damageFlashFrames.has('swarm-104')).toBe(true);
    internals.handleDamage(hit('player-7'));
    expect(internals.mirror.pendingDamageNumbers!.map((d) => d.targetId)).toEqual(['player-7']);
  });

  it('isNoDamageNumberTarget: rocks and wreck pieces (incl. rock pieces) only', () => {
    const swarm = internals.mirror.swarm as unknown as Parameters<typeof isNoDamageNumberTarget>[1];
    expect(isNoDamageNumberTarget('swarm-104', swarm)).toBe(true);
    expect(isNoDamageNumberTarget('swarm-101', swarm)).toBe(true);
    expect(isNoDamageNumberTarget('swarm-102', swarm)).toBe(false);
    expect(isNoDamageNumberTarget('swarm-103', swarm)).toBe(false);
    expect(isNoDamageNumberTarget('swarm-999', swarm)).toBe(false);
    // An ore pod (a cut rock's sliver, barge-mining take 2026-11-16): the
    // mining lasers and tractored pieces hit it; it is salvage, not a foe.
    expect(isNoDamageNumberTarget('swarm-105', swarm)).toBe(true);
    internals.handleDamage(hit('swarm-105'));
    expect(internals.mirror.pendingDamageNumbers).toHaveLength(0);
    expect(isNoDamageNumberTarget('player-104', swarm)).toBe(false);
  });

  /**
   * Stern-clip take (owner, 2026-11-16: "some weird damage number that came
   * up at the end"): a red 260 in empty space in the beam, beside the
   * frigate's bow wreck. The beam wore the bow piece out; it turned to a
   * salvage pod (`dropPieceSalvage`) on its own spot, in the beam, and the
   * next pulse (260) killed the pod. The pod lived one pulse: its damage
   * event came before any snapshot listing it, so the client never drew it
   * and could not tell it was a pod. A hit on a swarm entity the client has
   * no entry for gets no number: nothing is drawn there.
   */
  it('a swarm target the client has no entry for (spawned and killed between snapshots): no number', () => {
    internals.handleDamage({ ...hit('swarm-999'), damage: 260, newHealth: 0 });
    expect(internals.mirror.pendingDamageNumbers, 'a number over nothing').toHaveLength(0);
    // The flash and spark stay (the beam did hit there); only the number goes.
    expect(internals.mirror.pendingEffectTriggers!.map((t) => t.kind)).toEqual(['impact']);
    const swarm = internals.mirror.swarm as unknown as Parameters<typeof isUnseenSwarmTarget>[1];
    expect(isUnseenSwarmTarget('swarm-999', swarm)).toBe(true);
    expect(isUnseenSwarmTarget('swarm-999', undefined)).toBe(true);
    expect(isUnseenSwarmTarget('swarm-105', swarm)).toBe(false);
    expect(isUnseenSwarmTarget('player-999', swarm)).toBe(false);
    // Once the snapshot lists it, it is numbered by kind as usual.
    internals.handleDamage(hit('swarm-102'));
    expect(internals.mirror.pendingDamageNumbers!.map((d) => d.targetId)).toEqual(['swarm-102']);
    // A ship keyed `swarm-…` in the ships mirror keeps its number.
    internals.mirror.ships.set('swarm-7', { x: 0, y: 0, vx: 0, vy: 0, angle: 0 });
    internals.handleDamage(hit('swarm-7'));
    expect(internals.mirror.pendingDamageNumbers!.map((d) => d.targetId)).toEqual(['swarm-102', 'swarm-7']);
  });
});

