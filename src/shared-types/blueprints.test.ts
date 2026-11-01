import { describe, expect, it } from 'vitest';
import {
  BPC_RUNS_REF, MATERIAL_MAX, OUTPUT_YIELD_MAX, STARTER_HULL_KINDS, STARTER_STRUCTURE_KINDS,
  applyBlueprint, blueprintName, blueprintProducts, blueprintQuality, fittedCargoMul, fittedHullMul, fittedUid,
  isBlueprintUsedUp, makeBlueprint, parseProduct, productName, rollBlueprint, spendBlueprintRun, weaponGate, weaponUnlocked,
} from './blueprints.js';
import { parseHoldJson } from './goods.js';
import { rollEliteLoot } from './elites.js';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('modules (P5 ship upgrades)', () => {
  it('gates heat-seekers behind the Missile Rack; other weapons are free', () => {
    expect(weaponUnlocked('heat-seeker', [])).toBe(false);
    expect(weaponUnlocked('heat-seeker', ['bp-missile-rack'])).toBe(true);
    expect(weaponUnlocked('laser', [])).toBe(true);
    expect(weaponGate('heat-seeker')).toBe('bp-missile-rack');
    expect(weaponGate('hitscan')).toBeNull();
  });

  it('cargo and hull multipliers come only from their own modules', () => {
    expect(fittedCargoMul([])).toBe(1);
    expect(fittedCargoMul(['bp-cargo-expander'])).toBe(1.5);
    expect(fittedHullMul(['bp-cargo-expander'])).toBe(1);
    expect(fittedHullMul(['bp-reinforced-hull'])).toBe(1.25);
  });

  it('names never leak ids', () => {
    expect(blueprintName('bp-missile-rack')).toBe('Missile Rack');
    expect(blueprintName('mystery')).toBe('Blueprint');
    expect(fittedUid('ship-1')).toBe('fitted:ship-1');
  });
});

describe('blueprint items (economy v2 W2)', () => {
  it('products: non-starter structures + hulls + modules; starter kinds never need one', () => {
    const products = blueprintProducts();
    for (const k of STARTER_STRUCTURE_KINDS) expect(products).not.toContain(`structure:${k}`);
    for (const k of STARTER_HULL_KINDS) expect(products).not.toContain(`hull:${k}`);
    expect(products).toContain('hull:gunship');
    expect(products).toContain('module:bp-missile-rack');
    expect(products.some((p) => p.startsWith('structure:'))).toBe(true);
    expect(parseProduct('structure:smelter')).toEqual({ ns: 'structure', id: 'smelter' });
    expect(parseProduct('nope').ns).toBe('unknown');
  });

  it('product names are human (never a raw id)', () => {
    expect(productName('hull:gunship')).toBe('Gunship');
    expect(productName('module:bp-cargo-expander')).toBe('Cargo Expander');
    expect(productName('recipe:fab_components')).toBe('Fab Components');
  });

  it('applyBlueprint: material trims inputs (never below 1), output quality is a capped yield bonus', () => {
    const recipe = { inputs: { alloy: 20, salvage: 1 }, outputs: { core: 1 }, cyclePulses: 30 };
    const plain = applyBlueprint(recipe, { material: 0, output: 0 });
    expect(plain.inputs).toEqual({ alloy: 20, salvage: 1 });
    expect(plain.yieldBonus).toBe(0);
    const best = applyBlueprint(recipe, { material: 999, output: 999 });
    expect(best.inputs).toEqual({ alloy: Math.round(20 * (1 - MATERIAL_MAX / 100)), salvage: 1 });
    expect(best.yieldBonus).toBeCloseTo(OUTPUT_YIELD_MAX);
    expect(best.quality).toBe(100);
    // The balance cap: the best blueprint gains ≤ ~1.25× value, so a recipe
    // worth ≤ 1.6× its inputs stays under ~2× (production can't print money).
    expect((1 + OUTPUT_YIELD_MAX) / (1 - MATERIAL_MAX / 100)).toBeLessThan(1.25);
  });

  it('the glance score summarises the stats (0–100) — originals count full on runs', () => {
    expect(blueprintQuality({ kind: 'bpc', runs: 0, material: 0, output: 0 })).toBe(0);
    expect(blueprintQuality({ kind: 'bpo', runs: null, material: MATERIAL_MAX, output: 100 })).toBe(100);
    expect(blueprintQuality({ kind: 'bpc', runs: BPC_RUNS_REF, material: MATERIAL_MAX, output: 100 })).toBe(100);
  });

  it('a copy spends runs and is used up at 0; an original never is', () => {
    const rng = seeded(4);
    const bpc = { ...makeBlueprint('structure:smelter', 'bpc', rng), runs: 2 };
    expect(spendBlueprintRun(bpc)).toBe(true);
    expect(spendBlueprintRun(bpc)).toBe(true);
    expect(isBlueprintUsedUp(bpc)).toBe(true);
    expect(spendBlueprintRun(bpc)).toBe(false);
    const bpo = makeBlueprint('structure:smelter', 'bpo', rng);
    for (let i = 0; i < 50; i++) spendBlueprintRun(bpo);
    expect(isBlueprintUsedUp(bpo)).toBe(false);
    expect(bpo.runs).toBeNull();
  });

  it('drops are items for a known product; elites carry one ~40 % of the time', () => {
    expect(rollBlueprint(() => 0.99, 0.4)).toBeNull();
    const bp = rollBlueprint(seeded(3), 1)!;
    expect(blueprintProducts()).toContain(bp.product);
    expect(['bpo', 'bpc']).toContain(bp.kind);
    let withBp = 0;
    for (let s = 1; s <= 200; s++) if (rollEliteLoot('gunship', seeded(s)).blueprints.length > 0) withBp++;
    expect(withBp).toBeGreaterThan(40);
    expect(withBp).toBeLessThan(140);
  });

  it('a pre-W2 hold row (bare string ids) parses into single-run module copies', () => {
    const h = parseHoldJson('{"goods":{},"blueprints":["bp-missile-rack"]}');
    expect(h.blueprints).toHaveLength(1);
    expect(h.blueprints[0]).toMatchObject({ product: 'module:bp-missile-rack', kind: 'bpc', runs: 1 });
    // A W2 row round-trips its items and packed list.
    const json = JSON.stringify({
      goods: {}, blueprints: [makeBlueprint('hull:gunship', 'bpo', seeded(1))],
      packed: [{ product: 'structure:smelter', quality: 40 }],
    });
    const back = parseHoldJson(json);
    expect(back.blueprints[0]!.kind).toBe('bpo');
    expect(back.packed).toEqual([{ product: 'structure:smelter', quality: 40 }]);
  });
});
