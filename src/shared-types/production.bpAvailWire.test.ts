/**
 * Building panels B7 — the slot blueprint (`prodQ1` bits 24..30) and the
 * network's blueprint stock (`bpAvail`) on a processor's row. Two-sided
 * contract (#15): one encoder, one decoder, both in production.ts; this test
 * fails if they disagree.
 */
import { describe, expect, it } from 'vitest';
import {
  BP_AVAIL_MAX_RECIPES,
  blueprintRecipeBits,
  decodeBpAvail,
  decodeBpProduct,
  decodeProdQueue,
  decodeProdQueueRepeat,
  encodeBpProduct,
  encodeProdQ1,
  kindNeedsBlueprints,
  kindRecipes,
  prodQ1HasQueue,
} from './production.js';
import { PROCESSOR_KIND_IDS, RECIPES, blueprintProductFor, recipesFor, type RecipeId } from './recipes.js';

const INTERCEPTOR = blueprintProductFor('build_interceptor');
const GUNSHIP = blueprintProductFor('build_gunship');

describe('blueprint stock wire (B7)', () => {
  it('every processor kind runs at most BP_AVAIL_MAX_RECIPES recipes (one uint32 mask)', () => {
    for (const k of PROCESSOR_KIND_IDS) expect(kindRecipes(k).length, k).toBeLessThanOrEqual(BP_AVAIL_MAX_RECIPES);
  });

  it('kindRecipes is recipesFor, cached', () => {
    expect(kindRecipes('shipyard')).toEqual(recipesFor('shipyard'));
    expect(kindRecipes('shipyard')).toBe(kindRecipes('shipyard'));
  });

  it('the Shipyard needs blueprints; a smelter does not', () => {
    expect(kindNeedsBlueprints('shipyard')).toBe(true);
    expect(kindNeedsBlueprints('smelter')).toBe(false);
  });

  it('every recipe of every kind round-trips as the slot product, through prodQ1', () => {
    for (const k of PROCESSOR_KIND_IDS) {
      for (const r of kindRecipes(k)) {
        const q1 = encodeProdQ1(undefined, false, encodeBpProduct(k, blueprintProductFor(r)));
        // Two recipes sharing a product decode to the first; none do today.
        expect(decodeBpProduct(k, q1), `${k}/${r}`).toBe(r);
      }
    }
  });

  it('no blueprint, or one for nothing the kind runs, reads null', () => {
    expect(encodeBpProduct('shipyard', undefined)).toBe(0);
    expect(encodeBpProduct('shipyard', blueprintProductFor('smelt_alloy'))).toBe(0);
    expect(decodeBpProduct('shipyard', 0)).toBeNull();
  });

  it('the slot byte leaves the queue and repeat flag intact', () => {
    const queue: RecipeId[] = ['build_interceptor', 'build_gunship', 'build_heavy', 'build_barge', 'build_gunship', 'build_heavy', 'build_mining_skiff'];
    const bp = encodeBpProduct('shipyard', GUNSHIP);
    const q1 = encodeProdQ1(queue, true, bp);
    expect(q1).toBeLessThanOrEqual(0xffffffff);
    expect(decodeProdQueue(0x01010101, q1, []).slice(4)).toEqual(queue.slice(4));
    expect(decodeProdQueueRepeat(q1)).toBe(true);
    expect(decodeBpProduct('shipyard', q1)).toBe('build_gunship');
    expect(prodQ1HasQueue(q1)).toBe(true);
    // Slot byte alone, or with repeat: no queue entries.
    expect(prodQ1HasQueue(encodeProdQ1(undefined, true, bp))).toBe(false);
    expect(decodeProdQueue(0, encodeProdQ1(undefined, false, bp), [])).toEqual([]);
  });

  it('bpAvail round-trips any subset of a kind\'s recipes, in kind order, in place', () => {
    for (const k of PROCESSOR_KIND_IDS) {
      const list = kindRecipes(k);
      const pick = list.filter((_, i) => i % 2 === 0 || i === list.length - 1);
      let mask = 0;
      for (const r of pick) mask = (mask | blueprintRecipeBits(k, blueprintProductFor(r))) >>> 0;
      const out: RecipeId[] = ['smelt_alloy'];
      expect(decodeBpAvail(k, mask, out)).toBe(out);
      expect(out, k).toEqual(pick);
    }
    const out: RecipeId[] = ['build_gunship'];
    decodeBpAvail('shipyard', 0, out);
    expect(out).toEqual([]);
  });

  it('the Shipyard: interceptor + gunship blueprints decode to those hulls', () => {
    const mask = (blueprintRecipeBits('shipyard', INTERCEPTOR) | blueprintRecipeBits('shipyard', GUNSHIP)) >>> 0;
    expect(decodeBpAvail('shipyard', mask, [])).toEqual(['build_interceptor', 'build_gunship']);
    expect(blueprintRecipeBits('shipyard', 'hull:nothing')).toBe(0);
    expect(RECIPES.build_interceptor.blueprintRequired).toBe(true);
  });
});
