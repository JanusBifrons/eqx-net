/**
 * Readable construction (`?buildRing=on`): the progress ring round an unbuilt
 * structure: its size (footprint, never under the on-screen minimum), its
 * fill (the hologram's smoothed fraction) and its screen-square pose.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import {
  BUILD_RING_LABEL, BUILD_RING_MIN_PX, BUILD_RING_PAD, BUILD_RING_START, BUILD_RING_STEPS, BuildRing,
  buildRingEndAngle, buildRingRadius, buildRingStep, readBuildRingFlag,
} from './buildRing.js';
import { HOLOGRAM_LABEL, holoRingOut, StructureHologram, syncStructureHologram, WIRE_ALPHA } from './structureHologram.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';

function row(buildPct: number, etaMs?: number): StructureRenderState {
  return { powered: true, netPower: 0, connTo: [], built: false, buildPct, deconstructPct: 0, ...(etaMs !== undefined ? { etaMs } : {}) };
}
function ringOf(sprite: Container): BuildRing | null {
  const holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram | null;
  return holo ? (holo.getChildByLabel(BUILD_RING_LABEL) as BuildRing | null) : null;
}

describe('build ring flag', () => {
  it('is off unless ?buildRing=on', () => {
    expect(readBuildRingFlag('')).toBe(false);
    expect(readBuildRingFlag('?room=deck')).toBe(false);
    expect(readBuildRingFlag('?buildRing=off')).toBe(false);
    expect(readBuildRingFlag('?buildRing=bogus')).toBe(false);
    expect(readBuildRingFlag('?buildRing=on')).toBe(true);
    expect(readBuildRingFlag('?room=deck&buildRing=on')).toBe(true);
  });
});

describe('build ring geometry', () => {
  it('sits round the footprint when that is big enough on screen', () => {
    // Zoom 1: a 40 u corner radius is 48 u (> 22 px) on screen: the footprint rules.
    expect(buildRingRadius(40, 1)).toBe(40 + BUILD_RING_PAD);
  });

  it('never draws under the minimum on-screen radius (build zoom)', () => {
    // Zoom 0.25: a turret's 30 u footprint would be ~9.5 px; the ring holds 22 px.
    const r = buildRingRadius(30, 0.25);
    expect(r).toBeCloseTo(BUILD_RING_MIN_PX / 0.25, 9);
    expect(r * 0.25).toBeCloseTo(BUILD_RING_MIN_PX, 9);
    // Further out it grows in world units to stay the same on screen.
    expect(buildRingRadius(30, 0.1) * 0.1).toBeCloseTo(BUILD_RING_MIN_PX, 9);
    // Bad zoom: the footprint size.
    expect(buildRingRadius(30, 0)).toBe(30 + BUILD_RING_PAD);
  });

  it('arc steps: clamped, top of the screen, clockwise, full at 1', () => {
    expect(buildRingStep(-1)).toBe(0);
    expect(buildRingStep(0)).toBe(0);
    expect(buildRingStep(0.5)).toBe(BUILD_RING_STEPS / 2);
    expect(buildRingStep(2)).toBe(BUILD_RING_STEPS);
    expect(buildRingEndAngle(0)).toBe(BUILD_RING_START);
    expect(BUILD_RING_START).toBeCloseTo(-Math.PI / 2, 12);
    expect(buildRingEndAngle(BUILD_RING_STEPS / 4)).toBeCloseTo(0, 12); // a quarter: the right (Pixi y-down)
    expect(buildRingEndAngle(BUILD_RING_STEPS)).toBeCloseTo(BUILD_RING_START + 2 * Math.PI, 12);
  });

  it('shares one arc context per step (no redraw per frame)', () => {
    const host = new Container();
    const a = new BuildRing(), b = new BuildRing();
    a.update(0.5, 30, 1, host);
    b.update(0.5, 30, 1, host);
    expect(a.step).toBe(50);
    expect(a.arc.context).toBe(b.arc.context);
    expect(a.track.context).toBe(b.track.context);
    const ctx = a.arc.context;
    a.update(0.501, 30, 1, host); // same step: context untouched
    expect(a.arc.context).toBe(ctx);
  });

  it('stays square to the screen under the host turn, mirror and scale', () => {
    const host = new Container();
    host.rotation = 1.2;
    host.scale.set(-2, 2); // mirrored, double size
    const ring = new BuildRing();
    ring.update(0.3, 30, 0.25, host);
    // Local radius = world radius / host scale.
    expect(ring.localR).toBeCloseTo(BUILD_RING_MIN_PX / 0.25 / 2, 9);
    // R(rot)·S(m) then R(-rot·m)·S(m): identity orientation.
    expect(ring.rotation).toBeCloseTo(1.2, 12);
    expect(ring.scale.x).toBeLessThan(0);
    expect(Math.abs(ring.scale.x)).toBeCloseTo(ring.scale.y, 12);
  });
});

describe('ring on the hologram (flag on)', () => {
  it('flag off: today\'s blueprint, no ring, label unmoved', () => {
    const sprite = new Container();
    syncStructureHologram(sprite, 'turret', 20, undefined, row(0.5), 1000);
    expect(ringOf(sprite)).toBeNull();
    expect((sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram).alpha).toBe(1);
    expect(holoRingOut.labelY).toBe(0);
  });

  it('flag on: wireframe hologram + ring filled to the hologram\'s smoothed fraction', () => {
    const sprite = new Container();
    const st = row(0.5, 1000);
    syncStructureHologram(sprite, 'turret', 20, undefined, st, 1000, 0.1);
    const holo = sprite.getChildByLabel(HOLOGRAM_LABEL) as StructureHologram;
    expect(holo.alpha).toBe(WIRE_ALPHA);
    const ring = ringOf(sprite)!;
    expect(ring).toBeInstanceOf(BuildRing);
    expect(ring.step).toBe(50);
    // Half an ETA later the print line ramps to 0.75; the ring follows it.
    syncStructureHologram(sprite, 'turret', 20, undefined, st, 1500, 0.1);
    expect(holo.shownPct).toBeCloseTo(0.75, 6);
    expect(ring.step).toBe(75);
    expect(ringOf(sprite)).toBe(ring); // made once
    // Pulled well back the ring holds its minimum on-screen size; the ETA label sits above it.
    expect(ring.localR * 0.1).toBeCloseTo(BUILD_RING_MIN_PX, 6);
    expect(ring.localR).toBeGreaterThan(holo.footR); // bigger than the footprint here
    expect(holoRingOut.labelY).toBeLessThan(-ring.localR);
    // Built: hologram and ring dropped together.
    syncStructureHologram(sprite, 'turret', 20, undefined, { ...st, built: true, buildPct: 1 }, 2000, 0.1);
    expect(sprite.getChildByLabel(HOLOGRAM_LABEL)).toBeNull();
    expect(holoRingOut.labelY).toBe(0);
  });
});
