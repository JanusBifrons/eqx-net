/**
 * Field rock cut, slice 1C-a, client side: a cut-field rock's wreck (its
 * root's `rock.fk`) is rebuilt from the welcome's field options. Without
 * them its pieces read null (no body, no sprite); once `setField` has them,
 * the pieces are the shared core rebuild's.
 */
import { describe, expect, it } from 'vitest';
import { WreckGeometryStore } from './wreckGeometryStore';
import { rebuildWreckPieces } from '@core/destruction/wreckDescriptorGeometry';
import { FRACTURE_ALGO_VERSION } from '@core/destruction/fractureHull';
import { rocksInChunk } from '@core/terrain/fieldLayout';
import { cutFieldOpts, fieldRockBody } from '@core/terrain/chunkStreamer';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor } from '@shared-types/messages/wreckDescriptor';

const FIELD = cutFieldOpts('test-seed');
const ROCK = rocksInChunk(FIELD, 15, 0)[0]!;
const DESC: WreckDescriptor = {
  wreckId: 9, parentKind: WRECK_ROCK_PARENT_KIND, seed: 5, killX: 0, killY: 0, killBlowDamage: 0,
  recentDamageRate: 0, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION, cutKind: 'slice', cutAng: 0,
  rock: { id: `f${ROCK.key}`, shape: 0, r: fieldRockBody(ROCK).radius, fk: ROCK.key },
};

describe('WreckGeometryStore field rock wrecks (slice 1C-a)', () => {
  it('a field rock wreck rebuilds from the field layout once the field is set', () => {
    const store = new WreckGeometryStore();
    store.apply([DESC]);
    expect(store.has(9)).toBe(true);
    expect(store.piece(9, 0)).toBeNull();
    store.setField(FIELD);
    expect(store.field).toBe(FIELD);
    const want = rebuildWreckPieces(DESC, FIELD);
    expect(store.piece(9, 0)).toEqual(want[0]);
    expect(store.rockOf(9)?.fk).toBe(ROCK.key);
  });
});
