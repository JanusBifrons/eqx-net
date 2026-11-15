/**
 * Sub-capital break-up slice 3 (#3) — the wreck wire fields' schemas, and the
 * alloc-free guards the client uses on the snapshot hot path instead of a zod
 * parse. The guards must accept and reject exactly what the schemas do.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  WelcomeSchema, WreckAddsSchema, WreckDescriptorSchema, WreckRemovesSchema, WreckSyncSchema,
  isWreckDescriptor, isWreckId, WRECK_ID_END,
  type WreckDescriptor,
} from './snapshotMessages.js';

// Compile-time: the schema and the interface describe the same shape.
type Inferred = z.infer<typeof WreckDescriptorSchema>;
const toInterface = (d: Inferred): WreckDescriptor => d;
const toInferred = (d: WreckDescriptor): Inferred => d;
void toInterface; void toInferred;

const good: WreckDescriptor = {
  wreckId: 12, parentKind: 'battleship', seed: 4_000_000_000, killX: 1.5, killY: -2,
  killBlowDamage: 0.4, recentDamageRate: 0.9, snapChance: 0.1, algoVersion: 6, deathTick: 300,
};

const samples: Array<[string, unknown]> = [
  ['good', good],
  ['no deathTick', { ...good, deathTick: undefined }],
  ['id 0', { ...good, wreckId: 0 }],
  ['id past u16', { ...good, wreckId: WRECK_ID_END }],
  ['fractional id', { ...good, wreckId: 1.5 }],
  ['string id', { ...good, wreckId: '12' }],
  ['empty kind', { ...good, parentKind: '' }],
  ['negative seed', { ...good, seed: -1 }],
  ['NaN kill point', { ...good, killX: Number.NaN }],
  ['infinite damage', { ...good, killBlowDamage: Number.POSITIVE_INFINITY }],
  ['fractional algo', { ...good, algoVersion: 6.5 }],
  ['missing snapChance', { ...good, snapChance: undefined }],
  // Fracture v9 kill cut (optional; the reader lands before the server sends it).
  ['slice cut', { ...good, cutKind: 'slice', cutAng: 65535 }],
  ['channel cut', { ...good, cutKind: 'channel', cutAng: 0, cutW: 12.5 }],
  ['unknown cut kind', { ...good, cutKind: 'laser', cutAng: 3 }],
  ['cut angle past u16', { ...good, cutKind: 'slice', cutAng: 65536 }],
  ['fractional cut angle', { ...good, cutKind: 'slice', cutAng: 2.5 }],
  ['negative channel width', { ...good, cutKind: 'channel', cutAng: 1, cutW: -1 }],
  ['NaN channel width', { ...good, cutKind: 'channel', cutAng: 1, cutW: Number.NaN }],
  // Salvage child wreck link (optional; the reader lands before the server sends it).
  ['child', { ...good, parentWreck: 3, parentPiece: 0 }],
  ['child piece 255', { ...good, parentWreck: 65535, parentPiece: 255 }],
  ['parent without piece', { ...good, parentWreck: 3 }],
  ['piece without parent', { ...good, parentPiece: 2 }],
  ['own parent', { ...good, parentWreck: 12, parentPiece: 0 }],
  ['parent id 0', { ...good, parentWreck: 0, parentPiece: 0 }],
  ['parent past u16', { ...good, parentWreck: WRECK_ID_END, parentPiece: 0 }],
  ['piece past u8', { ...good, parentWreck: 3, parentPiece: 256 }],
  ['fractional piece', { ...good, parentWreck: 3, parentPiece: 0.5 }],
  ['null', null],
];

describe('wreck wire schemas (slice 3)', () => {
  it('isWreckDescriptor agrees with WreckDescriptorSchema', () => {
    for (const [name, v] of samples) {
      expect(isWreckDescriptor(v), name).toBe(WreckDescriptorSchema.safeParse(v).success);
    }
  });

  it('isWreckId agrees with the removes schema', () => {
    for (const id of [0, 1, 7, 65535, 65536, -3, 2.5, '4']) {
      expect(isWreckId(id), String(id)).toBe(WreckRemovesSchema.safeParse([id]).success);
    }
  });

  it('the delta fields and the welcome parse', () => {
    expect(WreckAddsSchema.safeParse([good]).success).toBe(true);
    expect(WreckSyncSchema.safeParse({ lo: 1, hi: WRECK_ID_END, d: [good] }).success).toBe(true);
    expect(WreckSyncSchema.safeParse({ lo: 1, hi: WRECK_ID_END + 1, d: [] }).success).toBe(false);
    const welcome = { type: 'welcome', playerId: 'p', serverTick: 1, sectorKey: null, shipInstanceId: '', capitalWrecks: true, wrecks: [good] };
    expect(WelcomeSchema.safeParse(welcome).success).toBe(true);
    expect(WelcomeSchema.safeParse({ ...welcome, wrecks: [{ ...good, wreckId: 0 }] }).success).toBe(false);
    // A child descriptor survives the strict welcome and a JSON round trip unchanged.
    const child: WreckDescriptor = { ...good, wreckId: 13, parentWreck: 12, parentPiece: 4, cutKind: 'slice', cutAng: 9 };
    const parsed = WelcomeSchema.safeParse(JSON.parse(JSON.stringify({ ...welcome, wrecks: [good, child] })));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.wrecks?.[1]).toStrictEqual(child);
  });

  it('the welcome accepts the sub-cap break-up switch (read before the server sends it)', () => {
    // The welcome schema is strict: a client that does not know a key the
    // server sends drops the WHOLE welcome and never joins. The reader must
    // land before the server switches `subcapWrecks` on (PR #584), or every
    // client one release behind is stuck on "Ships: 0" (the netgate's
    // baseline arm caught exactly that).
    const welcome = { type: 'welcome', playerId: 'p', serverTick: 1, sectorKey: null, shipInstanceId: '', capitalWrecks: true, subcapWrecks: true };
    expect(WelcomeSchema.safeParse(welcome).success).toBe(true);
    expect(WelcomeSchema.safeParse({ ...welcome, subcapWrecks: false }).success).toBe(false);
  });
});
