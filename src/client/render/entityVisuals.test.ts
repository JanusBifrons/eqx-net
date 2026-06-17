import { describe, it, expect } from 'vitest';
import {
  ENTITY_VISUALS,
  ENTITY_KIND_ORDER,
  entityLabel,
  entityBadgePolygon,
  entityBadgeCount,
} from './entityVisuals';

describe('entityVisuals (shared visual language)', () => {
  it('has a visual for every kind in the display order', () => {
    expect(ENTITY_KIND_ORDER).toHaveLength(4);
    for (const k of ENTITY_KIND_ORDER) expect(ENTITY_VISUALS[k].kind).toBe(k);
  });

  it('exposes both Pixi (0xRRGGBB) and CSS colours that agree', () => {
    for (const k of ENTITY_KIND_ORDER) {
      const v = ENTITY_VISUALS[k];
      expect(v.cssColor).toBe(`#${v.color.toString(16).padStart(6, '0')}`);
    }
  });

  it('entityLabel pluralises conditionally', () => {
    expect(entityLabel('ship', 1)).toBe('ship');
    expect(entityLabel('ship', 2)).toBe('ships');
    expect(entityLabel('hostile', 1)).toBe('hostile');
    expect(entityLabel('hostile', 3)).toBe('hostiles');
    expect(entityLabel('neutral', 1)).toBe('neutral drone');
    expect(entityLabel('neutral', 2)).toBe('neutral drones');
    expect(entityLabel('structure', 1)).toBe('structure');
    expect(entityLabel('structure', 5)).toBe('structures');
  });

  it('every visual carries a positive per-shape number scale', () => {
    for (const k of ENTITY_KIND_ORDER) {
      expect(ENTITY_VISUALS[k].numScale).toBeGreaterThan(0);
    }
    // The star's narrow body needs a smaller number than the open shapes.
    expect(ENTITY_VISUALS.hostile.numScale).toBeLessThan(ENTITY_VISUALS.neutral.numScale);
  });

  it('entityBadgeCount caps at "99+" and shrinks the font as digits grow', () => {
    expect(entityBadgeCount(1)).toEqual({ label: '1', scale: 1 });
    expect(entityBadgeCount(9).label).toBe('9');
    expect(entityBadgeCount(99).label).toBe('99');
    // Above 99 → "99+", never a 3-digit number.
    expect(entityBadgeCount(100).label).toBe('99+');
    expect(entityBadgeCount(4096).label).toBe('99+');
    // More digits → smaller scale (so it still fits the shape), monotonic.
    expect(entityBadgeCount(99).scale).toBeLessThan(entityBadgeCount(9).scale);
    expect(entityBadgeCount(100).scale).toBeLessThan(entityBadgeCount(99).scale);
  });

  it('entityBadgePolygon returns flat point pairs whose bbox is vertically centred', () => {
    for (const k of ENTITY_KIND_ORDER) {
      const r = 10;
      const pts = entityBadgePolygon(ENTITY_VISUALS[k].shape, r);
      expect(pts.length % 2).toBe(0);
      expect(pts.length).toBeGreaterThanOrEqual(6); // ≥ 3 vertices
      const ys: number[] = [];
      for (let i = 1; i < pts.length; i += 2) ys.push(pts[i]!);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      // bbox-centred on 0 (a number at y≈0 then reads centred), within ~r bounds.
      expect(Math.abs(minY + maxY)).toBeLessThan(1.0);
      expect(maxY).toBeLessThanOrEqual(r + 0.001);
      expect(minY).toBeGreaterThanOrEqual(-r - 0.001);
    }
  });
});
