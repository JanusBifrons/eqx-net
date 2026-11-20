/**
 * Field rock cut, slice 1C-a: a cut-FIELD rock's wreck carries its packed
 * field rock key (`rock.fk`) instead of a shape seed, and both sides rebuild
 * its outline from the room's field layout (`fieldRockBody` of its chunk's
 * `rocksInChunk` entry, the outline it collides and draws with). Locks: the
 * source's outline IS the layout's; a ref without `fk` still uses its shape
 * seed; the wire schema and its alloc-free twin accept and reject `fk`
 * strictly; a descriptor rebuilds only with the field options.
 */
import { describe, expect, it } from 'vitest';
import { fieldRockOutline, rockWreckSource } from './wreckSource.js';
import { rebuildWreckPieces } from './wreckDescriptorGeometry.js';
import { FRACTURE_ALGO_VERSION } from './fractureHull.js';
import { generateAsteroidVertices, asteroidShapeSeed } from '../swarm/asteroidShape.js';
import { rocksInChunk } from '../terrain/fieldLayout.js';
import { cutFieldOpts, fieldRockBody } from '../terrain/chunkStreamer.js';
import {
  isWreckDescriptor, WRECK_ROCK_PARENT_KIND, WreckDescriptorSchema, WreckRockRefSchema, type WreckDescriptor,
} from '../../shared-types/messages/wreckDescriptor.js';

const FIELD = cutFieldOpts('test-seed');
const CX = 15, CY = 0; // in the field ring
const ROCK = rocksInChunk(FIELD, CX, CY)[0]!;
const BODY = fieldRockBody(ROCK);
const REF = { id: `f${ROCK.key}`, shape: 0, r: BODY.radius, fk: ROCK.key };

function descriptor(rock: WreckDescriptor['rock']): WreckDescriptor {
  return {
    wreckId: 7, parentKind: WRECK_ROCK_PARENT_KIND, seed: 11, killX: 0, killY: 0, killBlowDamage: 0,
    recentDamageRate: 0, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION, cutKind: 'slice', cutAng: 0, rock,
  };
}

describe('field rock wreck source (slice 1C-a)', () => {
  it('a field rock ref rebuilds the same outline as the field layout', () => {
    const src = rockWreckSource(REF, FIELD);
    // The layout's body outline, y flipped into the fracture's Pixi-up frame.
    expect(src.outline).toEqual(BODY.verts.map((v) => [v.x, -v.y]));
    expect(fieldRockOutline(FIELD, ROCK.key).verts).toEqual(BODY.verts);
    expect(src.radius).toBe(BODY.radius);
    expect(src.rock).toEqual(REF);
    // The source's own field options are the default.
    expect(rockWreckSource({ ...REF, field: FIELD }).outline).toEqual(src.outline);
    // Without field options it refuses rather than guess a shape.
    expect(() => rockWreckSource(REF)).toThrow(/no field options/);
    // A descriptor rebuilds deterministically with the field, from that outline.
    const a = rebuildWreckPieces(descriptor(REF), FIELD);
    const b = rebuildWreckPieces(descriptor(REF), cutFieldOpts('test-seed'));
    expect(a.length).toBeGreaterThan(1);
    expect(b).toEqual(a);
  });

  it('a rock ref without a field key still uses its shape seed', () => {
    const ref = { id: 'belt-0-7', shape: asteroidShapeSeed('belt-0-7'), r: 60 };
    const want = generateAsteroidVertices(ref.shape, ref.r).map((v) => [v.x, -v.y]);
    expect(rockWreckSource(ref).outline).toEqual(want);
    // Field options passed alongside are ignored for a seeded rock.
    expect(rockWreckSource(ref, FIELD).outline).toEqual(want);
    expect(rockWreckSource(ref).rock).toEqual(ref);
  });

  it('WreckRockRefSchema accepts and rejects field keys strictly', () => {
    const ok = [REF, { ...REF, fk: 0 }, { ...REF, fk: 0xffffffff }, { id: 'a', shape: 5, r: 1 }];
    for (const r of ok) {
      expect(WreckRockRefSchema.safeParse(r).success).toBe(true);
      expect(isWreckDescriptor(descriptor(r))).toBe(true);
      expect(WreckDescriptorSchema.safeParse(descriptor(r)).success).toBe(true);
    }
    const bad: unknown[] = [
      { ...REF, fk: -1 }, { ...REF, fk: 0x100000000 }, { ...REF, fk: 1.5 }, { ...REF, fk: '3' },
      { ...REF, fk: Number.NaN }, { ...REF, shape: 3 }, // a field rock has no shape seed
      { ...REF, field: 'x' }, // strict: no unknown keys
    ];
    for (const r of bad) {
      expect(WreckRockRefSchema.safeParse(r).success).toBe(false);
      expect(WreckDescriptorSchema.safeParse(descriptor(r as WreckDescriptor['rock'])).success).toBe(false);
    }
    // The alloc-free twin agrees on every value-level rejection (it ignores
    // unknown keys by design, as for the descriptor).
    for (const r of bad.slice(0, 6)) expect(isWreckDescriptor(descriptor(r as WreckDescriptor['rock']))).toBe(false);
  });
});
