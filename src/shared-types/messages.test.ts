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
import { z } from 'zod';
import {
  CollisionResolvedMessageSchema,
  EngageTransitSchema,
  FireMessageSchema,
  HitAckSchema,
  DamageEventSchema,
  WarpWarningSchema,
  WarpWarningClearSchema,
} from './messages.js';
import type { SnapshotMessage, WelcomeMessage, HitAckMessage, DamageEvent } from './messages.js';

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

// ── Phase 6a wire contract ─────────────────────────────────────────────────
//
// `SnapshotMessage.states` is re-keyed to shipInstanceId (was playerId in
// pre-6a wire). Each entry now carries `playerId` + `isActive` so the
// client can identify "self" + skip lingering hulls until Phase 6b is
// ready to surface them. WelcomeMessage already carries `shipInstanceId`
// from Phase 5. These tests are pure type-shape locks — runtime parse
// isn't applicable (SnapshotMessage is an interface, not a zod schema).
describe('Phase 6a wire shape — SnapshotMessage + WelcomeMessage', () => {
  it('SnapshotMessage.states entries carry playerId and isActive', () => {
    // If the interface drops the new fields, this won't compile.
    const snap: SnapshotMessage = {
      type: 'snapshot',
      serverTick: 1,
      states: {
        'ship-uuid-1': {
          x: 100, y: 200, vx: 0, vy: 0, angle: 0, angvel: 0,
          playerId: 'player-1',
          isActive: true,
        },
      },
      ackedTick: 0,
    };
    expect(snap.states['ship-uuid-1']!.playerId).toBe('player-1');
    expect(snap.states['ship-uuid-1']!.isActive).toBe(true);
  });

  it('SnapshotMessage.states tolerates a false isActive (lingering hull, Phase 6b)', () => {
    const snap: SnapshotMessage = {
      type: 'snapshot',
      serverTick: 1,
      states: {
        'lingering-ship': {
          x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
          playerId: 'player-1',
          isActive: false,
        },
      },
      ackedTick: 0,
    };
    expect(snap.states['lingering-ship']!.isActive).toBe(false);
  });

  it('WelcomeMessage.shipInstanceId is required (Phase 5 + 6a foundation)', () => {
    const welcome: WelcomeMessage = {
      type: 'welcome',
      playerId: 'p1',
      serverTick: 0,
      sectorKey: 'sol-prime',
      shipInstanceId: 'ship-uuid-1',
    };
    expect(welcome.shipInstanceId).toBe('ship-uuid-1');
  });

  it('WelcomeMessage.shipInstanceId can be empty for engineering rooms with no roster row', () => {
    const welcome: WelcomeMessage = {
      type: 'welcome',
      playerId: 'p1',
      serverTick: 0,
      sectorKey: null,
      shipInstanceId: '',
    };
    expect(welcome.shipInstanceId).toBe('');
  });
});

// ── Hit-prediction wire contract (weapon-hit-prediction Phase 0) ────────────
//
// Pre-existing invariant #4 gap: the server creates `hit_ack` and `damage`
// itself and trusts its own shape, so neither had a zod schema. The
// client-side weapon-hit-prediction feature makes the client a *consumer*
// of `hit_ack` (its single reconcile path) and a de-dupe consumer of
// `damage` — both now cross the trust boundary, so both need a defensive
// schema validated on ingest (mirrors how `collision_resolved` is handled).
//
// `hit_ack` also gains an optional `damage?: number` so a confirmed
// prediction can be reconciled/de-duped against the authoritative
// `DamageEvent.damage` without waiting for the broadcast. Schemas mirror
// the hand-written interfaces exactly; the bidirectional `z.infer` ↔
// interface assignability lock (typecheck-enforced) keeps them from
// drifting apart.
describe('HitAckSchema (weapon-hit-prediction Phase 0)', () => {
  const validHit = {
    type: 'hit_ack' as const,
    clientShotId: 'shot-abc',
    hit: true,
    targetId: 'swarm-7',
    damage: 12,
  };

  it('accepts a hit:true ack carrying targetId + damage', () => {
    expect(HitAckSchema.safeParse(validHit).success).toBe(true);
  });

  it('accepts a legacy hit:false miss (no targetId / damage / rejected)', () => {
    const r = HitAckSchema.safeParse({ type: 'hit_ack', clientShotId: 'shot-abc', hit: false });
    expect(r.success).toBe(true);
  });

  it('accepts the server cooldown/temporal reject form (hit:false, rejected:true)', () => {
    const r = HitAckSchema.safeParse({
      type: 'hit_ack',
      clientShotId: 'shot-abc',
      hit: false,
      rejected: true,
    });
    expect(r.success).toBe(true);
  });

  it('rejects a wrong type literal', () => {
    expect(HitAckSchema.safeParse({ ...validHit, type: 'hit' }).success).toBe(false);
  });

  it('rejects extra unknown fields (strict mode)', () => {
    expect(HitAckSchema.safeParse({ ...validHit, extra: 'nope' }).success).toBe(false);
  });

  it('rejects a non-string clientShotId', () => {
    expect(HitAckSchema.safeParse({ ...validHit, clientShotId: 42 }).success).toBe(false);
  });

  it('rejects a non-boolean hit', () => {
    expect(HitAckSchema.safeParse({ ...validHit, hit: 'yes' }).success).toBe(false);
  });

  it('rejects a non-number damage', () => {
    expect(HitAckSchema.safeParse({ ...validHit, damage: '12' }).success).toBe(false);
  });

  it('z.infer<HitAckSchema> ↔ HitAckMessage are bidirectionally assignable', () => {
    // Typecheck-enforced structural-equality lock. `null as unknown as T`
    // yields a value of exactly T with no excess-property freshness, so
    // each assignment checks one direction of mutual assignability — if the
    // schema and the interface drift (a field added to one only, or an
    // optionality mismatch) `pnpm typecheck` fails here.
    type SchemaT = z.infer<typeof HitAckSchema>;
    const schemaToIface: HitAckMessage = null as unknown as SchemaT;
    const ifaceToSchema: SchemaT = null as unknown as HitAckMessage;
    void schemaToIface;
    void ifaceToSchema;
    // Runtime: the parsed value is usable as the hand-written interface.
    const parsed: HitAckMessage = HitAckSchema.parse(validHit);
    expect(parsed.damage).toBe(12);
  });
});

