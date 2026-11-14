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
  });
});
