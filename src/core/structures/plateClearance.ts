/**
 * Base platforms slice 8 — is a plate's area clear? A NEW plate is laid only
 * on clear space (owner ruling): none of its 7 hexes may touch a rock or
 * wreck. `placementRejection`'s deck rule calls {@link plateOverlapsObstacle}
 * for both the client ghost and the server handler (#15).
 *
 * A hex vs an obstacle: separating-axis test on the hex's 3 edge normals
 * (and, for an obstacle with convex `parts`, every part edge normal). Against
 * a bare circle the 3 slabs over-refuse a sliver past each hex corner, which
 * only errs on the "not clear" side. Allocation-free (invariant 14).
 */
import { HEX_DIRS, hexCornerInto, type AxialHex, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE, deckHexCentreInto, plateCentreHexInto, PLATE_REACH } from '../hex/plates.js';
import type { GridObstacle } from './Grid.js';

type Poly = ReadonlyArray<{ readonly x: number; readonly y: number }>;

/** Pointy-top hex edge normals (0°, 60°, 120°) and its apothem. */
const N_X: readonly number[] = [1, 0.5, -0.5];
const N_Y: readonly number[] = [0, Math.sqrt(3) / 2, Math.sqrt(3) / 2];
const APOTHEM = DECK_HEX_FLAT / 2;

const CENTRE: AxialHex = { q: 0, r: 0 };
const HC: HexPoint = { x: 0, y: 0 };
const CORNER: HexPoint = { x: 0, y: 0 };

/** Do the hex at (hx, hy) and polygon `poly` (relative to (ox, oy), turned by
 *  (cos, sin)) overlap on axis (ax, ay)? Touching is clear. */
function overlapOnAxis(hx: number, hy: number, poly: Poly, ox: number, oy: number, cos: number, sin: number, ax: number, ay: number): boolean {
  let h0 = Infinity, h1 = -Infinity;
  for (let k = 0; k < 6; k++) {
    hexCornerInto(hx, hy, DECK_HEX_SIZE, k, CORNER);
    const d = CORNER.x * ax + CORNER.y * ay;
    if (d < h0) h0 = d;
    if (d > h1) h1 = d;
  }
  let p0 = Infinity, p1 = -Infinity;
  for (let k = 0; k < poly.length; k++) {
    const v = poly[k]!;
    const d = (ox + v.x * cos - v.y * sin) * ax + (oy + v.x * sin + v.y * cos) * ay;
    if (d < p0) p0 = d;
    if (d > p1) p1 = d;
  }
  return p0 < h1 && p1 > h0;
}

function hexOverlapsPolygon(hx: number, hy: number, poly: Poly, ox: number, oy: number, cos: number, sin: number): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let a = 0; a < 3; a++) if (!overlapOnAxis(hx, hy, poly, ox, oy, cos, sin, N_X[a]!, N_Y[a]!)) return false;
  for (let i = 0; i < n; i++) {
    const p = poly[i]!, q = poly[i + 1 < n ? i + 1 : 0]!;
    const lx = q.x - p.x, ly = q.y - p.y;
    const ax = -(lx * sin + ly * cos), ay = lx * cos - ly * sin;
    if (!overlapOnAxis(hx, hy, poly, ox, oy, cos, sin, ax, ay)) return false;
  }
  return true;
}

/** Does deck hex centred at (hx, hy) touch obstacle `o`? Its circle first
 *  (3 slabs), then its convex `parts` when it has them. */
export function hexOverlapsObstacle(hx: number, hy: number, o: GridObstacle): boolean {
  const dx = o.x - hx, dy = o.y - hy;
  for (let a = 0; a < 3; a++) if (Math.abs(dx * N_X[a]! + dy * N_Y[a]!) >= APOTHEM + o.radius) return false;
  const parts = o.parts;
  if (parts === undefined) return true;
  const ang = o.angle ?? 0, cos = Math.cos(ang), sin = Math.sin(ang);
  for (let p = 0; p < parts.length; p++) if (hexOverlapsPolygon(hx, hy, parts[p]!, o.x, o.y, cos, sin)) return true;
  return false;
}

/** Does any of plate (i, j)'s 7 hexes touch obstacle `o`? */
export function plateOverlapsObstacle(i: number, j: number, o: GridObstacle): boolean {
  plateCentreHexInto(i, j, CENTRE);
  deckHexCentreInto(CENTRE.q, CENTRE.r, HC);
  // Broad phase: nowhere near the plate.
  const dx = o.x - HC.x, dy = o.y - HC.y, reach = PLATE_REACH + o.radius;
  if (dx * dx + dy * dy >= reach * reach) return false;
  if (hexOverlapsObstacle(HC.x, HC.y, o)) return true;
  for (let d = 0; d < HEX_DIRS.length; d++) {
    const dir = HEX_DIRS[d]!;
    deckHexCentreInto(CENTRE.q + dir.q, CENTRE.r + dir.r, HC);
    if (hexOverlapsObstacle(HC.x, HC.y, o)) return true;
  }
  return false;
}

/** A box `{x0, y0, x1, y1}` grown to cover a whole plate centred at (x, y)
 *  (the obstacle query box for a plate-laying placement). Allocation-free. */
export function plateReachBoxAdd(x: number, y: number, box: { x0: number; y0: number; x1: number; y1: number }): void {
  if (x - PLATE_REACH < box.x0) box.x0 = x - PLATE_REACH;
  if (x + PLATE_REACH > box.x1) box.x1 = x + PLATE_REACH;
  if (y - PLATE_REACH < box.y0) box.y0 = y - PLATE_REACH;
  if (y + PLATE_REACH > box.y1) box.y1 = y + PLATE_REACH;
}
