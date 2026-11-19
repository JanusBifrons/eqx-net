import { describe, it, expect } from 'vitest';
import {
  STRUCTURE_KINDS_LIST,
  getStructureKind,
  structureOutline,
  STRUCTURE_OUTLINE_FAMILY,
  STRUCTURE_SOCKET_OVERRIDES,
  SOCKET_OUTLINE_STYLE,
  structureSockets,
  rotateStructureSocket,
  structureSocketToWorld,
} from '../../shared-types/structureKinds.js';
import { GATE_POSTS, AIRLOCK_POSTS } from '../../shared-types/structureKinds/gatePosts.js';
import { STRUCTURE_CONNECTIONS_PER_LEVEL, STRUCTURE_LEVEL_CAP, effectiveStructureMaxConnections, structureLinksBoundBySockets } from '../leveling/structureLevel.js';
import { emitterAnchor, gateTypeOf } from './gateGeometry.js';
import { TELEPORTER_KINDS } from '../../shared-types/teleport.js';

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
/** Kinds off rule 4 (outline): bespoke overrides and teleporter pads (posts). */
const offOutline = (k: string): boolean =>
  k in STRUCTURE_SOCKET_OVERRIDES || (TELEPORTER_KINDS as readonly string[]).includes(k);

describe('structureSockets', () => {
  it('every socket-bound kind: link cap at every level fits its sockets (one cable per socket)', () => {
    const clamped: string[] = [];
    for (const kind of STRUCTURE_KINDS_LIST) {
      const sockets = structureSockets(kind.id);
      expect(sockets.length, kind.id).toBeGreaterThan(0);
      // Connectors and shield emitters (pylon, gate, airlock) take cables from
      // any side: their sockets are not a link limit.
      if (!structureLinksBoundBySockets(kind.id)) {
        expect(kind.id === 'connector' || kind.id === 'shield_pylon' || isGate(kind.id), kind.id).toBe(true);
        continue;
      }
      for (let level = 1; level <= STRUCTURE_LEVEL_CAP; level++) {
        const maxLinks = effectiveStructureMaxConnections(kind.maxConnections, level, kind.id);
        expect(maxLinks, `${kind.id} L${level}: ${sockets.length} sockets < ${maxLinks} links`).toBeLessThanOrEqual(sockets.length);
      }
      // The level-1 cap is never clamped (the base catalogue already fits).
      expect(effectiveStructureMaxConnections(kind.maxConnections, 1, kind.id), kind.id).toBe(kind.maxConnections);
      if (kind.maxConnections + (STRUCTURE_LEVEL_CAP - 1) * STRUCTURE_CONNECTIONS_PER_LEVEL > sockets.length) clamped.push(kind.id);
    }
    console.log(`[structureSockets] top-level cap clamped to sockets: ${clamped.join(', ')}`);
  });

  it('every outline socket lies on the house-look outline with a unit outward normal', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (isGate(kind.id) || offOutline(kind.id)) continue;
      const poly = structureOutline(kind.id, SOCKET_OUTLINE_STYLE);
      for (const s of structureSockets(kind.id)) {
        expect(distToOutline(s, poly), kind.id).toBeLessThan(1e-6);
        expect(Math.hypot(s.nx, s.ny), kind.id).toBeCloseTo(1, 9);
        expect(inside({ x: s.x + s.nx * 0.5, y: s.y + s.ny * 0.5 }, poly), `${kind.id} normal points in`).toBe(false);
        expect(inside({ x: s.x - s.nx * 0.5, y: s.y - s.ny * 0.5 }, poly), `${kind.id} back is outside`).toBe(true);
      }
    }
  });

  it('non-hex kinds (chamfered in the house look): no socket on a cut corner, one on each long side (pylon keeps its corners)', () => {
    for (const kind of STRUCTURE_KINDS_LIST) {
      if (STRUCTURE_OUTLINE_FAMILY[kind.id] === 'hex' || isGate(kind.id)) continue;
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
      (k) => `${k}=${structureSockets(k).length} (links ${effectiveStructureMaxConnections(getStructureKind(k).maxConnections, STRUCTURE_LEVEL_CAP, k)})`,
    );
    console.log(`[structureSockets] ${counts.join(', ')}`);
  });
});
