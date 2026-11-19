import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_KINDS_LIST,
  getStructureKind,
  structureOutline,
  STRUCTURE_OUTLINE_FAMILY,
  structureSockets,
  rotateStructureSocket,
  structureSocketToWorld,
} from '../../shared-types/structureKinds.js';
import { GATE_POSTS, AIRLOCK_POSTS } from '../../shared-types/structureKinds/gatePosts.js';
import { STRUCTURE_LEVEL_CAP, effectiveStructureMaxConnections } from '../leveling/structureLevel.js';
import { emitterAnchor, gateTypeOf } from './gateGeometry.js';

type P = { x: number; y: number };

function distToSegment(p: P, a: P, b: P): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t));
}

function distToOutline(p: P, poly: readonly P[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return best;
}

function inside(p: P, poly: readonly P[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

const isGate = (k: string): boolean => gateTypeOf(k) !== null;

describe('structureSockets', () => {
  it('every kind: link cap at max level fits its sockets (connectors, gates, chamfer kinds and 0-link kinds exempt)', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      const sockets = structureSockets(kind.id);
      expect(sockets.length, kind.id).toBeGreaterThan(0);
      const maxLinks = effectiveStructureMaxConnections(kind.maxConnections, STRUCTURE_LEVEL_CAP);
      // Connectors take cables from any side (faces are not a limit); gate
      // posts are fence anchors shared by many links; kinds with 0 links
      // take none. A chamfer kind has no corner sockets (owner: "drop corner
      // studs"), so a small one has 4 for 5 links: cables share a socket
      // (sockets are not exclusive), see the corner case below.
      if (kind.id === 'connector' || isGate(kind.id) || kind.maxConnections === 0) continue;
      if (STRUCTURE_OUTLINE_FAMILY[kind.id] === 'chamfer' && kind.id !== 'shield_pylon') continue;
      expect(sockets.length, `${kind.id}: ${sockets.length} sockets < ${maxLinks} links`).toBeGreaterThanOrEqual(maxLinks);
    }
  });

  it('every outline socket lies on the outline with a unit outward normal', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (isGate(kind.id)) continue;
      const poly = structureOutline(kind.id);
      for (const s of structureSockets(kind.id)) {
        expect(distToOutline(s, poly), kind.id).toBeLessThan(1e-6);
        expect(Math.hypot(s.nx, s.ny), kind.id).toBeCloseTo(1, 9);
        expect(inside({ x: s.x + s.nx * 0.5, y: s.y + s.ny * 0.5 }, poly), `${kind.id} normal points in`).toBe(false);
        expect(inside({ x: s.x - s.nx * 0.5, y: s.y - s.ny * 0.5 }, poly), `${kind.id} back is outside`).toBe(true);
      }
    }
  });

  it('chamfer kinds: no socket on a cut corner, at least one on each long side (pylon keeps its corners)', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (STRUCTURE_OUTLINE_FAMILY[kind.id] !== 'chamfer' || isGate(kind.id)) continue;
      const sockets = structureSockets(kind.id);
      const diagonal = sockets.filter((s) => Math.abs(s.nx) > 1e-9 && Math.abs(s.ny) > 1e-9).length;
      if (kind.id === 'shield_pylon') {
        expect(diagonal, 'pylon corner sockets').toBe(4);
        continue;
      }
      expect(diagonal, `${kind.id} corner sockets`).toBe(0);
      for (const [nx, ny] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
        const side = sockets.filter((s) => Math.abs(s.nx - nx) < 1e-9 && Math.abs(s.ny - ny) < 1e-9).length;
        expect(side, `${kind.id} side ${nx},${ny}`).toBeGreaterThan(0);
      }
    }
  });

  it('connector: six faces, one per hex edge', () => {
    expect(structureSockets('connector')).toHaveLength(6);
  });

  it('gates and airlocks use their emitter posts, the points emitterAnchor picks', () => {
    const gate = structureSockets('shield_gate');
    const lock = structureSockets('shield_airlock');
    expect(gate.map((s) => [s.x, s.y])).toEqual(GATE_POSTS.map(([x, y]) => [x, y]));
    expect(lock.map((s) => [s.x, s.y])).toEqual(AIRLOCK_POSTS.map(([x, y]) => [x, y]));
    const out = { x: 0, y: 0 };
    for (const s of lock) {
      emitterAnchor('shield_airlock', 0, 0, 0, s.x * 10, s.y * 10, out);
      expect(out.x).toBeCloseTo(s.x, 9);
      expect(out.y).toBeCloseTo(s.y, 9);
      expect(s.nx * s.x + s.ny * s.y).toBeGreaterThan(0);
    }
  });

  it('is cached: same array every call, unknown kind falls back to the capital', () => {
    expect(structureSockets('solar')).toBe(structureSockets('solar'));
    expect(structureSockets('no-such-kind')).toBe(structureSockets('capital'));
    expect(Object.isFrozen(structureSockets('solar'))).toBe(true);
  });

  it('rotate / to-world use the CCW localToWorld convention', () => {
    const s = { x: 10, y: 0, nx: 1, ny: 0 };
    const out = { x: 0, y: 0, nx: 0, ny: 0 };
    rotateStructureSocket(s, Math.PI / 2, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(10, 9);
    expect(out.nx).toBeCloseTo(0, 9);
    expect(out.ny).toBeCloseTo(1, 9);
    structureSocketToWorld(s, 100, 50, Math.PI, out);
    expect(out.x).toBeCloseTo(90, 9);
    expect(out.y).toBeCloseTo(50, 9);
    expect(out.nx).toBeCloseTo(-1, 9);
  });

  it('prints socket counts for key kinds', () => {
    const counts = ['capital', 'connector', 'solar', 'battery', 'battery_bank', 'reactor'].map(
      (k) => `${k}=${structureSockets(k).length} (links ${effectiveStructureMaxConnections(getStructureKind(k).maxConnections, STRUCTURE_LEVEL_CAP)})`,
    );
    console.log(`[structureSockets] ${counts.join(', ')}`);
  });
});
