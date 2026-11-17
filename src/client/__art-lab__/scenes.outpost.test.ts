/**
 * Art lab `scene=outpost` (structure restyle slice 1a): the small refining
 * outpost at Ladder A sizes, scale ships, grid links and phone framing.
 */
import { describe, expect, it } from 'vitest';
import { buildScene, OUTPOST_SIZES, parseStructStyle, structFootprint, structScale, type Cam, type Pose } from './scenes.js';
import { shipExtent } from '../render/art/fields.js';

const LANDSCAPE = { w: 915, h: 412 }; // Pixel 7
const PORTRAIT = { w: 412, h: 915 };

describe('art lab outpost scene', () => {
  const s = buildScene('outpost', undefined, 40, LANDSCAPE);
  const count = (id: string): number => s.structs.filter((st) => st.id === id).length;

  it('lays out the refining outpost', () => {
    expect(s.structs[0]!.id).toBe('capital');
    expect([s.structs[0]!.x, s.structs[0]!.y]).toEqual([0, 0]);
    expect(count('capital')).toBe(1);
    expect(count('connector')).toBe(4);
    expect(count('reactor')).toBe(1);
    expect(count('cargo_bay')).toBe(3);
    expect(count('refinery')).toBe(1);
    expect(count('freight_dock')).toBe(2);
    const docks = s.structs.filter((st) => st.id === 'freight_dock').map((st) => st.label);
    expect(docks.sort()).toEqual(['INTAKE', 'OUTLET']);
    expect(s.ships.map((sh) => sh.id).sort()).toEqual(['destroyer', 'fighter', 'trader-hauler']);
  });

  it('sizes every structure on Ladder A (Small 150–300, Medium 600–1,200)', () => {
    for (const st of s.structs) {
      const fp = structFootprint(st.id), k = structScale(st);
      const side = Math.max(fp.w, fp.h) * k;
      expect(side).toBeCloseTo(OUTPOST_SIZES[st.id]!, 6);
      expect((side >= 150 && side <= 300) || (side >= 600 && side <= 1200) || st.id === 'connector').toBe(true);
    }
  });

  it('links every structure into one grid rooted at the beacon', () => {
    const seen = new Set([0]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [a, b] of s.edges!) {
        if (seen.has(a) !== seen.has(b)) { seen.add(a); seen.add(b); grew = true; }
      }
    }
    expect(seen.size).toBe(s.structs.length);
  });

  it('parks the hauler just off the intake dock', () => {
    const intake = s.structs.find((st) => st.label === 'INTAKE')!;
    const p: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
    s.ships.find((sh) => sh.id === 'trader-hauler')!.pose(0, p);
    const gap = Math.hypot(p.x - intake.x, p.y - intake.y) - (structFootprint('freight_dock').h * structScale(intake)) / 2 - shipExtent('trader-hauler');
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(200);
  });

  it.each([['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const)('frames the whole outpost on a %s phone', (_n, view) => {
    const sc = buildScene('outpost', undefined, 40, view);
    const cam: Cam = { x: 0, y: 0, zoom: 1 };
    sc.camera(0, cam);
    for (const st of sc.structs) {
      const fp = structFootprint(st.id), k = structScale(st);
      expect(Math.abs(st.x - cam.x) + (fp.w * k) / 2).toBeLessThanOrEqual(view.w / 2 / cam.zoom);
      expect(Math.abs(st.y - cam.y) + (fp.h * k) / 2).toBeLessThanOrEqual(view.h / 2 / cam.zoom);
    }
    const p: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
    for (const sh of sc.ships) {
      sh.pose(0, p);
      expect(Math.abs(p.x - cam.x)).toBeLessThanOrEqual(view.w / 2 / cam.zoom);
      expect(Math.abs(p.y - cam.y)).toBeLessThanOrEqual(view.h / 2 / cam.zoom);
    }
  });

  it('accepts restyle=current and falls back to it', () => {
    expect(parseStructStyle('current')).toBe('current');
    expect(parseStructStyle(null)).toBe('current');
    expect(parseStructStyle('zzz')).toBe('current');
  });
});
