/**
 * Gas collector and research lab (style C, light production): each has its own
 * drawer that stays in the footprint outline and bakes its work-glow slits
 * dark; the live overlay lights exactly those slits while it works, draws the
 * red no-supply mark when starved (gas collector outside a nebula, lab job
 * missing an input) and nothing otherwise.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import { GAS_MARK, GAS_SLITS, LAB_MARK, LAB_SLITS, kinds, status } from './structureStyleC.lightProduction.gaslab.js';
import { kinds as familyKinds, status as familyStatus } from './structureStyleC.lightProduction.js';
import { SLIT_DEAD, WORK_DARK, WORK_ON, WORK_STARVED, type WorkMark, type WorkSlit } from './structureStyleC.lightProduction.work.js';
import { NO_SUPPLY_RED } from './structureStyleC.power.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { structureStyleDrawer } from './structureStyles.js';
import { buildStructureVisual } from './structureVisuals.js';
import { LAMP_AMBER, insidePoly, outlinePx, polyEdgeDist } from './structureStyleKit.js';
import { PROD_STATE } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

const KINDS = [
  { id: 'gas_collector', slits: GAS_SLITS, mark: GAS_MARK },
  { id: 'research_lab', slits: LAB_SLITS, mark: LAB_MARK },
] as const satisfies ReadonlyArray<{ id: 'gas_collector' | 'research_lab'; slits: ReadonlyArray<WorkSlit>; mark: WorkMark }>;

function row(prodState: number | undefined, built = true, powered = true): StructureRenderState {
  return { powered, netPower: 1, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0, prodState };
}

interface Ins { action: string; data: { style: { color: number; alpha: number } } }

function drawn(id: 'gas_collector' | 'research_lab', code: number): { fills: Array<{ color: number; alpha: number }>; strokes: number[] } {
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

describe('light production: gas collector and research lab', () => {
  it('each kind is registered in the style table and the body-status hooks', () => {
    for (const { id } of KINDS) {
      expect(typeof kinds[id], id).toBe('function');
      expect(familyKinds[id], id).toBe(kinds[id]);
      expect(structureStyleDrawer('c', id), id).toBe(kinds[id]);
      expect(hasBodyStatus(id), id).toBe(true);
      expect(familyStatus[id], id).toBe(status[id]);
      expect(BODY_STATUS_HOOKS[id], id).toBe(status[id]);
    }
    expect(kinds.gas_collector).not.toBe(kinds.research_lab);
    expect(kinds.gas_collector).not.toBe(familyKinds.refinery);
    expect(kinds.research_lab).not.toBe(familyKinds.refinery);
  });

  it('3–6 slits per kind; slits and mark sit inside the outline', () => {
    for (const { id, slits, mark } of KINDS) {
      expect(slits.length, id).toBeGreaterThanOrEqual(3);
      expect(slits.length, id).toBeLessThanOrEqual(6);
      const out = outlinePx(id, 'c');
      for (const [x, y, w, h] of slits) {
        for (const [px, py] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as const) {
          expect(polyEdgeDist(out, px, py), `${id} slit ${x},${y}`).toBeGreaterThan(4);
        }
      }
      expect(polyEdgeDist(out, mark[0], mark[1]), `${id} mark`).toBeGreaterThan(mark[2]);
    }
  });

  it('art stays inside the footprint outline and bakes every slit dark', () => {
    for (const { id, slits } of KINDS) {
      for (const live of [true, false]) {
        const v = buildStructureVisual(id, { accent: 0x9b7bff, style: 'c', livery: true, powered: live });
        expect(v.polys!.length, id).toBeGreaterThan(60);
        expect(v.rects, id).toEqual([]);
        const out = outlinePx(id, 'c');
        for (const p of v.polys!) for (const [x, y] of p.pts) expect(polyEdgeDist(out, x, y), `${id} ${x},${y}`).toBeGreaterThan(-0.5);
        for (const l of v.lights) expect(insidePoly(out, l.x, l.y), id).toBe(true);
        for (const s of v.sigils ?? []) expect(polyEdgeDist(out, s.x, s.y), id).toBeGreaterThan(s.r);
        expect(v.sigils!.length, id).toBeGreaterThan(0);
        expect(v.polys!.filter((p) => p.mat === 'glow' && p.color === SLIT_DEAD), id).toHaveLength(slits.length);
        expect(live ? v.lights.length > 0 : v.lights.length === 0, `${id} lamps ${live}`).toBe(true);
      }
    }
  });

  it('code from the row: running = working, starved = starved, else dark', () => {
    for (const { id } of KINDS) {
      expect(bodyStatusCode(id, row(PROD_STATE.running)), id).toBe(WORK_ON);
      expect(bodyStatusCode(id, row(PROD_STATE.starved)), id).toBe(WORK_STARVED);
      expect(bodyStatusCode(id, row(PROD_STATE.none)), id).toBe(WORK_DARK);
      expect(bodyStatusCode(id, row(PROD_STATE.running, true, false)), id).toBe(WORK_DARK);
      expect(bodyStatusCode(id, undefined), id).toBe(WORK_DARK);
    }
  });

  it('working lights exactly its slits; starved draws only the red mark; dark draws nothing', () => {
    for (const { id, slits } of KINDS) {
      expect(drawn(id, WORK_DARK), id).toEqual({ fills: [], strokes: [] });
      const lit = drawn(id, WORK_ON);
      expect(lit.fills.filter((f) => f.color === LAMP_AMBER && f.alpha > 0.9), id).toHaveLength(slits.length);
      expect(lit.strokes.includes(NO_SUPPLY_RED), id).toBe(false);
      const st = drawn(id, WORK_STARVED);
      expect(st.strokes.length, id).toBeGreaterThan(0);
      expect(st.strokes.every((s) => s === NO_SUPPLY_RED), id).toBe(true);
      expect(st.fills.some((f) => f.color === LAMP_AMBER), id).toBe(false);
    }
  });
});
