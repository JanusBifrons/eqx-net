/**
 * Refinery work glow (live body state): the work-glow slits are baked dark and
 * lit on the socket-nub overlay only while the refinery produces
 * (`prodState` running, built and powered); starved (an input missing) shows
 * the reactor's red no-supply mark; anything else stays dark.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import {
  REFINERY_DARK, REFINERY_SLITS, REFINERY_STARVED, REFINERY_WORKING, status,
} from './structureStyleC.lightProduction.js';
import { NO_SUPPLY_RED } from './structureStyleC.power.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { LAMP_AMBER } from './structureStyleKit.js';
import { PROD_STATE } from '../../../shared-types/production.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(prodState: number | undefined, built = true, powered = true, prodMissing?: number): StructureRenderState {
  return {
    powered, netPower: 1, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0,
    prodState, prodMissing,
  };
}

interface FillIns { action: string; data: { style: { color: number; alpha: number } } }

/** The fills drawn for `code` ({ colour, alpha }), and how many strokes. */
function drawn(code: number): { fills: Array<{ color: number; alpha: number }>; strokes: Array<{ color: number }> } {
  const g = new GraphicsContext();
  status.refinery!.draw(g, code, 'refinery');
  const fills: Array<{ color: number; alpha: number }> = [];
  const strokes: Array<{ color: number }> = [];
  for (const ins of g.instructions as unknown as FillIns[]) {
    if (ins.action === 'fill') fills.push({ color: ins.data.style.color, alpha: ins.data.style.alpha });
    if (ins.action === 'stroke') strokes.push({ color: ins.data.style.color });
  }
  return { fills, strokes };
}

describe('refinery: lit only while working, red mark when starved', () => {
  it('the refinery has a body state, spread into the combined table', () => {
    expect(hasBodyStatus('refinery')).toBe(true);
    expect(BODY_STATUS_HOOKS.refinery).toBe(status.refinery);
  });

  it('code from the row: running = working, starved = starved, else dark', () => {
    expect(bodyStatusCode('refinery', row(PROD_STATE.running))).toBe(REFINERY_WORKING);
    expect(bodyStatusCode('refinery', row(PROD_STATE.starved, true, true, 3))).toBe(REFINERY_STARVED);
    // A chunk recipe starves with no named good.
    expect(bodyStatusCode('refinery', row(PROD_STATE.starved))).toBe(REFINERY_STARVED);
    for (const s of [undefined, PROD_STATE.none, PROD_STATE.blocked, PROD_STATE.unpowered, PROD_STATE.needsBlueprint]) {
      expect(bodyStatusCode('refinery', row(s)), `${s}`).toBe(REFINERY_DARK);
    }
    expect(bodyStatusCode('refinery', undefined)).toBe(REFINERY_DARK);
  });

  it('unbuilt or unpowered is dark, whatever prodState says', () => {
    for (const s of [PROD_STATE.running, PROD_STATE.starved]) {
      expect(bodyStatusCode('refinery', row(s, false)), `unbuilt ${s}`).toBe(REFINERY_DARK);
      expect(bodyStatusCode('refinery', row(s, true, false)), `unpowered ${s}`).toBe(REFINERY_DARK);
    }
  });

  it('working lights every slit amber; dark draws nothing', () => {
    expect(drawn(REFINERY_DARK).fills).toEqual([]);
    const lit = drawn(REFINERY_WORKING);
    expect(lit.fills.filter((f) => f.color === LAMP_AMBER && f.alpha > 0.9)).toHaveLength(REFINERY_SLITS.length);
    expect(lit.strokes.some((s) => s.color === NO_SUPPLY_RED)).toBe(false);
  });

  it('starved draws the red no-supply mark and no lit slit', () => {
    const d = drawn(REFINERY_STARVED);
    expect(d.strokes.length).toBeGreaterThan(0);
    expect(d.strokes.every((s) => s.color === NO_SUPPLY_RED)).toBe(true);
    expect(d.fills.some((f) => f.color === LAMP_AMBER)).toBe(false);
  });
});
