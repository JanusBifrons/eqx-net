/**
 * Mine layer rack lamps (live body state): one lamp lit per mine the layer has
 * out (`StructureRenderState.minesOut`, from the row's `minesOut`), drawn on
 * the socket-nub overlay at `MINE_LAMP_SOCKETS`; dark while unbuilt.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import { status, MINE_LAMP_SOCKETS, RACKS } from './structureStyleC.turretsHeavy.js';
import * as turrets from './structureStyleC.turrets.js';
import { LAMP_AMBER } from './structureStyleKit.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(minesOut: number | undefined, built = true): StructureRenderState {
  return { powered: true, netPower: 1, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0, minesOut };
}

/** The lit lamp centres drawn for `code` (the amber lens circles). */
function litCentres(code: number): Array<[number, number]> {
  const g = new GraphicsContext();
  status.mine_layer!.draw(g, code, 'mine_layer');
  const out: Array<[number, number]> = [];
  for (const ins of g.instructions) {
    if (ins.action !== 'fill') continue;
    const d = ins.data as { style: { color: number; alpha: number }; path: { shapePath: { shapePrimitives: Array<{ shape: { x: number; y: number } }> } } };
    if (d.style.color !== LAMP_AMBER || d.style.alpha < 0.9) continue;
    const s = d.path.shapePath.shapePrimitives[0]!.shape;
    out.push([s.x, s.y]);
  }
  return out;
}

describe('mine layer: a rack lamp lit per mine out', () => {
  it('the mine layer has a body state, spread through the turrets family', () => {
    expect(hasBodyStatus('mine_layer')).toBe(true);
    expect(turrets.status.mine_layer).toBe(status.mine_layer);
  });

  it('code = mines out on a built layer (capped at the racks), 0 unbuilt', () => {
    for (let n = 0; n <= RACKS; n++) expect(bodyStatusCode('mine_layer', row(n)), `${n}`).toBe(n);
    expect(bodyStatusCode('mine_layer', row(undefined))).toBe(0);
    expect(bodyStatusCode('mine_layer', row(RACKS + 3))).toBe(RACKS);
    expect(bodyStatusCode('mine_layer', row(4, false))).toBe(0);
    expect(bodyStatusCode('mine_layer', undefined)).toBe(0);
  });

  it('code N lights exactly the first N lamp sockets', () => {
    const fp = getStructureKind('mine_layer').footprint;
    const R = Math.min(fp.w, fp.h) / 2;
    expect(litCentres(0)).toEqual([]);
    for (let n = 1; n <= RACKS; n++) {
      const got = litCentres(n);
      expect(got, `${n}`).toHaveLength(n);
      for (let k = 0; k < n; k++) {
        expect(got[k]![0]).toBeCloseTo(MINE_LAMP_SOCKETS[k]![0] * R, 6);
        expect(got[k]![1]).toBeCloseTo(MINE_LAMP_SOCKETS[k]![1] * R, 6);
      }
    }
  });
});
