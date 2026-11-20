/**
 * Style C light production, munitions works and reclaimer: each has its own
 * drawer in the family's style table, its art stays in the footprint outline,
 * its work-glow slits are baked dark, and its live body state lights exactly
 * its slits while working, the red no-supply mark when starved, nothing when dark.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import {
  MUNITIONS_MARK, MUNITIONS_SLITS, RECLAIMER_MARK, RECLAIMER_SLITS, kinds as muniKinds, status as muniStatus,
} from './structureStyleC.lightProduction.muni.js';
import { kinds, status } from './structureStyleC.lightProduction.js';
import { SLIT_DEAD, WORK_DARK, WORK_ON, WORK_STARVED, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';
import { NO_SUPPLY_RED } from './structureStyleC.power.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { structureStyleDrawer } from './structureStyles.js';
import { buildStructureVisual } from './structureVisuals.js';
import { LAMP_AMBER, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { PROD_STATE } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const KINDS: ReadonlyArray<readonly ['munitions_works' | 'reclaimer', ReadonlyArray<WorkSlit>, WorkMark]> = [
  ['munitions_works', MUNITIONS_SLITS, MUNITIONS_MARK],
  ['reclaimer', RECLAIMER_SLITS, RECLAIMER_MARK],
];

function row(prodState: number | undefined, built = true, powered = true): StructureRenderState {
  return { powered, netPower: 1, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0, prodState };
}

interface Ins { action: string; data: { style: { color: number; alpha: number } } }

function drawn(id: string, code: number): { fills: Array<{ color: number; alpha: number }>; strokes: number[] } {
  const g = new GraphicsContext();
  status[id]!.draw(g, code, id as 'reclaimer');
  const fills: Array<{ color: number; alpha: number }> = [];
  const strokes: number[] = [];
  for (const ins of g.instructions as unknown as Ins[]) {
    if (ins.action === 'fill') fills.push({ color: ins.data.style.color, alpha: ins.data.style.alpha });
    if (ins.action === 'stroke') strokes.push(ins.data.style.color);
  }
  return { fills, strokes };
}

describe('light production: munitions works and reclaimer (style C)', () => {
  it('each kind has its own drawer and body state, spread into the combined tables', () => {
    for (const [id] of KINDS) {
      expect(kinds[id], id).toBe(muniKinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(muniKinds[id]);
      expect(muniKinds[id]).not.toBe(kinds.refinery);
      expect(hasBodyStatus(id), id).toBe(true);
      expect(BODY_STATUS_HOOKS[id], id).toBe(muniStatus[id]);
    }
    expect(muniKinds.munitions_works).not.toBe(muniKinds.reclaimer);
  });

  it('art stays inside the footprint outline, with livery; every slit is baked dead', () => {
    for (const [id, slits, mark] of KINDS) {
      const v = buildStructureVisual(id, { accent: 0xf2c46b, style: 'c', livery: true, powered: true });
      expect(v.polys!.length, id).toBeGreaterThan(60);
      const out = outlinePx(id, 'c');
      for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
      for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
      for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
      expect(v.polys!.some((p) => p.mat === 'hazard'), id).toBe(true);
      expect(v.polys!.filter((p) => p.mat === 'glow' && p.color === SLIT_DEAD), id).toHaveLength(slits.length);
      expect(slits.length, id).toBeGreaterThanOrEqual(3);
      expect(slits.length, id).toBeLessThanOrEqual(6);
      expect(polyEdgeDist(out, mark[0], mark[1]), id).toBeGreaterThan(mark[2]);
    }
  });

  it('code from the row: running = working, starved = starved, else dark', () => {
    for (const [id] of KINDS) {
      expect(bodyStatusCode(id, row(PROD_STATE.running)), id).toBe(WORK_ON);
      expect(bodyStatusCode(id, row(PROD_STATE.starved)), id).toBe(WORK_STARVED);
      expect(bodyStatusCode(id, row(PROD_STATE.blocked)), id).toBe(WORK_DARK);
      expect(bodyStatusCode(id, row(PROD_STATE.running, false)), id).toBe(WORK_DARK);
      expect(bodyStatusCode(id, row(PROD_STATE.running, true, false)), id).toBe(WORK_DARK);
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
      expect(starved.strokes.every((c) => c === NO_SUPPLY_RED), id).toBe(true);
      expect(starved.fills.some((f) => f.color === LAMP_AMBER), id).toBe(false);
    }
  });
});
