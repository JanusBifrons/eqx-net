/**
 * Building panels B4 — the recipe queue on the wire: `prodQ0` / `prodQ1`
 * (uint32 each) round-trip 0..7 entries plus the repeat flag (bit 31 of
 * `prodQ1`). Two-sided contract (#15): one encoder, one decoder, both here.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_RECIPE_QUEUE,
  PROD_QUEUE_WIRE_SLOTS,
  decodeProdQueue,
  decodeProdQueueRepeat,
  encodeProdQ0,
  encodeProdQ1,
} from './production.js';
import { RECIPE_IDS, type RecipeId } from './recipes.js';

const LAST = RECIPE_IDS[RECIPE_IDS.length - 1]!;

function roundTrip(queue: RecipeId[] | undefined, repeat: boolean): { queue: RecipeId[]; repeat: boolean; q0: number; q1: number } {
  const q0 = encodeProdQ0(queue);
  const q1 = encodeProdQ1(queue, repeat);
  return { queue: decodeProdQueue(q0, q1, []), repeat: decodeProdQueueRepeat(q1), q0, q1 };
}

describe('recipe queue wire (B4)', () => {
  it('the wire holds every entry after the head', () => {
    expect(PROD_QUEUE_WIRE_SLOTS).toBe(MAX_RECIPE_QUEUE - 1);
  });

  it('no queue, repeat off: both words 0 (the omitted default)', () => {
    expect(roundTrip(undefined, false)).toEqual({ queue: [], repeat: false, q0: 0, q1: 0 });
    expect(roundTrip([], false)).toEqual({ queue: [], repeat: false, q0: 0, q1: 0 });
  });

  it('one entry', () => {
    const r = roundTrip(['build_gunship'], false);
    expect(r.queue).toEqual(['build_gunship']);
    expect(r.q1).toBe(0);
  });

  it('seven entries, including the highest recipe index in every byte position', () => {
    const queue: RecipeId[] = ['build_gunship', LAST, 'build_interceptor', LAST, 'build_heavy', LAST, LAST];
    for (const repeat of [false, true]) {
      const r = roundTrip(queue, repeat);
      expect(r.queue).toEqual(queue);
      expect(r.repeat).toBe(repeat);
      expect(r.q0).toBeLessThanOrEqual(0xffffffff);
      expect(r.q1).toBeLessThanOrEqual(0xffffffff);
      expect(r.q0).toBeGreaterThanOrEqual(0);
    }
  });

  it('repeat alone, with an empty queue', () => {
    const r = roundTrip([], true);
    expect(r.queue).toEqual([]);
    expect(r.repeat).toBe(true);
    expect(r.q0).toBe(0);
  });

  it('entries past the wire slots are dropped, never spill into the repeat bit', () => {
    const queue = Array.from({ length: 9 }, () => LAST);
    const r = roundTrip(queue, false);
    expect(r.queue).toHaveLength(PROD_QUEUE_WIRE_SLOTS);
    expect(r.repeat).toBe(false);
  });

  it('decodes in place: the same array, cleared then refilled', () => {
    const out: RecipeId[] = ['build_heavy', 'build_heavy', 'build_heavy'];
    const same = decodeProdQueue(encodeProdQ0(['build_gunship']), 0, out);
    expect(same).toBe(out);
    expect(out).toEqual(['build_gunship']);
  });
});
