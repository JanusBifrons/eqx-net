/**
 * Which point lights a GPU-lit hull takes (hostile review 2026-11-08, capfleet
 * clip): a blast beside a destroyer lit the escorts but left its deck
 * unchanged. Lights were judged at a circle half the hull's diagonal wide; a
 * long hull's circle took in every escort, whose engines outranked the blast
 * for the eight slots. Judged at the hull's rectangle, the blast wins.
 */
import { describe, expect, it } from 'vitest';
import { LitScene, LitShipMesh, pickedLight, strongestLightsInto } from './litShipShader.js';

describe('strongestLightsInto', () => {
  // A destroyer 600 u long, 80 u wide, lying along x.
  const hx = 300, hy = 40;

  it('a blast beside a long hull beats escort engines that are off its sides', () => {
    const scene = new LitScene();
    scene.begin();
    // Twelve escort engines 150 u off the hull's side: well inside the old
    // circle (radius ~303) but beyond each engine's 80 u reach of the hull.
    for (let i = 0; i < 12; i++) scene.addLight(-250 + i * 45, 190, 1, 0xffa24a, 2.7, 80);
    // A dying blast 30 u off the deck edge.
    const boom = scene.lightCount;
    scene.addLight(100, 70, 25, 0xff8a30, 0.8, 130);
    const k = strongestLightsInto(scene, 0, 0, 0, hx, hy, 8, -1);
    expect(k).toBe(1);
    expect(pickedLight(0)).toBe(boom);
  });

  it('measures in the hull frame (rotated hull)', () => {
    const scene = new LitScene();
    scene.begin();
    // Hull turned 90°: its length now runs along y. A light 250 u along y is
    // over the deck; one 250 u along x is 210 u off its side.
    scene.addLight(0, 250, 5, 0xffffff, 1, 60);
    scene.addLight(250, 0, 5, 0xffffff, 1, 60);
    const k = strongestLightsInto(scene, 0, 0, Math.PI / 2, hx, hy, 8, -1);
    expect(k).toBe(1);
    expect(pickedLight(0)).toBe(0);
  });

  it("a hull's own engines count for little against another's", () => {
    const scene = new LitScene();
    scene.begin();
    scene.addLight(-310, 0, 1, 0xffa24a, 3, 80, 7); // own stern engine
    scene.addLight(-310, 10, 1, 0xffa24a, 1, 80, 9); // a neighbour's, weaker
    const k = strongestLightsInto(scene, 0, 0, 0, hx, hy, 1, 7);
    expect(k).toBe(1);
    expect(pickedLight(0)).toBe(1);
    expect(LitShipMesh.OWN_LIGHT).toBeLessThan(1 / 3);
  });
});
