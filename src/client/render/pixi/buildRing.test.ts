/**
 * Readable construction (`?buildRing`, default on): the progress HEXAGON round an
 * unbuilt structure: its perimeter fill (clockwise from the top vertex), its
 * size (clears a gun's danger ring, never under the on-screen minimum) and
 * its screen-upright pose.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import {
  BUILD_HEX_DANGER_GAP, BUILD_RING_LABEL, BUILD_RING_MIN_PX, BUILD_RING_PAD, BUILD_RING_STEPS, BuildRing,
  HEX_APOTHEM_RATIO, buildRingApothem, buildRingClearRadius, buildRingStep, hexPerimeterPath, readBuildRingFlag,
} from './buildRing.js';
import { gunDangerOuterRadius } from './structureDeckZones.js';
import { HOLOGRAM_LABEL, holoRingOut, StructureHologram, syncStructureHologram, WIRE_ALPHA } from './structureHologram.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(buildPct: number, etaMs?: number): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built: false, buildPct, deconstructPct: 0, ...(etaMs !== undefined ? { etaMs } : {}) };
}
function ringOf(sprite: Container): BuildRing | null {
  const holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram | null;
  return holo ? (holo.getChildByLabel(BUILD_RING_LABEL) as BuildRing | null) : null;
}

/** Records a path: 'M' / 'L' + rounded point. */
class PathRec {
  readonly ops: string[] = [];
  readonly pts: [number, number][] = [];
  moveTo(x: number, y: number): this { this.ops.push('M'); this.pts.push([x, y]); return this; }
  lineTo(x: number, y: number): this { this.ops.push('L'); this.pts.push([x, y]); return this; }
}
const S3 = Math.sqrt(3) / 2;
function expectPt(p: [number, number] | undefined, x: number, y: number): void {
  expect(p![0]).toBeCloseTo(x, 9);
  expect(p![1]).toBeCloseTo(y, 9);
}

describe('build ring flag', () => {
  it('is on unless ?buildRing=off', () => {
    expect(readBuildRingFlag('')).toBe(true);
    expect(readBuildRingFlag('?room=deck')).toBe(true);
    expect(readBuildRingFlag('?buildRing=off')).toBe(false);
    expect(readBuildRingFlag('?room=deck&buildRing=off')).toBe(false);
    expect(readBuildRingFlag('?buildRing=bogus')).toBe(true);
    expect(readBuildRingFlag('?buildRing=on')).toBe(true);
    expect(readBuildRingFlag('?room=deck&buildRing=on')).toBe(true);
  });
});

describe('hex perimeter fill (pointy top, clockwise on screen, Pixi y-down)', () => {
  const R = 100;
  it('0 %: nothing drawn', () => {
    expect(hexPerimeterPath(new PathRec(), R, 0).ops).toEqual([]);
  });

  it('25 %: top vertex → upper-right vertex → middle of the right edge', () => {
    const p = hexPerimeterPath(new PathRec(), R, 0.25);
    expect(p.ops).toEqual(['M', 'L', 'L']);
    expectPt(p.pts[0], 0, -R);
    expectPt(p.pts[1], R * S3, -R / 2);
    expectPt(p.pts[2], R * S3, 0); // 3 o'clock: a quarter of the perimeter
  });

  it('50 %: down the right side to the bottom vertex', () => {
    const p = hexPerimeterPath(new PathRec(), R, 0.5);
    expect(p.ops).toEqual(['M', 'L', 'L', 'L']);
    expectPt(p.pts[2], R * S3, R / 2);
    expectPt(p.pts[3], 0, R);
  });

  it('100 %: every vertex, closed back on the top', () => {
    const p = hexPerimeterPath(new PathRec(), R, 1);
    expect(p.ops).toEqual(['M', 'L', 'L', 'L', 'L', 'L', 'L']);
    expectPt(p.pts[4], -R * S3, R / 2);
    expectPt(p.pts[5], -R * S3, -R / 2);
    expectPt(p.pts[6], 0, -R);
    // Clamped past 1.
    expect(hexPerimeterPath(new PathRec(), R, 2).ops.length).toBe(7);
  });

  it('steps are clamped and full at 1', () => {
    expect(buildRingStep(-1)).toBe(0);
    expect(buildRingStep(0.5)).toBe(BUILD_RING_STEPS / 2);
    expect(buildRingStep(2)).toBe(BUILD_RING_STEPS);
  });
});

