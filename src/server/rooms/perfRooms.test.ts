import { describe, it, expect } from 'vitest';
import { perfRoomOptions } from './perfRooms.js';
import { perfSceneById } from '../../shared-types/perf/perfScenes.js';
import { resolveSectorConfig } from '../galaxy/GalaxyRegistry.js';
import { wreckField, hullsInChunk, wreckFieldHullFracture } from '../../core/terrain/wreckFieldLayout.js';
import { chunkOf } from '../../core/terrain/fieldLayout.js';
import { wreckPieceGeometry } from '../../core/destruction/wreckPieces.js';
import { FIELD_LIVE_CAP } from './wreckFifos.js';
import { hullPieceCounts, worstRing } from '../../core/terrain/wreckFieldTestKit.js';
import type { WreckFieldRoomOpts } from './WreckFieldSource.js';

describe('perfRoomOptions', () => {
  it('galaxy-field gets the live sector cut field; EQX_SCENE_GALAXY_FIELD=0 leaves it off', () => {
    const scene = perfSceneById('galaxy-field')!;
    const on = perfRoomOptions(scene, {});
    expect(on['cutField']).toEqual(resolveSectorConfig('sol-prime').cutField);
    expect(on['cutField']).toBeDefined();
    expect(perfRoomOptions(scene, { EQX_SCENE_GALAXY_FIELD: '0' })['cutField']).toBeUndefined();
  });

  it('a scene without galaxyField keeps its own room options', () => {
    const scene = perfSceneById('cut-field')!;
    const o = perfRoomOptions(scene, {});
    expect(o['cutField']).toEqual({ seed: 'look' });
    expect(o['perfFixedLoad']).toBe(true);
  });

  it('wreck-field scenes: EQX_SCENE_WRECK_FIELD=0 leaves the field off', () => {
    for (const id of ['wreck-field', 'wreck-field-far']) {
      const scene = perfSceneById(id)!;
      expect(perfRoomOptions(scene, {})['wreckField']).toBeDefined();
      expect(perfRoomOptions(scene, { EQX_SCENE_WRECK_FIELD: '0' })['wreckField']).toBeUndefined();
    }
    expect(perfRoomOptions(perfSceneById('cut-field')!, { EQX_SCENE_WRECK_FIELD: '0' })['cutField']).toEqual({ seed: 'look' });
  });

  it('wreck-field scenes: the pilot loads the worst ring of their wreckField, under the field cap', () => {
    for (const id of ['wreck-field', 'wreck-field-far']) {
      const scene = perfSceneById(id)!;
      const wf = perfRoomOptions(scene, {})['wreckField'] as WreckFieldRoomOpts;
      const field = wreckField({ ...wf });
      const { cx, cy } = chunkOf(scene.spawn.x, scene.spawn.y);
      let pieces = 0;
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        for (const h of hullsInChunk(field, cx + dx, cy + dy)) pieces += wreckPieceGeometry(wreckFieldHullFracture(h)).length;
      }
      const worst = worstRing(field, hullPieceCounts(field));
      expect(pieces, `${id}: live pieces in the pilot's 5 x 5 ring`).toBe(worst.pieces);
      expect({ cx, cy }).toEqual({ cx: worst.cx, cy: worst.cy });
      expect(pieces).toBeLessThanOrEqual(FIELD_LIVE_CAP);
      for (const h of field.hulls) expect(Math.hypot(h.x - scene.spawn.x, h.y - scene.spawn.y), `${id}: spawn clear of ${h.kindId}`).toBeGreaterThan(h.footprint);
    }
  });
});
