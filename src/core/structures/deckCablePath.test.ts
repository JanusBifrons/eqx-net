/**
 * Base platforms slice 12 — deck cables run on hex seams (owner: "connector ->
 * a corner of the middle hex -> along hex seams; never across a hex").
 */
import { describe, it, expect } from 'vitest';
import { deckSeamPathInto, flattenDeckSeamCable } from './deckCablePath.js';
import {
  CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, CABLE_NO_SOCKET, cableCrossesExisting, flattenLinkCable, makeCableBox,
} from './cableCurve.js';
import { Connection } from './Connection.js';
import type { GridNode } from './Grid.js';
import { HEX_DIRS, pixelToAxial, axialToPixel, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, PLATE_DIRS, deckHexCentreInto, plateCentreHexInto, plateCentreWorldInto } from '../hex/plates.js';
import { getStructureKind, isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';

const TOL = 1e-6;

function real(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: isConnectorKind(kind), isShieldPylon: false,
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

function hexOf(i: number, j: number, k: number): HexPoint {
  const c = plateCentreHexInto(i, j, { q: 0, r: 0 });
  const d = k < 0 ? { q: 0, r: 0 } : HEX_DIRS[k]!;
  return deckHexCentreInto(c.q + d.q, c.r + d.r, { x: 0, y: 0 });
}

/** Distance from (x, y) to the centre of the deck hex holding it. */
function fromCentre(x: number, y: number): number {
  const c = axialToPixel(pixelToAxial(x, y, DECK_HEX_SIZE), DECK_HEX_SIZE);
  return Math.hypot(x - c.x, y - c.y);
}
const isCorner = (x: number, y: number): boolean => Math.abs(fromCentre(x, y) - DECK_HEX_SIZE) < 1e-3;

const raw = new Float64Array(64);

/** The raw seam path, checked: starts at a, ends at b, interior points are
 *  hex corners, interior legs are whole hex edges. Returns the point count. */
function checkPath(ax: number, ay: number, bx: number, by: number): number {
  const n = deckSeamPathInto(ax, ay, bx, by, raw, 32);
  expect(n).toBeGreaterThanOrEqual(3);
  expect(raw[0]).toBeCloseTo(ax, 6); expect(raw[1]).toBeCloseTo(ay, 6);
  expect(raw[(n - 1) * 2]).toBeCloseTo(bx, 6); expect(raw[(n - 1) * 2 + 1]).toBeCloseTo(by, 6);
  for (let i = 1; i < n - 1; i++) expect(isCorner(raw[i * 2]!, raw[i * 2 + 1]!)).toBe(true);
  for (let i = 1; i < n - 2; i++) {
    const x0 = raw[i * 2]!, y0 = raw[i * 2 + 1]!, x1 = raw[i * 2 + 2]!, y1 = raw[i * 2 + 3]!;
    // One hex edge: corner to adjacent corner, its midpoint on the seam (inradius from a centre).
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(DECK_HEX_SIZE, 3);
    expect(fromCentre((x0 + x1) / 2, (y0 + y1) / 2)).toBeCloseTo(DECK_HEX_SIZE * Math.sqrt(3) / 2, 3);
  }
  return n;
}

describe('deck seam path (base platforms slice 12)', () => {
  it('on-plate links: connector -> a middle-hex corner -> the building', () => {
    for (let k = 0; k < 6; k++) {
      const p = hexOf(0, 0, k);
      const n = checkPath(0, 0, p.x, p.y);
      // The first corner is a corner of the middle hex.
      expect(Math.hypot(raw[2]!, raw[3]!)).toBeCloseTo(DECK_HEX_SIZE, 6);
      expect(n).toBeLessThanOrEqual(CABLE_CURVE_SEGMENTS + 1);
    }
    // A small building inside the middle hex, near a corner.
    checkPath(0, 0, 420, 300);
  });

  it('neighbour-plate links run along seams between the two plate centres', () => {
    for (const d of PLATE_DIRS) {
      const c = plateCentreWorldInto(d.i, d.j, { x: 0, y: 0 });
      const n = checkPath(0, 0, c.x, c.y);
      expect(n).toBeGreaterThan(3); // a real walk along seams
      expect(n).toBeLessThanOrEqual(CABLE_CURVE_SEGMENTS + 1);
      // Leaves via a middle-hex corner, arrives via one of the far middle hex.
      expect(Math.hypot(raw[2]!, raw[3]!)).toBeCloseTo(DECK_HEX_SIZE, 6);
      expect(Math.hypot(raw[(n - 2) * 2]! - c.x, raw[(n - 2) * 2 + 1]! - c.y)).toBeCloseTo(DECK_HEX_SIZE, 6);
    }
  });

  it('is the same cable either way round (reversed)', () => {
    const c = plateCentreWorldInto(1, -1, { x: 0, y: 0 });
    const n = deckSeamPathInto(0, 0, c.x, c.y, raw, 32);
    const fwd = Array.from(raw.subarray(0, n * 2));
    expect(deckSeamPathInto(c.x, c.y, 0, 0, raw, 32)).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(raw[i * 2]).toBeCloseTo(fwd[(n - 1 - i) * 2]!, 9);
      expect(raw[i * 2 + 1]).toBeCloseTo(fwd[(n - 1 - i) * 2 + 1]!, 9);
    }
  });

  it('refuses a path longer than the point budget', () => {
    const c = plateCentreWorldInto(4, 0, { x: 0, y: 0 });
    expect(deckSeamPathInto(0, 0, c.x, c.y, raw, 13)).toBe(0);
  });

  it('the fixed polyline keeps every corner and every point lies on the seam path', () => {
    const c = plateCentreWorldInto(0, 1, { x: 0, y: 0 });
    const n = deckSeamPathInto(0, 0, c.x, c.y, raw, 32);
    const out = new Float64Array(CABLE_CURVE_FLOATS);
    const box = makeCableBox();
    expect(flattenDeckSeamCable(0, 0, c.x, c.y, out, box, CABLE_CURVE_SEGMENTS)).toBe(true);
    expect(out[0]).toBe(0); expect(out[1]).toBe(0);
    expect(out[CABLE_CURVE_SEGMENTS * 2]).toBeCloseTo(c.x, 6);
    expect(out[CABLE_CURVE_SEGMENTS * 2 + 1]).toBeCloseTo(c.y, 6);
    const onPath = (x: number, y: number): boolean => {
      for (let i = 0; i < n - 1; i++) {
        const x0 = raw[i * 2]!, y0 = raw[i * 2 + 1]!, dx = raw[i * 2 + 2]! - x0, dy = raw[i * 2 + 3]! - y0;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
        if (Math.hypot(x0 + dx * t - x, y0 + dy * t - y) < TOL) return true;
      }
      return false;
    };
    for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) {
      expect(onPath(out[i * 2]!, out[i * 2 + 1]!)).toBe(true);
      const x = out[i * 2]!, y = out[i * 2 + 1]!;
      expect(x >= box.x0 - TOL && x <= box.x1 + TOL && y >= box.y0 - TOL && y <= box.y1 + TOL).toBe(true);
    }
    for (let i = 1; i < n - 1; i++) {
      let found = false;
      for (let k = 0; k <= CABLE_CURVE_SEGMENTS; k++) if (Math.hypot(out[k * 2]! - raw[i * 2]!, out[k * 2 + 1]! - raw[i * 2 + 1]!) < TOL) found = true;
      expect(found).toBe(true);
    }
  });
});

