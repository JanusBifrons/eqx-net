import { afterEach, describe, expect, it } from 'vitest';
import { LitScene, pickedLight, strongestLightsInto } from '../art/litShipShader.js';
import { ROAD_STRAIGHT_MASK } from './roadJoins.js';
import { roadOverlayPlan } from './structureStyleC.transport.road.js';
import { ROAD_LAMP_CAP, ROAD_LAMP_LIGHT, addRoadLampLights, rebuildRoadLamps, resetRoadLamps, roadLamps } from './roadLampLights.js';

const plan = roadOverlayPlan(ROAD_STRAIGHT_MASK).lamps;

function collect(bounds?: Float64Array, cap?: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  addRoadLampLights({ addLight: (x, y, _z, _c, i) => { out.push([x, y, i]); } }, bounds, cap);
  return out;
}

describe('road lamp lights (lit deck slice 3)', () => {
  afterEach(() => resetRoadLamps());

  it('an unturned road at the origin lights each overlay lamp, y flipped into Pixi space', () => {
    rebuildRoadLamps([{ id: 1, x: 0, y: 0, rotDeg: 0, mirror: false }], new Map([[1, ROAD_STRAIGHT_MASK]]));
    const { xy, count } = roadLamps();
    expect(count * 2).toBe(plan.length);
    for (let i = 0; i < plan.length; i++) expect(xy[i]).toBeCloseTo(plan[i]!, 3);
  });

  it('follows the road\'s pose: turned 90° and moved', () => {
    rebuildRoadLamps([{ id: 7, x: 1000, y: 500, rotDeg: 90, mirror: false }], new Map([[7, ROAD_STRAIGHT_MASK]]));
    const { xy, count } = roadLamps();
    expect(count * 2).toBe(plan.length);
    // rotation = -90°: (lx, ly) → (ly, -lx), centred on Pixi (1000, -500).
    for (let i = 0; i < plan.length; i += 2) {
      expect(xy[i]).toBeCloseTo(1000 + plan[i + 1]!, 2);
      expect(xy[i + 1]).toBeCloseTo(-500 - plan[i]!, 2);
    }
  });

  it('adds only on-screen lamps, weak, and stops at the cap', () => {
    const roads = [];
    const arms = new Map<number, number>();
    for (let k = 0; k < 10; k++) { roads.push({ id: k, x: k * 3000, y: 0, rotDeg: 0, mirror: false }); arms.set(k, ROAD_STRAIGHT_MASK); }
    rebuildRoadLamps(roads, arms);
    const view = new Float64Array([-600, -600, 600, 600]);
    const lit = collect(view);
    expect(lit.length).toBe(plan.length / 2); // only the first road is near the view
    for (const [, , i] of lit) expect(i).toBe(ROAD_LAMP_LIGHT.intensity);
    expect(ROAD_LAMP_LIGHT.intensity * ROAD_LAMP_LIGHT.rank).toBeLessThan(0.9); // a shell (0.9) and a blast (3) outrank a lamp when picking
    expect(collect(undefined).length).toBe(Math.min(ROAD_LAMP_CAP, roadLamps().count));
    expect(collect(undefined, 3).length).toBe(3);
  });

  it('a shell beside a lamp wins the only light slot, though the lamp is brighter', () => {
    const sc = new LitScene();
    rebuildRoadLamps([{ id: 1, x: 0, y: 0, rotDeg: 0, mirror: false }], new Map([[1, ROAD_STRAIGHT_MASK]]));
    addRoadLampLights(sc, undefined, 1);
    const lamp = sc.lights[0]!;
    sc.addLight(lamp.x + 10, lamp.y, 5, 0xffc070, 0.9, 55); // a shell over the same spot
    expect(strongestLightsInto(sc, lamp.x, lamp.y, 0, 50, 50, 1, -1)).toBe(1);
    expect(pickedLight(0)).toBe(1);
  });
});
