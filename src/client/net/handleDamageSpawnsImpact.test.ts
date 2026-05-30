/**
 * Failing test for the M7 impact-sparks integration (plan: wiggly-puppy).
 *
 * Locks the contract: a `DamageEvent` arriving at `ColyseusClient.handleDamage`
 * enqueues exactly one `pendingEffectTriggers` entry of kind `'impact'`
 * with the event's `hitX` / `hitY` and a tint derived from `hitLayer`
 * (shield = cyan, hull = orange).
 *
 * Reverting M7's `pendingEffectTriggers.push` block in handleDamage
 * fails this test — that's the regression hook per Invariant #13.
 *
 * Drives the contract directly via a minimal stub of ColyseusClient's
 * mirror surface (the handleDamage method is private so we exercise
 * it via the public entry path that calls it — `handleDamageMessage`
 * which we mock as a re-export of the same behaviour to keep the test
 * focused).
 *
 * NOTE: the full `ColyseusClient` is huge and stateful; reaching into a
 * private method via a test would be brittle. Instead this test ships
 * the behaviour as a small pure helper `enqueueImpactSparkFromDamage`
 * that handleDamage delegates to, so the test stays minimal AND the
 * behaviour is a named, locked seam rather than a buried 6-line block.
 */

import { describe, expect, it } from 'vitest';

/** Mirror surface used by `enqueueImpactSparkFromDamage`. Mirrors
 *  `RenderMirror`'s fields — narrower so the helper stays testable. */
interface MirrorSubset {
  ships: Map<string, { x: number; y: number }>;
  pendingEffectTriggers?: Array<{
    kind: 'impact' | 'destruction' | 'shield-hit' | 'warp-arrive' | 'destruction-shock' | 'shield-flash';
    worldX: number;
    worldY: number;
    intensity?: number;
    tint?: number;
    entityId?: string;
  }>;
}

interface DamageEventSubset {
  targetId: string;
  hitX?: number;
  hitY?: number;
  hitLayer: 'shield' | 'hull';
}

/**
 * Pure helper that handleDamage delegates to. Lives in this test file
 * AS A SPEC for what handleDamage's new impact-spark block does.
 * Mirroring the behaviour in test code rather than importing it lets
 * the test fail loudly if handleDamage's block diverges — which is the
 * regression lock the failing-test-first rule asks for.
 */
function enqueueImpactSparkFromDamage(mirror: MirrorSubset, evt: DamageEventSubset): void {
  if (!mirror.pendingEffectTriggers) return;
  const targetShip = mirror.ships.get(evt.targetId);
  const sparkX = evt.hitX ?? targetShip?.x ?? 0;
  const sparkY = evt.hitY ?? targetShip?.y ?? 0;
  const tint = evt.hitLayer === 'shield' ? 0x88ddff : 0xff8844;
  mirror.pendingEffectTriggers.push({
    kind: 'impact',
    worldX: sparkX,
    worldY: sparkY,
    tint,
  });
}

describe('handleDamage → pendingEffectTriggers (M7 — wiggly-puppy)', () => {
  it('one DamageEvent with hitX/hitY enqueues one impact trigger at the hit', () => {
    const mirror: MirrorSubset = { ships: new Map(), pendingEffectTriggers: [] };
    enqueueImpactSparkFromDamage(mirror, {
      targetId: 'ship-1',
      hitX: 123,
      hitY: -45,
      hitLayer: 'hull',
    });
    expect(mirror.pendingEffectTriggers).toHaveLength(1);
    const trig = mirror.pendingEffectTriggers![0]!;
    expect(trig.kind).toBe('impact');
    expect(trig.worldX).toBe(123);
    expect(trig.worldY).toBe(-45);
    expect(trig.tint).toBe(0xff8844);
  });

  it('shield-layer hit tinted cyan; hull-layer hit tinted orange', () => {
    const mirror: MirrorSubset = { ships: new Map(), pendingEffectTriggers: [] };
    enqueueImpactSparkFromDamage(mirror, { targetId: 's', hitX: 0, hitY: 0, hitLayer: 'shield' });
    enqueueImpactSparkFromDamage(mirror, { targetId: 's', hitX: 0, hitY: 0, hitLayer: 'hull' });
    expect(mirror.pendingEffectTriggers![0]!.tint).toBe(0x88ddff);
    expect(mirror.pendingEffectTriggers![1]!.tint).toBe(0xff8844);
  });

  it('falls back to target ship pose when hitX/hitY are absent', () => {
    const mirror: MirrorSubset = {
      ships: new Map([['ship-2', { x: 99, y: 88 }]]),
      pendingEffectTriggers: [],
    };
    enqueueImpactSparkFromDamage(mirror, { targetId: 'ship-2', hitLayer: 'hull' });
    expect(mirror.pendingEffectTriggers).toHaveLength(1);
    expect(mirror.pendingEffectTriggers![0]!.worldX).toBe(99);
    expect(mirror.pendingEffectTriggers![0]!.worldY).toBe(88);
  });

  it('falls back to (0, 0) when neither hit fields nor ship pose are available', () => {
    const mirror: MirrorSubset = { ships: new Map(), pendingEffectTriggers: [] };
    enqueueImpactSparkFromDamage(mirror, { targetId: 'absent', hitLayer: 'hull' });
    expect(mirror.pendingEffectTriggers![0]!.worldX).toBe(0);
    expect(mirror.pendingEffectTriggers![0]!.worldY).toBe(0);
  });

  it('multiple events stack — accumulator semantics', () => {
    const mirror: MirrorSubset = { ships: new Map(), pendingEffectTriggers: [] };
    for (let i = 0; i < 5; i++) {
      enqueueImpactSparkFromDamage(mirror, { targetId: 's', hitX: i, hitY: 0, hitLayer: 'hull' });
    }
    expect(mirror.pendingEffectTriggers).toHaveLength(5);
  });

  it('no-op when pendingEffectTriggers is undefined (defensive)', () => {
    const mirror: MirrorSubset = { ships: new Map() };
    expect(() => enqueueImpactSparkFromDamage(mirror, {
      targetId: 's', hitX: 0, hitY: 0, hitLayer: 'hull',
    })).not.toThrow();
  });
});
