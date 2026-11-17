import { describe, it, expect } from 'vitest';
import { perfRoomOptions } from './perfRooms.js';
import { perfSceneById } from '../../shared-types/perf/perfScenes.js';
import { resolveSectorConfig } from '../galaxy/GalaxyRegistry.js';

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
});