describe('flattenLinkCable on a deck (slice 12)', () => {
  const con = real('c', 'connector', 0, 0);
  const p = hexOf(0, 0, 2);
  const solar = real('s', 'solar', p.x, p.y);
  const out = new Float64Array(CABLE_CURVE_FLOATS);
  const box = makeCableBox();

  it('a deck link is its seam path; deck off is the old straight line', () => {
    flattenLinkCable(solar, CABLE_NO_SOCKET, con, CABLE_NO_SOCKET, out, box, true);
    let corners = 0;
    for (let i = 1; i < CABLE_CURVE_SEGMENTS; i++) if (isCorner(out[i * 2]!, out[i * 2 + 1]!)) corners++;
    expect(corners).toBeGreaterThanOrEqual(1); // via a middle-hex corner, not straight across
    const seam = Array.from(out);
    flattenLinkCable(solar, CABLE_NO_SOCKET, con, CABLE_NO_SOCKET, out, box);
    expect(Array.from(out)).not.toEqual(seam);
    for (let i = 0; i <= CABLE_CURVE_SEGMENTS; i++) {
      const t = i / CABLE_CURVE_SEGMENTS;
      expect(out[i * 2]).toBe(solar.x + (con.x - solar.x) * t);
    }
  });

  it('a non-deck link is byte-identical with the deck flag on', () => {
    const a = real('a', 'connector', 5000, 5000), b = real('b', 'solar', 5000 + 900, 5000);
    for (const [sa, sb] of [[0, 0], [CABLE_NO_SOCKET, CABLE_NO_SOCKET]] as const) {
      flattenLinkCable(a, sa, b, sb, out, box);
      const off = Array.from(out), offBox = { ...box };
      flattenLinkCable(a, sa, b, sb, out, box, true);
      expect(Array.from(out)).toEqual(off);
      expect({ ...box }).toEqual(offBox);
    }
  });

  it('a stored deck cable never refuses a new cable on a deck (crossing exemption)', () => {
    // A long straight new cable right through the stored deck link's line.
    const link = new Connection(1, 's', 'c', 1);
    const adj = new Map<string, Connection[]>([['s', [link]], ['c', [link]]]);
    const x = real('x', 'connector', -400, -400), y = real('y', 'battery', p.x * 0.5 + 300, p.y * 0.5 + 300);
    const nodes = new Map([[con.id, con], [solar.id, solar], [x.id, x], [y.id, y]]);
    const poly = new Float64Array(CABLE_CURVE_FLOATS);
    const pb = makeCableBox();
    flattenLinkCable(x, CABLE_NO_SOCKET, solar, CABLE_NO_SOCKET, poly, pb); // ends at the solar: within a body width of the stored cable
    expect(cableCrossesExisting(x, y, poly, pb, adj, nodes)).toBe(true);
    expect(cableCrossesExisting(x, y, poly, pb, adj, nodes, undefined, true)).toBe(false);
  });
});
