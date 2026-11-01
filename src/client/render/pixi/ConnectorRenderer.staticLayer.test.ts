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
    r.update(m, 0.25, 32); // 25 %
    expect(r.staticRebuilds).toBe(2);
  });

  it('a gate opening changes the signature (its guide replaces the rails)', () => {
    const m = citadel(100);
    const gateId = [...m.swarm!.entries()].find(([, e]) => e.shipKind === 'shield_gate')![0];
    const before = staticSignature(m.structures!, m.swarm!, null);
    m.structures!.get(gateId)!.gateOpen = 1;
    expect(staticSignature(m.structures!, m.swarm!, null)).not.toBe(before);
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
