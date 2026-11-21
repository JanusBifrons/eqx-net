/**
 * Smelter and silicon works (style C, family lightProduction): each has its
 * own drawer in the style table, its art stays in the footprint outline, its
 * work-glow slits are baked dark, and its live status lights exactly its slits
 * while working, draws the red no-supply mark when starved, nothing when dark.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer, structureStyleVersion } from './structureStyles.js';
import { insidePoly, outlinePx, polyEdgeDist, LAMP_AMBER } from './structureStyleKit.js';
import { hasBodyStatus } from './structureSocketNubs.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { NO_SUPPLY_RED } from './structureStyleC.power.js';
import { SLIT_DEAD, WORK_DARK, WORK_ON, WORK_STARVED, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';
import * as family from './structureStyleC.lightProduction.js';
import {
  SILICON_MARK, SILICON_SLITS, SMELTER_MARK, SMELTER_SLITS, kinds, status,
} from './structureStyleC.lightProduction.smelt.js';

const KINDS: ReadonlyArray<readonly ['smelter' | 'silicon_works', ReadonlyArray<WorkSlit>, WorkMark]> = [
  ['smelter', SMELTER_SLITS, SMELTER_MARK],
  ['silicon_works', SILICON_SLITS, SILICON_MARK],
];

interface Ins { action: string; data: { style: { color: number; alpha: number } } }

function drawn(id: 'smelter' | 'silicon_works', code: number): { fills: Array<{ color: number; alpha: number }>; strokes: number[] } {
  const g = new GraphicsContext();
  status[id]!.draw(g, code, id);
  const fills: Array<{ color: number; alpha: number }> = [];
  const strokes: number[] = [];
  for (const ins of g.instructions as unknown as Ins[]) {
    if (ins.action === 'fill') fills.push({ color: ins.data.style.color, alpha: ins.data.style.alpha });
    if (ins.action === 'stroke') strokes.push(ins.data.style.color);
  }
  return { fills, strokes };
}

describe('lightProduction: smelter and silicon works', () => {
  it('each kind is registered in the style table and the body-status table', () => {
    for (const [id] of KINDS) {
      expect(typeof kinds[id], id).toBe('function');
      expect(family.kinds[id], id).toBe(kinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
      expect(structureStyleVersion('c', id), id).toBe(family.version);
      expect(hasBodyStatus(id), id).toBe(true);
      expect(BODY_STATUS_HOOKS[id], id).toBe(status[id]);
      expect(kinds[id]).not.toBe(family.kinds.refinery);
    }
    expect(kinds.smelter).not.toBe(kinds.silicon_works);
  });

  it('art stays inside the footprint outline, powered and unpowered, with livery', () => {
    for (const [id] of KINDS) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0xff8844, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(150);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.sigils!.length, id).toBe(1);
        expect(v.bands!.length, id).toBeGreaterThan(0);
      }
    }
  });

  it('every slit is baked as dead glass, and the mark sits on the structure', () => {
    for (const [id, slits, mark] of KINDS) {
      expect(slits.length, id).toBeGreaterThanOrEqual(3);
      expect(slits.length, id).toBeLessThanOrEqual(6);
      const polys = buildStructureVisual(id, { accent: 0xff8844, style: 'c', powered: true }).polys!;
      const dead = polys.filter((p) => p.mat === 'glow' && p.color === SLIT_DEAD);
      expect(dead, id).toHaveLength(slits.length);
      const out = outlinePx(id, 'c');
      expect(polyEdgeDist(out, mark[0], mark[1]), id).toBeGreaterThan(mark[2]);
    }
  });

  it('working lights exactly its slits; starved draws the red mark; dark draws nothing', () => {
    for (const [id, slits] of KINDS) {
      expect(drawn(id, WORK_DARK), id).toEqual({ fills: [], strokes: [] });
      const lit = drawn(id, WORK_ON);
      expect(lit.fills.filter((f) => f.color === LAMP_AMBER && f.alpha > 0.9), id).toHaveLength(slits.length);
      expect(lit.strokes.includes(NO_SUPPLY_RED), id).toBe(false);
      const starved = drawn(id, WORK_STARVED);
      expect(starved.strokes.length, id).toBeGreaterThan(0);
      expect(starved.strokes.every((s) => s === NO_SUPPLY_RED), id).toBe(true);
      expect(starved.fills.some((f) => f.color === LAMP_AMBER), id).toBe(false);
    }
  });
});
