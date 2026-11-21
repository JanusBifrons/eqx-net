/**
 * Hydroponics bay and fabricator (style C, light production): each has a
 * drawer that stays in its footprint outline and bakes its work-glow slits
 * dark; the live overlay lights exactly those slits while it works, draws
 * the red no-supply mark while starved, and nothing otherwise.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { buildStructureVisual } from './structureVisuals.js';
import { structureStyleDrawer } from './structureStyles.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import { insidePoly, outlinePx, polyEdgeDist, LAMP_AMBER } from './structureStyleKit.js';
import { NO_SUPPLY_RED } from './structureStyleC.power.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import * as family from './structureStyleC.lightProduction.js';
import {
  FABRICATOR_MARK, FABRICATOR_SLITS, HYDROPONICS_MARK, HYDROPONICS_SLITS, kinds, status,
} from './structureStyleC.lightProduction.hydro.js';
import { SLIT_DEAD, WORK_DARK, WORK_ON, WORK_STARVED, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';
import { PROD_STATE } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const KINDS: ReadonlyArray<readonly ['hydroponics' | 'fabricator', ReadonlyArray<WorkSlit>, WorkMark]> = [
  ['hydroponics', HYDROPONICS_SLITS, HYDROPONICS_MARK],
  ['fabricator', FABRICATOR_SLITS, FABRICATOR_MARK],
];

function row(prodState: number | undefined): StructureRenderState {
  return { powered: true, netPower: 1, connTo: [], connSockSelf: [], built: true, buildPct: 1, deconstructPct: 0, prodState };
}

interface Ins { action: string; data: { style: { color: number; alpha: number } } }

function drawn(id: 'hydroponics' | 'fabricator', code: number): { fills: Array<{ color: number; alpha: number }>; strokes: number[] } {
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

describe('light production: hydroponics and fabricator', () => {
  it('each kind is registered in the style table and the body status table', () => {
    for (const [id] of KINDS) {
      expect(typeof kinds[id], id).toBe('function');
      expect(family.kinds[id], id).toBe(kinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
      expect(hasBodyStatus(id), id).toBe(true);
      expect(BODY_STATUS_HOOKS[id], id).toBe(status[id]);
      expect(kinds[id]).not.toBe(family.kinds.refinery);
    }
    expect(kinds.hydroponics).not.toBe(kinds.fabricator);
  });

  it('the code follows prodState: running lit, starved marked, else dark', () => {
    for (const [id] of KINDS) {
      expect(bodyStatusCode(id, row(PROD_STATE.running)), id).toBe(WORK_ON);
      expect(bodyStatusCode(id, row(PROD_STATE.starved)), id).toBe(WORK_STARVED);
      expect(bodyStatusCode(id, row(PROD_STATE.blocked)), id).toBe(WORK_DARK);
      expect(bodyStatusCode(id, undefined), id).toBe(WORK_DARK);
    }
  });

  it('working lights exactly its slits; starved draws only the mark; dark draws nothing', () => {
    for (const [id, slits] of KINDS) {
      expect(slits.length, id).toBeGreaterThanOrEqual(3);
      expect(slits.length, id).toBeLessThanOrEqual(6);
      expect(drawn(id, WORK_DARK), id).toEqual({ fills: [], strokes: [] });
      const lit = drawn(id, WORK_ON);
      expect(lit.fills.filter((f) => f.color === LAMP_AMBER && f.alpha > 0.9), id).toHaveLength(slits.length);
      expect(lit.strokes.includes(NO_SUPPLY_RED), id).toBe(false);
      const starved = drawn(id, WORK_STARVED);
      expect(starved.strokes.length, id).toBeGreaterThan(0);
      expect(starved.strokes.every((c) => c === NO_SUPPLY_RED), id).toBe(true);
      expect(starved.fills.some((f) => f.color === LAMP_AMBER), id).toBe(false);
    }
  });

  it('art stays inside the footprint outline and bakes every slit dark; the mark sits clear of the slits', () => {
    for (const [id, slits, [mx, my, mh]] of KINDS) {
      const out = outlinePx(id, 'c');
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0xf2c46b, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(60);
        expect(v.rects, id).toEqual([]);
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.sigils!.length, id).toBeGreaterThan(0);
        expect(v.polys!.filter((p) => p.mat === 'glow' && p.color === SLIT_DEAD), id).toHaveLength(slits.length);
      }
      expect(polyEdgeDist(out, mx, my), id).toBeGreaterThan(mh);
      for (const [x, y, w, h] of slits) {
        const apart = mx + mh < x || mx - mh > x + w || my + mh < y || my - mh > y + h;
        expect(apart, `${id} mark vs slit ${x},${y}`).toBe(true);
      }
    }
  });
});
