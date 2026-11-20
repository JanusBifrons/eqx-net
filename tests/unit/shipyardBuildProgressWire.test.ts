/**
 * Loop 3L — the Shipyard's build animation follows the server's build
 * progress. Two-sided contract (#15): the server's cycle fraction
 * (`ProductionSubsystem.cycleFraction`, packed with `encodeProdFrac` into the
 * row's `prodFrac` byte) and the client's decode (`decodeStructureState`)
 * must agree, and a client decoding a mid-build row (a late joiner, #16)
 * poses the build clip at that point.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem } from '../../src/server/structures/ProductionSubsystem.js';
import type { StructureRecord, StructureRegistry } from '../../src/server/structures/StructureRegistry.js';
import { PROD_FRAC_MAX, PROD_STATE, decodeProdFrac, encodeProdFrac, encodeRecipe } from '../../src/shared-types/production.js';
import { RECIPES } from '../../src/shared-types/recipes.js';
import type { StructureStateView } from '../../src/shared-types/structureStateWire.js';
import { decodeStructureState, emptyStructureRow } from '../../src/client/net/structureStateDecode.js';
import { shipyardRowClip } from '../../src/client/render/pixi/structureStyleC.shipyardBuild.js';
import { SHIPYARD_BUILD_TICKS } from '../../src/core/articulation/rigs/heavyIndustry.js';

const OWNERS = { ids: ['alice'], names: ['Alice'] };
const NO_LINKS = { length: 0, at: () => undefined };

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

/** A powered yard building an interceptor from a Capital's minerals. */
function yardWorld() {
  const capital = rec('c', 'capital', { minerals: RECIPES.build_interceptor.inputs.minerals! * 4 });
  const bay = rec('bay', 'cargo_bay', { hold: { goods: {}, blueprints: [] } });
  const yard = rec('y', 'shipyard', {
    recipe: 'build_interceptor',
    blueprint: { uid: 'bp', product: 'hull:interceptor', kind: 'bpo', runs: null, material: 0, output: 0, research: 0 },
  });
  const recs = [capital, bay, yard];
  const byId = new Map(recs.map((r) => [r.id, r]));
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  const prod = new ProductionSubsystem({ registry, powered: () => true, componentOf: () => recs.map((r) => r.id) });
  return { prod, yard };
}

/** What the server writes on the yard's row (structuresSlice), as the client sees it. */
function wireRow(prod: ProductionSubsystem, yard: StructureRecord): StructureStateView {
  return {
    recipe: encodeRecipe(yard.recipe), prodState: yard.prodState, prodFrac: encodeProdFrac(prod.cycleFraction(yard)), connTo: NO_LINKS,
  };
}

describe('shipyard build progress on the wire (loop 3L)', () => {
  it('server and client agree on the progress encoding', () => {
    const { prod, yard } = yardWorld();
    const pulses = RECIPES.build_interceptor.cyclePulses;
    const out = emptyStructureRow();
    expect(prod.cycleFraction(yard)).toBe(0);
    for (let k = 1; k < pulses; k++) {
      prod.pulse();
      expect(yard.prodState).toBe(PROD_STATE.running);
      const f = prod.cycleFraction(yard);
      expect(f).toBeCloseTo(k / pulses, 9);
      decodeStructureState(wireRow(prod, yard), OWNERS, out, 'shipyard');
      expect(Math.abs((out.prodFrac ?? 0) - f)).toBeLessThanOrEqual(0.5 / PROD_FRAC_MAX + 1e-9);
    }
    // Ends of the byte, and out-of-range input, on both sides.
    expect(decodeProdFrac(encodeProdFrac(0))).toBe(0);
    expect(decodeProdFrac(encodeProdFrac(1))).toBe(1);
    expect(encodeProdFrac(2)).toBe(PROD_FRAC_MAX);
    expect(encodeProdFrac(Number.NaN)).toBe(0);
    expect(decodeProdFrac(undefined)).toBe(0);
  });

  it('clip time matches build progress on join', () => {
    const { prod, yard } = yardWorld();
    const pulses = RECIPES.build_interceptor.cyclePulses;
    const k = Math.floor(pulses * 0.6);
    for (let i = 0; i < k; i++) prod.pulse();
    // A client joining now decodes the row once and poses the clip there.
    const out = emptyStructureRow();
    decodeStructureState(wireRow(prod, yard), OWNERS, out, 'shipyard');
    const memo = { start: Number.NaN, seen: Number.NaN }, clip = { clipId: '', startTick: 0 };
    const now = 12345;
    expect(shipyardRowClip(out, now, memo, clip)).toBe(true);
    const shown = (now - clip.startTick) / SHIPYARD_BUILD_TICKS;
    expect(Math.abs(shown - k / pulses)).toBeLessThanOrEqual(0.5 / PROD_FRAC_MAX + 1e-9);
  });
});
