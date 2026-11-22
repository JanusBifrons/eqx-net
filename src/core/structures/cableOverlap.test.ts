/**
 * Owner report (2026-11-21): in a fresh Sol Prime base (solar, connector,
 * shipyard) two or three cables were drawn on top of each other along the
 * same path. Cause: the "cables never cross" test skipped every stored link
 * that shares an end with the new one (a fan-out), and a connector takes any
 * number of cables on one face, so a second cable could leave the same
 * connector stud along the same stub as the first. Rule now: two cables keep
 * at least one cable body width (`CABLE_BODY_WIDTH`) apart along their whole
 * length, fan-outs included; closer is refused `'crosses-cable'` (the picker
 * first tries another free pair, e.g. another connector face).
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import {
  CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, flattenLinkCable, makeCableBox, makeCableSocketPick,
} from './cableCurve.js';
import { Connection } from './Connection.js';
import { CABLE_BODY_WIDTH } from './structureGridConstants.js';
import { getStructureKind, structureHalfExtents } from '../../shared-types/structureKinds.js';

function real(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: kind === 'connector',
    isShieldPylon: kind === 'shield_pylon' || kind === 'shield_gate' || kind === 'shield_airlock',
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

/** Brute-force closest approach of two flattened cables (test-local, so the
 *  rule is judged by an independent measure). */
function pointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}
function gap(p: Float64Array, q: Float64Array): number {
  let m = Infinity;
  for (let i = 0; i < CABLE_CURVE_SEGMENTS; i++) {
    for (let s = 0; s <= 20; s++) {
      const t = s / 20;
      const x = p[i * 2]! + (p[i * 2 + 2]! - p[i * 2]!) * t, y = p[i * 2 + 1]! + (p[i * 2 + 3]! - p[i * 2 + 1]!) * t;
      for (let j = 0; j < CABLE_CURVE_SEGMENTS; j++) m = Math.min(m, pointSeg(x, y, q[j * 2]!, q[j * 2 + 1]!, q[j * 2 + 2]!, q[j * 2 + 3]!));
    }
  }
  return m;
}

interface Laid { a: GridNode; sa: number; b: GridNode; sb: number }
const pick = makeCableSocketPick();
const box = makeCableBox();

/** Link each pair in order the way the server does (canConnect picks the
 *  sockets); returns the links formed. */
function build(nodes: GridNode[], pairs: [GridNode, GridNode][]): Laid[] {
  const map = new Map(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, Connection[]>();
  const out: Laid[] = [];
  for (const [a, b] of pairs) {
    if (!canConnect(a, b, adj, map, undefined, pick).ok) continue;
    const c = new Connection(out.length, a.id, b.id, 1, pick.a, pick.b);
    (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push(c);
    (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push(c);
    out.push({ a, sa: pick.a, b, sb: pick.b });
  }
  return out;
}
function poly(l: Laid): Float64Array {
  const p = new Float64Array(CABLE_CURVE_FLOATS);
  flattenLinkCable(l.a, l.sa, l.b, l.sb, p, box);
  return p;
}
function expectApart(links: Laid[]): void {
  for (let i = 0; i < links.length; i++) {
    for (let j = i + 1; j < links.length; j++) {
      const li = links[i]!, lj = links[j]!;
      const g = gap(poly(li), poly(lj));
      expect(g, `${li.a.id}-${li.b.id} vs ${lj.a.id}-${lj.b.id}`).toBeGreaterThanOrEqual(CABLE_BODY_WIDTH - 1e-6);
    }
  }
}

describe('cables never overlap (owner report: cables drawn on top of each other)', () => {
  it('solar, connector, shipyard plus a second connector: no two cables run on top of each other', () => {
    // The reported shape: a solar array and a shipyard joined through a
    // middle connector, with a second connector tapping the middle one.
    // Before the fix c–sol and d–c both left c's same face along one path.
    const sol = real('sol', 'solar', -500, 0);
    const yard = real('yard', 'shipyard', 700, 0);
    const c = real('c', 'connector', 0, -300);
    const d = real('d', 'connector', -300, -300);
    const links = build([sol, yard, c, d], [[c, sol], [c, yard], [d, c]]);
    expect(links.map((l) => `${l.a.id}-${l.b.id}`)).toEqual(['c-sol', 'c-yard', 'd-c']);
    expectApart(links);
  });

  it('two cables fanning out of one connector toward the same side leave by different faces', () => {
    const c = real('c', 'connector', 0, 0);
    const e1 = real('e1', 'connector', 400, 60);
    const e2 = real('e2', 'connector', 400, -60);
    const links = build([c, e1, e2], [[c, e1], [c, e2]]);
    expect(links).toHaveLength(2);
    expect(links[0]!.sa).not.toBe(links[1]!.sa);
    expectApart(links);
  });

  it('a fan-out whose only route runs on top of a sibling cable is refused crosses-cable', () => {
    // A connector with one face toward the east only takes so many cables
    // there; pile connectors east of it until one is refused, and every
    // cable that did form stays apart.
    const c = real('c', 'connector', 0, 0);
    const nodes = [c];
    const pairs: [GridNode, GridNode][] = [];
    for (let k = 0; k < 6; k++) {
      const e = real(`e${k}`, 'connector', 500, (k - 2.5) * 80);
      nodes.push(e);
      pairs.push([c, e]);
    }
    const links = build(nodes, pairs);
    expect(links.length).toBeLessThan(6);
    expectApart(links);
    const map = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map<string, Connection[]>();
    for (const l of links) {
      const conn = new Connection(0, l.a.id, l.b.id, 1, l.sa, l.sb);
      (adj.get(l.a.id) ?? adj.set(l.a.id, []).get(l.a.id)!).push(conn);
      (adj.get(l.b.id) ?? adj.set(l.b.id, []).get(l.b.id)!).push(conn);
    }
    const refused = pairs.find(([, e]) => !links.some((l) => l.b.id === e.id))!;
    const r = canConnect(refused[0], refused[1], adj, map);
    expect(r.ok).toBe(false);
  });
});
