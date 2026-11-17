/**
 * Art lab `scene=outpost` (structure restyle slice 1a): the small refining
 * outpost at Ladder A sizes, scale ships, grid links and phone framing.
 */
import { describe, expect, it } from 'vitest';
import { buildScene, OUTPOST_SIZES, parseStructStyle, structFootprint, structScale, type Cam, type Pose } from './scenes.js';
import { shipExtent } from '../render/art/fields.js';
import { DOCK_BAY_CX, DOCK_BAY_CY, DOCK_BAY_HALF_H, DOCK_BAY_HALF_W } from '../../core/articulation/rigCatalogue.js';

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
    expect(s.ships.map((sh) => sh.id).sort()).toEqual(['destroyer', 'fighter', 'trader-hauler', 'trader-hauler']);
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

  it('parks two haulers side by side, wholly on the intake dock\'s loading pad', () => {
    const intake = s.structs.find((st) => st.label === 'INTAKE')!;
    const k = structScale(intake);
    expect(k).toBeCloseTo(1, 6); // the outpost dock is the catalogue's medium dock
    const e = shipExtent('trader-hauler');
    const p: Pose = { x: 0, y: 0, rot: 0, thrust: 0 };
    const xs: number[] = [];
    for (const sh of s.ships.filter((h) => h.id === 'trader-hauler')) {
      sh.pose(0, p);
      xs.push(p.x);
      // Scene y is down: the pad lies at -y of the dock (game +y, the open edge).
      const lx = p.x - intake.x - DOCK_BAY_CX * k, ly = intake.y - p.y - DOCK_BAY_CY * k;
      expect(Math.abs(lx) + e * 0.6).toBeLessThanOrEqual(DOCK_BAY_HALF_W * k);
      expect(Math.abs(ly) + e).toBeLessThanOrEqual(DOCK_BAY_HALF_H * k);
    }
    expect(Math.abs(xs[0]! - xs[1]!)).toBeGreaterThan(2 * e * 0.6);
  });

  it('keeps the docks and their pads clear of each other and every other structure', () => {
    const box = (st: (typeof s.structs)[number]): [number, number, number, number] => {
      const fp = structFootprint(st.id), k = structScale(st);
      const b: [number, number, number, number] = [st.x - (fp.w * k) / 2, st.y - (fp.h * k) / 2, st.x + (fp.w * k) / 2, st.y + (fp.h * k) / 2];
      if (st.id === 'freight_dock') { b[0] = Math.min(b[0], st.x - DOCK_BAY_HALF_W * k); b[1] = st.y - (DOCK_BAY_CY + DOCK_BAY_HALF_H) * k; }
      return b;
    };
    for (let i = 0; i < s.structs.length; i++) {
      for (let j = i + 1; j < s.structs.length; j++) {
        const a = box(s.structs[i]!), b = box(s.structs[j]!);
        const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        expect(overlap, `${s.structs[i]!.id}#${i} vs ${s.structs[j]!.id}#${j}`).toBe(false);
      }
    }
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