describe('hexagon size', () => {
  it('clears a gun\'s red danger ring (inscribed radius just outside it)', () => {
    const danger = gunDangerOuterRadius('turret')!;
    expect(danger).toBeGreaterThan(0);
    const clear = buildRingClearRadius('turret', 99);
    expect(clear).toBe(danger + BUILD_HEX_DANGER_GAP);
    // Close in (min px not binding): the inscribed radius IS the clear radius,
    // so every point of the hexagon lies outside the danger ring.
    const ring = new BuildRing(clear);
    ring.update(0.5, 2, new Container());
    expect(ring.localR * HEX_APOTHEM_RATIO).toBeCloseTo(clear, 9);
    expect(ring.localR * HEX_APOTHEM_RATIO).toBeGreaterThan(danger);
  });

  it('a kind with no danger ring: its footprint plus a margin', () => {
    expect(gunDangerOuterRadius('solar')).toBeNull();
    expect(buildRingClearRadius('solar', 50)).toBe(50 + BUILD_RING_PAD);
  });

  it('never draws under the minimum on-screen inscribed radius (build zoom)', () => {
    expect(BUILD_RING_MIN_PX).toBe(36);
    // Zoom 1: the clear radius rules.
    expect(buildRingApothem(150, 1)).toBe(150);
    // Zoom 0.25: 36 px on screen = 144 u, more than a 120 u clear radius.
    expect(buildRingApothem(120, 0.25) * 0.25).toBeCloseTo(BUILD_RING_MIN_PX, 9);
    expect(buildRingApothem(120, 0.1) * 0.1).toBeCloseTo(BUILD_RING_MIN_PX, 9);
    expect(buildRingApothem(120, 0)).toBe(120);
  });

  it('shares one fill context per step (no redraw per frame)', () => {
    const host = new Container();
    const a = new BuildRing(100), b = new BuildRing(60);
    a.update(0.5, 1, host);
    b.update(0.5, 1, host);
    expect(a.step).toBe(50);
    expect(a.arc.context).toBe(b.arc.context);
    expect(a.track.context).toBe(b.track.context);
    const ctx = a.arc.context;
    a.update(0.501, 1, host); // same step: context untouched
    expect(a.arc.context).toBe(ctx);
  });

  it('stays upright on screen under the host turn, mirror and scale', () => {
    const host = new Container();
    host.rotation = 1.2;
    host.scale.set(-2, 2); // mirrored, double size
    const ring = new BuildRing(100);
    ring.update(0.3, 0.25, host);
    // Local circumradius = world apothem / cos 30° / host scale.
    expect(ring.localR).toBeCloseTo(BUILD_RING_MIN_PX / 0.25 / HEX_APOTHEM_RATIO / 2, 9);
    // R(rot)·S(m) then R(-rot·m)·S(m): identity orientation.
    expect(ring.rotation).toBeCloseTo(1.2, 12);
    expect(ring.scale.x).toBeLessThan(0);
    expect(Math.abs(ring.scale.x)).toBeCloseTo(ring.scale.y, 12);
  });
});

describe('hexagon on the hologram (flag on)', () => {
  it('flag off: today\'s blueprint, no hexagon, label unmoved', () => {
    const sprite = new Container();
    syncStructureHologram(sprite, 'turret', 20, undefined, row(0.5), 1000);
    expect(ringOf(sprite)).toBeNull();
    expect((sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram).alpha).toBe(1);
    expect(holoRingOut.labelY).toBe(0);
  });

  it('flag on: wireframe hologram + hexagon filled to the hologram\'s smoothed fraction', () => {
    const sprite = new Container();
    const st = row(0.5, 1000);
    syncStructureHologram(sprite, 'turret', 20, undefined, st, 1000, 0.25);
    const holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram;
    expect(holo.alpha).toBe(WIRE_ALPHA);
    const ring = ringOf(sprite)!;
    expect(ring).toBeInstanceOf(BuildRing);
    expect(ring.clearR).toBe(gunDangerOuterRadius('turret')! + BUILD_HEX_DANGER_GAP);
    expect(ring.step).toBe(50);
    // Half an ETA later the print line ramps to 0.75; the hexagon follows it.
    syncStructureHologram(sprite, 'turret', 20, undefined, st, 1500, 0.25);
    expect(holo.shownPct).toBeCloseTo(0.75, 6);
    expect(ring.step).toBe(75);
    expect(ringOf(sprite)).toBe(ring); // made once
    // Clear of the danger ring at build zoom; the ETA label sits above the top vertex.
    expect(ring.localR * HEX_APOTHEM_RATIO).toBeGreaterThanOrEqual(ring.clearR);
    expect(holoRingOut.labelY).toBeLessThan(-ring.localR);
    // Built: hologram and hexagon dropped together.
    syncStructureHologram(sprite, 'turret', 20, undefined, { ...st, built: true, buildPct: 1 }, 2000, 0.25);
    expect(sprite.getChildByLabel(HOLOGRAM_LABEL)).toBeNull();
    expect(holoRingOut.labelY).toBe(0);
  });
});
