/**
 * A3 (plan soft-leaping-truffle v2) — the connector web's STATIC layer (idle
 * edges, turret range rings, wall rails, open-gate guides) is rebuilt only when
 * something it draws changes, not every frame. Before the split the renderer
 * cleared and redrew every edge of a citadel each frame (0.70 ms of command
 * building at 456 structures on a desktop, plus Pixi re-tessellating every
 * line). The re-tessellation cost happens at GPU render time, so the lock here
 * is the rebuild count.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorRenderer, staticSignature } from './ConnectorRenderer.js';
import { buildStructureLattice } from '../../../core/structures/structureLattice.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { RenderMirror, StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';

function citadel(n = 400): RenderMirror {
  const lat = buildStructureLattice({ n, seed: 7, fence: true });
  const swarm = new Map<number, SwarmRenderState>();
  const structures = new Map<number, StructureRenderState>();
  lat.placements.forEach((p, i) => {
    swarm.set(i + 1, {
      x: p.x, y: p.y, vx: 0, vy: 0, angle: ((p.rot ?? 0) * Math.PI) / 180, angvel: 0,
      prevX: p.x, prevY: p.y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0, poseRing: [], ringHead: 0,
      radius: getStructureKind(p.kind).radius, kind: 2, shipKind: p.kind, sleeping: true, lastUpdateTick: 0,
    } as SwarmRenderState);
    structures.set(i + 1, { powered: true, netPower: 50, connTo: [], built: true, buildPct: 1, deconstructPct: 0, wallActive: true } as StructureRenderState);
  });
  for (const [a, b] of lat.edges) {
    structures.get(a + 1)!.connTo.push(b + 1);
    structures.get(b + 1)!.connTo.push(a + 1);
  }
  return { swarm, structures } as unknown as RenderMirror;
}

describe('ConnectorRenderer static layer (A3)', () => {
  it('builds once, then stays put across frames while nothing changes', () => {
    const m = citadel();
    const r = new ConnectorRenderer();
    for (let i = 0; i < 120; i++) r.update(m, 0.2, i * 16);
    expect(r.staticRebuilds).toBe(1);
    // Turret range-ring readouts survive frames that don't rebuild.
    expect(r.builtTurretRangeCount).toBeGreaterThan(0);
  });

  it('rebuilds when the topology or a structure state changes', () => {
    const m = citadel(100);
    const r = new ConnectorRenderer();
    r.update(m, 0.2, 0);
    const [firstId, first] = [...m.structures!.entries()][3]!;
    first.built = false;
    r.update(m, 0.2, 16);
    expect(r.staticRebuilds).toBe(2);
    first.built = true;
    m.structures!.get(firstId)!.connTo.pop();
    r.update(m, 0.2, 32);
    expect(r.staticRebuilds).toBe(3);
  });

  it('rebuilds on a real zoom change, not on sub-tolerance jitter', () => {
    const m = citadel(100);
    const r = new ConnectorRenderer();
    r.update(m, 0.2, 0);
    r.update(m, 0.201, 16); // 0.5 %
    expect(r.staticRebuilds).toBe(1);
    r.update(m, 0.26, 32); // past the next half-octave key (0.25) and its dead band
    expect(r.staticRebuilds).toBe(2);
  });

  // Owner report (phone, Sol Prime): a pinch zoom re-tessellated every cable
  // in the base every frame. The static layer is drawn at a half-octave zoom
  // KEY, so a sweep rebuilds once per key crossed, not once per frame.
  it('a zoom sweep 0.1 -> 2 -> 0.1 rebuilds once per half-octave key, not per frame', () => {
    const m = citadel(100);
    const r = new ConnectorRenderer();
    for (let i = 0; i <= 60; i++) r.update(m, 0.1 * Math.pow(20, i <= 30 ? i / 30 : (60 - i) / 30), i * 16);
    // 1 first build + 7 keys up (2^-3.5 .. 2^0, clamped at 1) + 7 back down.
    expect(r.staticRebuilds).toBeLessThanOrEqual(15);
  });

  it('zoomed in past the clamp (scale >= 1, nothing static depends on zoom) never rebuilds', () => {
    const m = citadel(100);
    const r = new ConnectorRenderer();
    for (let i = 0; i <= 60; i++) r.update(m, Math.pow(3, i <= 30 ? i / 30 : (60 - i) / 30), i * 16);
    expect(r.staticRebuilds).toBe(1);
  });

  it('jitter across a key boundary does not thrash, and the floors hold', () => {
    const m = citadel(100);
    const r = new ConnectorRenderer();
    for (let i = 0; i < 60; i++) r.update(m, i % 2 ? 0.505 : 0.495, i * 16);
    expect(r.staticRebuilds).toBe(1);
    // Drawn at the key scale at or below the live one: the 1 px ring floor
    // holds, at most one step (sqrt 2, plus the 3 % dead band) wider.
    r.update(m, 0.3, 2000);
    const px = r.lastBuiltTurretRangeWidth * 0.3;
    expect(px).toBeGreaterThanOrEqual(1);
    expect(px).toBeLessThanOrEqual(Math.SQRT2 * 1.03);
  });

  it('a gate door moving leaves the signature alone (no gate span is drawn)', () => {
    const m = citadel(100);
    const gateId = [...m.swarm!.entries()].find(([, e]) => e.shipKind === 'shield_gate')![0];
    const before = staticSignature(m.structures!, m.swarm!, null);
    m.structures!.get(gateId)!.doorA = { p0: 0, t0: 0, dir: 1, level: 15 };
    expect(staticSignature(m.structures!, m.swarm!, null)).toBe(before);
  });

  it('per-frame cost at citadel scale (printed, not asserted)', () => {
    const m = citadel();
    const r = new ConnectorRenderer();
    for (let i = 0; i < 30; i++) r.update(m, 0.2, i * 16);
    const t: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      r.update(m, 0.2, 1000 + i * 16);
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`connector web, ${m.structures!.size} structures: median ${t[100]!.toFixed(3)} ms, p95 ${t[190]!.toFixed(3)} ms`);
    expect(r.staticRebuilds).toBe(1);
  });
});
