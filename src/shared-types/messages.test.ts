/**
 * Stage 2 cycle 2 of the network-feel roadmap. Schema fuzz tests for the
 * server → client `collision_resolved` message.
 *
 * The server creates this message in its broadcast loop and serialises
 * directly (it trusts itself), but the client validates inbound payloads
 * defensively against future protocol skew. This test fixture asserts the
 * schema rejects every common malformed shape and accepts a known-good
 * payload. Pattern matches the existing `InputMessageSchema` style.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CollisionResolvedMessageSchema, EngageTransitSchema, FireMessageSchema } from './messages.js';

describe('CollisionResolvedMessageSchema', () => {
  const valid = {
    type: 'collision_resolved' as const,
    aId: 'player-abc',
    bId: 'asteroid-42',
    vA: { x: 12.5, y: -7.0 },
    vB: { x: -3.0, y: 4.5 },
    impulse: 250,
    tick: 100_000,
  };

  it('accepts a known-good payload', () => {
    const result = CollisionResolvedMessageSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects payloads with wrong type literal', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, type: 'collision' });
    expect(r.success).toBe(false);
  });

  it('rejects payloads missing aId', () => {
    const { aId: _aId, ...rest } = valid;
    const r = CollisionResolvedMessageSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects payloads with non-string aId', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, aId: 123 });
    expect(r.success).toBe(false);
  });

  it('rejects payloads with non-number velocity components', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, vA: { x: '1', y: 0 } });
    expect(r.success).toBe(false);
  });

  it('rejects payloads with negative tick', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, tick: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects payloads with non-integer tick', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, tick: 1.5 });
    expect(r.success).toBe(false);
  });

  it('rejects payloads with extra unknown fields (strict mode)', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, extra: 'nope' });
    expect(r.success).toBe(false);
  });

  it('accepts impulse = 0 (boundary value — used as a sentinel for "below floor" in some tests)', () => {
    // The wire schema allows any non-negative impulse; the server filters by
    // forceFloor before broadcasting, so 0 only appears in synthetic tests.
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, impulse: 0 });
    expect(r.success).toBe(true);
  });

  it('rejects negative impulse', () => {
    const r = CollisionResolvedMessageSchema.safeParse({ ...valid, impulse: -10 });
    expect(r.success).toBe(false);
  });
});

describe('EngageTransitSchema', () => {
  it('accepts a payload without arrival (legacy PC behaviour)', () => {
    const r = EngageTransitSchema.safeParse({ type: 'engage_transit', targetSectorKey: 'orion-belt' });
    expect(r.success).toBe(true);
  });

  it('accepts a payload with finite arrival x/y', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: 100, y: -200 },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a payload with non-finite arrival values', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: Number.NaN, y: 0 },
    });
    expect(r.success).toBe(false);
  });

  it('rejects extra unknown fields on the arrival object (strict)', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: 0, y: 0, z: 0 },
    });
    expect(r.success).toBe(false);
  });

  // Phase 5 — `shipId` extension for in-game roster switching. When present
  // it routes the transit to bind the named roster entry at the destination
  // instead of letting the current ship continue. Absent ⇒ legacy behaviour.
  it('accepts a payload with shipId for in-game roster switching', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      shipId: 'ship-uuid-abc',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a payload with both arrival and shipId', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      arrival: { x: 100, y: -200 },
      shipId: 'ship-uuid-abc',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty-string shipId (catalogue-id discipline)', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      shipId: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-string shipId', () => {
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      shipId: 42,
    });
    expect(r.success).toBe(false);
  });

  // Property test (fast-check): any non-empty string is a valid shipId.
  // Covers the long-tail of UUID forms, with-special-chars, max-length, etc.
  // — much wider than the hand-rolled cases above. 200 runs ≈ <100ms.
  it('property: any non-empty string with length >= 1 parses as a valid shipId', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 200 }), (shipId) => {
        const r = EngageTransitSchema.safeParse({
          type: 'engage_transit',
          targetSectorKey: 'orion-belt',
          shipId,
        });
        return r.success === true;
      }),
      { numRuns: 200 },
    );
  });

  it('property: the empty string is always rejected as shipId', () => {
    // Sanity-check the boundary case — zod min(1) rejects ''. fast-check
    // here is overkill (single value) but documents the contract.
    const r = EngageTransitSchema.safeParse({
      type: 'engage_transit',
      targetSectorKey: 'orion-belt',
      shipId: '',
    });
    expect(r.success).toBe(false);
  });
});

describe('FireMessageSchema (multi-mount refactor, Phase 2b.1)', () => {
  const legacy = {
    type: 'fire' as const,
    tick: 100,
    clientShotId: 'shot-abc',
    weapon: 'hitscan' as const,
    dirAngle: 0.5,
  };

  it('accepts a pre-2b client payload (no slotId)', () => {
    expect(FireMessageSchema.safeParse(legacy).success).toBe(true);
  });

  it('accepts a 2b+ client payload with slotId', () => {
    expect(FireMessageSchema.safeParse({ ...legacy, slotId: 'primary' }).success).toBe(true);
  });

  it('rejects non-string slotId', () => {
    expect(FireMessageSchema.safeParse({ ...legacy, slotId: 42 }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(FireMessageSchema.safeParse({ ...legacy, mystery: 1 }).success).toBe(false);
  });
});
