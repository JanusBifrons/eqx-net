/**
 * Minimum cable length (owner rule "keep buildings apart"): a link whose
 * stud-to-stud distance is under `MIN_CABLE_LENGTH` is refused 'too-short'.
 * The picker prefers a longer valid pair over refusing; fence links (post to
 * post, `CABLE_NO_SOCKET`) are exempt.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { CABLE_NO_SOCKET, makeCableSocketPick } from './cableCurve.js';
import { MIN_CABLE_LENGTH } from './structureGridConstants.js';
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
  it('is a short visible run: two collars and one lashing (> 0)', () => {
    expect(MIN_CABLE_LENGTH).toBe(56);
  });

  it('a connector hugging a battery is refused too-short, with the refused pair written', () => {
    const bat = real('b', 'battery', 0, 0);
    const near = eastOf(bat, 10);
    pick.a = pick.b = -2;
    expect(canConnect(bat, near, NONE, map(bat, near), undefined, pick)).toEqual({ ok: false, reason: 'too-short' });
    expect(pick.a).not.toBe(CABLE_NO_SOCKET);
    expect(pick.b).not.toBe(CABLE_NO_SOCKET);
    expect(studGap(bat, pick.a, near, pick.b)).toBeLessThan(MIN_CABLE_LENGTH);
    // Further out the link forms, at least the minimum long.
    const far = eastOf(bat, MIN_CABLE_LENGTH);
    expect(canConnect(bat, far, NONE, map(bat, far), undefined, pick)).toEqual({ ok: true });
    expect(studGap(bat, pick.a, far, pick.b)).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
  });

  it('two connectors side by side link on a longer pair (their side studs), never the short front one', () => {
    const a = real('a', 'connector', 0, 0);
    const b = eastOf(a, 10);
    pick.a = pick.b = -2;
    expect(canConnect(a, b, NONE, map(a, b), undefined, pick)).toEqual({ ok: true });
    expect(studGap(a, pick.a, b, pick.b)).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
  });

  it('the picker takes a longer valid pair when the nearest is too short', () => {
    // A connector hugging the solar's east stud: that pair is too short, but
    // another solar stud facing the connector is far enough.
    const solar = real('s', 'solar', 0, 0);
    const con = eastOf(solar, 10);
    pick.a = pick.b = -2;
    const v = canConnect(solar, con, NONE, map(solar, con), undefined, pick);
    if (v.ok) {
      expect(studGap(solar, pick.a, con, pick.b)).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
    } else {
      // No facing alternative: refused too-short, never a silent short link.
      expect(v).toEqual({ ok: false, reason: 'too-short' });
    }
    // Every picked link, at any gap, is at least the minimum long.
    for (let gap = 2; gap < 200; gap += 6) {
      const c2 = eastOf(solar, gap);
      pick.a = pick.b = -2;
      const r = canConnect(solar, c2, NONE, map(solar, c2), undefined, pick);
      if (r.ok) expect(studGap(solar, pick.a, c2, pick.b), `gap ${gap}`).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
      else expect(r.reason, `gap ${gap}`).toBe('too-short');
    }
  });

  it('prefers a longer pair over refusing (connector beside a long building)', () => {
    // A connector just off a capital's side: some capital stud is far enough
    // and faces it, so the link forms instead of being refused.
    const cap = real('k', 'capital', 0, 0);
    let formedLonger = 0;
    for (let gap = 2; gap < 60; gap += 4) {
      const c = eastOf(cap, gap);
      pick.a = pick.b = -2;
      const r = canConnect(cap, c, NONE, map(cap, c), undefined, pick);
      if (r.ok) {
        expect(studGap(cap, pick.a, c, pick.b)).toBeGreaterThanOrEqual(MIN_CABLE_LENGTH);
        formedLonger++;
      }
    }
    expect(formedLonger).toBeGreaterThan(0);
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
