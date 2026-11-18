/**
 * Pod size classes (owner 2026-11-17: one pod per dead ship, sized to it).
 * The pod's wire `componentIndex` carries size class and glow tier together.
 */
import { describe, expect, it } from 'vitest';
import { podComponentIndex, podSizeClass, podSizeOf, podTierOf, POD_TIERS, POD_SIZE_SCALES, POD_TIER_COLORS } from '../../shared-types/shipKinds/cargoPod.js';
import { shipScrapGroups } from './shipScrapGroups.js';
import { scrapColliderFor } from './scrapCollider.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

describe('cargo pod size classes', () => {
  it('a fighter gets the smallest pod, a capital the biggest', () => {
    expect(podSizeClass(getShipKind('fighter').radius)).toBe(0);
    expect(podSizeClass(32)).toBe(0);
    expect(podSizeClass(33)).toBe(1);
    expect(podSizeClass(getShipKind('trader-hauler').radius)).toBe(1);
    expect(podSizeClass(110)).toBe(2);
    expect(podSizeClass(300)).toBe(2);
    expect(podSizeClass(1220)).toBe(3);
  });

  it('size and tier round-trip through the componentIndex', () => {
    for (let s = 0; s < POD_SIZE_SCALES.length; s++) {
      for (let t = 0; t < POD_TIERS; t++) {
        const c = podComponentIndex(s, t);
        expect(podSizeOf(c)).toBe(s);
        expect(podTierOf(c)).toBe(t);
      }
    }
    // Size 0 keeps the old wire values (componentIndex = tier).
    expect(podComponentIndex(0, 2)).toBe(2);
  });

  it('every size class has a collider, each bigger than the last', () => {
    let last = 0;
    for (let s = 0; s < POD_SIZE_SCALES.length; s++) {
      const c = scrapColliderFor('cargo-pod', podComponentIndex(s, 1));
      expect(c, `size ${s}`).not.toBeNull();
      expect(c!.radius).toBeGreaterThan(last);
      last = c!.radius;
    }
  });
});

describe('cargo pod art (owner 2026-11-17: a red black box, beacon shows the best tier)', () => {
  it('each (size, tier) draws one red box, its seam and one beacon in the tier colour', () => {
    for (let s = 0; s < POD_SIZE_SCALES.length; s++) {
      for (let t = 0; t < POD_TIERS; t++) {
        const g = shipScrapGroups('cargo-pod')[podComponentIndex(s, t)]!;
        expect(g.parts.length, `size ${s} tier ${t}`).toBe(3);
        expect(g.parts[0]!.color).toBe(0xc4302a);
        expect(g.parts[2]!.color).toBe(POD_TIER_COLORS[t]);
      }
    }
  });
});