describe('DamageEventSchema (weapon-hit-prediction Phase 0)', () => {
  const valid = {
    type: 'damage' as const,
    targetId: 'swarm-7',
    damage: 12,
    newHealth: 88,
    shooterId: 'player-1',
    hitX: 100,
    hitY: -50,
    newShield: 0,
    shieldMax: 50,
    hullMax: 100,
    hitLayer: 'hull' as const,
  };

  it('accepts a full valid payload', () => {
    expect(DamageEventSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a payload without the optional hitX/hitY', () => {
    const { hitX: _x, hitY: _y, ...rest } = valid;
    expect(DamageEventSchema.safeParse(rest).success).toBe(true);
  });

  it('accepts hitLayer: "shield"', () => {
    expect(DamageEventSchema.safeParse({ ...valid, hitLayer: 'shield' }).success).toBe(true);
  });

  it('rejects a wrong type literal', () => {
    expect(DamageEventSchema.safeParse({ ...valid, type: 'dmg' }).success).toBe(false);
  });

  it('rejects extra unknown fields (strict mode)', () => {
    expect(DamageEventSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('rejects an invalid hitLayer enum value', () => {
    expect(DamageEventSchema.safeParse({ ...valid, hitLayer: 'armour' }).success).toBe(false);
  });

  it('rejects a missing required field (newHealth)', () => {
    const { newHealth: _n, ...rest } = valid;
    expect(DamageEventSchema.safeParse(rest).success).toBe(false);
  });

  it('z.infer<DamageEventSchema> ↔ DamageEvent are bidirectionally assignable', () => {
    type SchemaT = z.infer<typeof DamageEventSchema>;
    const schemaToIface: DamageEvent = null as unknown as SchemaT;
    const ifaceToSchema: SchemaT = null as unknown as DamageEvent;
    void schemaToIface;
    void ifaceToSchema;
    const parsed: DamageEvent = DamageEventSchema.parse(valid);
    expect(parsed.hitLayer).toBe('hull');
  });
});

describe('WarpWarningSchema (wave-system Phase 5)', () => {
  const valid = {
    type: 'warp_warning' as const,
    id: 'squad-0',
    label: 'Legionnaire',
    count: 8,
    countdownMs: 300_000,
    kind: 'fighter',
  };

  it('accepts a well-formed squad warning', () => {
    expect(WarpWarningSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a player warning without a kind (count 1)', () => {
    const { kind: _k, ...rest } = valid;
    expect(WarpWarningSchema.safeParse({ ...rest, id: 'p1', label: 'Ace', count: 1 }).success).toBe(
      true,
    );
  });

  it('rejects count < 1 and non-integer count', () => {
    expect(WarpWarningSchema.safeParse({ ...valid, count: 0 }).success).toBe(false);
    expect(WarpWarningSchema.safeParse({ ...valid, count: 2.5 }).success).toBe(false);
  });

  it('rejects a negative / non-finite countdownMs (would render a garbage banner)', () => {
    expect(WarpWarningSchema.safeParse({ ...valid, countdownMs: -1 }).success).toBe(false);
    expect(WarpWarningSchema.safeParse({ ...valid, countdownMs: Infinity }).success).toBe(false);
  });

  it('rejects an empty label / id and unknown keys (.strict)', () => {
    expect(WarpWarningSchema.safeParse({ ...valid, label: '' }).success).toBe(false);
    expect(WarpWarningSchema.safeParse({ ...valid, id: '' }).success).toBe(false);
    expect(WarpWarningSchema.safeParse({ ...valid, extra: 'nope' }).success).toBe(false);
  });

  it('WarpWarningClearSchema accepts a bare {type,id} and rejects extras', () => {
    expect(WarpWarningClearSchema.safeParse({ type: 'warp_warning_clear', id: 'squad-0' }).success).toBe(
      true,
    );
    expect(
      WarpWarningClearSchema.safeParse({ type: 'warp_warning_clear', id: 'x', extra: 1 }).success,
    ).toBe(false);
  });
});
