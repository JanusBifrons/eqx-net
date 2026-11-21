/**
 * Crew modules with no power (live body state): the habitat's and the
 * spire's window glass (and the spire's beacon) go dead over the lit bake.
 * The bake is always the powered art, so this overlay is the only way the
 * windows go dark in game.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { habitatWindows, spireWindows, status } from './structureStyleC.storage.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(powered: boolean, built = true): StructureRenderState {
  return { powered, netPower: powered ? 1 : 0, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0 };
}

function fills(kind: 'habitat_module' | 'tower_module', code: number): number {
  const g = new GraphicsContext();
  status[kind]!.draw(g, code, kind);
  return g.instructions.length;
}

describe('crew modules go dark unpowered', () => {
  it('habitat and tower have a body state, combined into BODY_STATUS_HOOKS', () => {
    for (const kind of ['habitat_module', 'tower_module'] as const) {
      expect(hasBodyStatus(kind)).toBe(true);
      expect(BODY_STATUS_HOOKS[kind]).toBe(status[kind]);
    }
  });

  it('code 1 only for a built row with no power', () => {
    for (const kind of ['habitat_module', 'tower_module'] as const) {
      expect(bodyStatusCode(kind, row(false))).toBe(1);
      expect(bodyStatusCode(kind, row(true))).toBe(0);
      expect(bodyStatusCode(kind, row(false, false))).toBe(0);
      expect(bodyStatusCode(kind, undefined)).toBe(0);
    }
  });

  it('unpowered deadens every window (and the beacon); powered draws nothing', () => {
    expect(fills('habitat_module', 1)).toBe(habitatWindows(1).length);
    expect(fills('tower_module', 1)).toBe(spireWindows(1).flat().length + 1);
    expect(fills('habitat_module', 0)).toBe(0);
    expect(fills('tower_module', 0)).toBe(0);
  });
});
