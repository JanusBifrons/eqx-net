/**
 * Storage fill gauges (live body state): the storage vault lights one silo
 * hatch ring per sixth full, the cargo bay one container strip per quarter
 * full, from the row's `fillPct`; dark while unbuilt or empty.
 */
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from 'pixi.js';
import { bodyStatusCode, hasBodyStatus } from './structureSocketNubs.js';
import { BODY_STATUS_HOOKS } from './structureStyleC.js';
import { BAY_CONTAINERS, VAULT_SILOS, status } from './structureStyleC.storage.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(fillPct: number | undefined, built = true): StructureRenderState {
  return { powered: true, netPower: 1, connTo: [], connSockSelf: [], built, buildPct: built ? 1 : 0.3, deconstructPct: 0, fillPct };
}

/** How many draw calls (strokes / fills) a code makes. */
function drawCount(kind: 'storage_vault' | 'cargo_bay', code: number): number {
  const g = new GraphicsContext();
  status[kind]!.draw(g, code, kind);
  return g.instructions.length;
}

describe('storage fill gauges', () => {
  it('vault and cargo bay have a body state, combined into BODY_STATUS_HOOKS', () => {
    expect(hasBodyStatus('storage_vault')).toBe(true);
    expect(hasBodyStatus('cargo_bay')).toBe(true);
    expect(BODY_STATUS_HOOKS.storage_vault).toBe(status.storage_vault);
    expect(BODY_STATUS_HOOKS.cargo_bay).toBe(status.cargo_bay);
  });

  it('vault code = silos full (one at least while anything is stored), 0 unbuilt or empty', () => {
    const n = VAULT_SILOS.length;
    expect(n).toBe(6);
    const want: Record<number, number> = { 0: 0, 10: 1, 20: 1, 30: 2, 50: 3, 70: 4, 80: 5, 90: 5, 100: 6 };
    for (const [pct, code] of Object.entries(want)) expect(bodyStatusCode('storage_vault', row(Number(pct))), pct).toBe(code);
    expect(bodyStatusCode('storage_vault', row(undefined))).toBe(0);
    expect(bodyStatusCode('storage_vault', row(250))).toBe(n);
    expect(bodyStatusCode('storage_vault', row(60, false))).toBe(0);
    expect(bodyStatusCode('storage_vault', undefined)).toBe(0);
  });

  it('cargo bay code = containers full (one at least while anything is stored), 0 unbuilt or empty', () => {
    expect(BAY_CONTAINERS.length).toBe(4);
    const want: Record<number, number> = { 0: 0, 10: 1, 30: 1, 40: 2, 60: 2, 70: 3, 90: 4, 100: 4 };
    for (const [pct, code] of Object.entries(want)) expect(bodyStatusCode('cargo_bay', row(Number(pct))), pct).toBe(code);
    expect(bodyStatusCode('cargo_bay', row(50, false))).toBe(0);
  });

  it('code N draws exactly N lit units (same calls per unit), none at 0', () => {
    for (const kind of ['storage_vault', 'cargo_bay'] as const) {
      const max = kind === 'storage_vault' ? VAULT_SILOS.length : BAY_CONTAINERS.length;
      expect(drawCount(kind, 0)).toBe(0);
      const per = drawCount(kind, 1);
      expect(per).toBeGreaterThan(0);
      for (let n = 1; n <= max; n++) expect(drawCount(kind, n), `${kind} ${n}`).toBe(per * n);
      expect(drawCount(kind, max + 2)).toBe(per * max);
    }
  });

  it('fill order: the bottom (+y) row first', () => {
    expect(VAULT_SILOS.slice(0, 3).every(([, y]) => y > 0)).toBe(true);
    expect(BAY_CONTAINERS.slice(0, 2).every(([, y]) => y > 0)).toBe(true);
  });
});
