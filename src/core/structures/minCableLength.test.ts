/**
 * Minimum cable length (owner rule "keep buildings apart", 2026-11-21): a
 * cable shows at least one clear section between the two footprints it
 * joins. A link whose footprint boxes are under `MIN_CABLE_LENGTH` apart,
 * EDGE to edge (the footprint box, as every gameplay rule), is refused
 * 'too-short'. The minimum is the cable art's own numbers: one station pitch
 * of bundle plus the two end collars' insets (half a body width each). Fence
 * links (post to post, `CABLE_NO_SOCKET`) are exempt.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, edgeDistance, type GridNode } from './Grid.js';
import { CABLE_NO_SOCKET, makeCableSocketPick } from './cableCurve.js';
import { CABLE_BODY_WIDTH, CABLE_STATION_PITCH, MIN_CABLE_LENGTH } from './structureGridConstants.js';
import {
  getStructureKind,
  structureHalfExtents,
  structureSockets,
  structureSocketToWorld,
} from '../../shared-types/structureKinds.js';

function real(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: kind === 'connector',
    isShieldPylon: kind === 'shield_pylon' || kind === 'shield_gate' || kind === 'shield_airlock',
    maxConnections: 10, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}
const map = (...ns: GridNode[]): Map<string, GridNode> => new Map(ns.map((n) => [n.id, n]));
const NONE = new Map();
const pick = makeCableSocketPick();
const S = { x: 0, y: 0, nx: 0, ny: 0 };
function studGap(a: GridNode, ia: number, b: GridNode, ib: number): number {
  const sa = structureSocketToWorld(structureSockets(a.kind)[ia]!, a.x, a.y, a.rot, S);
  const ax = sa.x, ay = sa.y;
  const sb = structureSocketToWorld(structureSockets(b.kind)[ib]!, b.x, b.y, b.rot, S);
  return Math.hypot(sb.x - ax, sb.y - ay);
}
/** A connector placed `gap` units off `n`'s east edge, centred on it. */
function eastOf(n: GridNode, gap: number): GridNode {
  const c = getStructureKind('connector').footprint;
  return real('c', 'connector', n.x + n.halfW! + gap + c.w / 2, n.y);
}

describe('minimum cable length', () => {
  it('is one station pitch of bundle between the two end collars, from the cable art', () => {
    expect(CABLE_STATION_PITCH).toBeGreaterThan(0);
    expect(MIN_CABLE_LENGTH).toBe(CABLE_BODY_WIDTH + CABLE_STATION_PITCH);
  });

  it('a connector hugging a battery is refused too-short, with the refused pair written', () => {
    const bat = real('b', 'battery', 0, 0);
    const near = eastOf(bat, 10);
    pick.a = pick.b = -2;
    expect(canConnect(bat, near, NONE, map(bat, near), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
    expect(pick.a).not.toBe(CABLE_NO_SOCKET);
    expect(pick.b).not.toBe(CABLE_NO_SOCKET);
    // Further out the link forms, at least the minimum long.
    const far = eastOf(bat, MIN_CABLE_LENGTH);
    expect(canConnect(bat, far, NONE, map(bat, far), undefined, pick)).toEqual({ ok: true });
    expect(studGap(bat, pick.a, far, pick.b)).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
  });

  it('measures footprint edge to edge, not stud to stud: a far stud pair does not rescue a close box', () => {
    // A connector 10 u off a solar's east end: some solar stud is well over
    // the minimum from it, but the boxes nearly touch, so no cable shows.
    const solar = real('s', 'solar', 0, 0);
    const con = eastOf(solar, 10);
    expect(edgeDistance(solar, con)).toBeLessThan(MIN_CABLE_LENGTH);
    expect(canConnect(solar, con, NONE, map(solar, con), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
    // The same for two connectors side by side and a connector off a capital.
    const a = real('a', 'connector', 0, 0);
    const b = eastOf(a, 10);
    expect(canConnect(a, b, NONE, map(a, b), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
    const cap = real('k', 'capital', 0, 0);
    const c = eastOf(cap, 30);
    expect(canConnect(cap, c, NONE, map(cap, c), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
  });

  it('diagonal neighbours: the box gap counts, wherever the studs are', () => {
    const bat = real('b', 'battery', 0, 0);
    const k = getStructureKind('connector').footprint;
    // Off the battery's north-east corner, 30 u out on each axis: edge gap
    // about 42 u, under the minimum.
    const c = real('c', 'connector', bat.halfW! + 30 + k.w / 2, bat.halfH! + 30 + k.h / 2);
    expect(edgeDistance(bat, c)).toBeLessThan(MIN_CABLE_LENGTH);
    expect(canConnect(bat, c, NONE, map(bat, c), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
  });

  it('at exactly the minimum gap the link forms, and every formed link is at least that long', () => {
    const solar = real('s', 'solar', 0, 0);
    for (let gap = 2; gap < 200; gap += 6) {
      const c2 = eastOf(solar, gap);
      pick.a = pick.b = -2;
      const r = canConnect(solar, c2, NONE, map(solar, c2), undefined, pick);
      if (gap < MIN_CABLE_LENGTH) expect(r, `gap ${gap}`).toEqual({ ok: false, reason: 'too-short' });
      else if (r.ok) expect(studGap(solar, pick.a, c2, pick.b), `gap ${gap}`).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
    }
    const at = eastOf(solar, MIN_CABLE_LENGTH);
    expect(canConnect(solar, at, NONE, map(solar, at), undefined, pick)).toEqual({ ok: true });
  });

  it('fence links (emitter to emitter) are exempt', () => {
    const p = real('p', 'shield_pylon', 0, 0);
    const w = getStructureKind('shield_pylon').footprint.w;
    const q = real('q', 'shield_pylon', w + 4, 0);
    pick.a = pick.b = -2;
    expect(canConnect(p, q, NONE, map(p, q), undefined, pick)).toEqual({ ok: true });
    expect(pick.a).toBe(CABLE_NO_SOCKET);
    expect(pick.b).toBe(CABLE_NO_SOCKET);
  });
});
