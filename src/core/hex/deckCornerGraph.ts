/**
 * Edge placement slice 2 (fence run): the deck's hex CORNERS as a
 * {@link SearchGraph}, so the one graph searcher (`nav/search.ts`
 * `GraphSearch`) finds the shortest run of hex edges between two corners.
 * No search of its own: this file only adapts the deck lattice.
 *
 * Nodes are the corners of every hex on the given plates (`hexCornerInto`,
 * the same points `nearestDeckCornerInto` snaps to). Two corners are joined
 * when they are the two ends of one seam (`isDeckSeam`) and that edge has
 * deck on at least one side: every edge of a plated hex, inner and outer.
 * Every edge costs 1, so the path is the fewest hex edges.
 *
 * Built on demand (a fence-run click), never per frame; the arrays are kept
 * and reused across builds. Path reads allocate nothing.
 */
import { GraphSearch, type SearchGoal, type SearchGraph } from '../nav/search.js';
import { HEX_DIRS, hexCornerInto, type AxialHex, type HexPoint } from './hex.js';
import { isDeckSeam, nearestDeckCornerInto } from './deckCorners.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreHexInto } from './plates.js';

/** A corner has at most three seams. */
const MAX_DEG = 3;
const KEY_OFFSET = 1 << 24;
const KEY_SPAN = 1 << 25;
/** World corner → one number (corners are ≥ hundreds of units apart, so the
 *  rounded point is unique; no string keys). */
function cornerKey(x: number, y: number): number {
  return (Math.round(x) + KEY_OFFSET) * KEY_SPAN + (Math.round(y) + KEY_OFFSET);
}

const HEX: AxialHex = { q: 0, r: 0 };
const CENTRE: HexPoint = { x: 0, y: 0 };
const A: HexPoint = { x: 0, y: 0 };
const B: HexPoint = { x: 0, y: 0 };
const SNAP: HexPoint = { x: 0, y: 0 };

/** The plated corners and their seams, as a unit-cost {@link SearchGraph}. */
export class DeckCornerGraph implements SearchGraph {
  /** Corner world points, flat (x, y) per node. */
  private readonly xy: number[] = [];
  private readonly deg: number[] = [];
  /** `MAX_DEG` slots per node: the neighbour node ids. */
  private readonly adj: number[] = [];
  private readonly byKey = new Map<number, number>();

  get nodeCount(): number { return this.deg.length; }
  edgeCount(i: number): number { return this.deg[i]!; }
  edgeTo(i: number, k: number): number { return this.adj[i * MAX_DEG + k]!; }
  edgeCost(): number { return 1; }

  /** Corner `i`'s world point. */
  x(i: number): number { return this.xy[2 * i]!; }
  y(i: number): number { return this.xy[2 * i + 1]!; }

  /**
   * (Re)build over `plates`, flat (i, j) pairs (`PlateSet.platesInto`,
   * `OwnerPlateList.pairs`): every corner of their hexes, joined along each
   * hex's six seams.
   */
  build(plates: readonly number[]): this {
    this.xy.length = 0;
    this.deg.length = 0;
    this.adj.length = 0;
    this.byKey.clear();
    for (let p = 0; p + 1 < plates.length; p += 2) {
      plateCentreHexInto(plates[p]!, plates[p + 1]!, HEX);
      const cq = HEX.q, cr = HEX.r;
      for (let h = -1; h < 6; h++) {
        const q = h < 0 ? cq : cq + HEX_DIRS[h]!.q;
        const r = h < 0 ? cr : cr + HEX_DIRS[h]!.r;
        deckHexCentreInto(q, r, CENTRE);
        for (let e = 0; e < 6; e++) {
          hexCornerInto(CENTRE.x, CENTRE.y, DECK_HEX_SIZE, e, A);
          hexCornerInto(CENTRE.x, CENTRE.y, DECK_HEX_SIZE, (e + 1) % 6, B);
          // Deck on this side by construction; the seam test is the shared one.
          if (!isDeckSeam(A.x, A.y, B.x, B.y)) continue;
          this.join(this.node(A.x, A.y), this.node(B.x, B.y));
        }
      }
    }
    return this;
  }

  /** The node at the deck corner nearest (x, y), or -1 when that corner is
   *  on no plate. */
  nodeAt(x: number, y: number): number {
    nearestDeckCornerInto(x, y, SNAP);
    return this.byKey.get(cornerKey(SNAP.x, SNAP.y)) ?? -1;
  }

  private node(x: number, y: number): number {
    const key = cornerKey(x, y);
    const at = this.byKey.get(key);
    if (at !== undefined) return at;
    const id = this.deg.length;
    this.byKey.set(key, id);
    this.xy.push(x, y);
    this.deg.push(0);
    for (let k = 0; k < MAX_DEG; k++) this.adj.push(-1);
    return id;
  }

  private join(a: number, b: number): void {
    this.link(a, b);
    this.link(b, a);
  }

  private link(a: number, b: number): void {
    const n = this.deg[a]!;
    for (let k = 0; k < n; k++) if (this.adj[a * MAX_DEG + k] === b) return;
    if (n >= MAX_DEG) return;
    this.adj[a * MAX_DEG + n] = b;
    this.deg[a] = n + 1;
  }
}

/** Straight-line distance in edges to one corner: admissible, as no hex edge
 *  is longer than `DECK_HEX_SIZE`. */
class CornerGoal implements SearchGoal {
  graph: DeckCornerGraph | null = null;
  target = -1;
  isGoal(i: number): boolean { return i === this.target; }
  heuristic(i: number): number {
    const g = this.graph!;
    return Math.hypot(g.x(i) - g.x(this.target), g.y(i) - g.y(this.target)) / DECK_HEX_SIZE;
  }
}

const SEARCH = new GraphSearch();
const GOAL = new CornerGoal();

/**
 * The shortest run of plated hex edges from the corner nearest (ax, ay) to
 * the corner nearest (bx, by), written into `out` as flat (x, y) corner
 * points, both ends included (cleared first). Returns false (and `out`
 * empty) when either corner is off the plates or no run of edges joins them.
 */
export function deckCornerPathInto(
  graph: DeckCornerGraph, ax: number, ay: number, bx: number, by: number, out: number[],
): boolean {
  out.length = 0;
  const from = graph.nodeAt(ax, ay);
  const to = graph.nodeAt(bx, by);
  if (from < 0 || to < 0) return false;
  GOAL.graph = graph;
  GOAL.target = to;
  if (SEARCH.search(graph, from, GOAL) !== to) return false;
  // Walk back from the goal, then reverse in place (start first).
  for (let t = to; t >= 0; t = SEARCH.prev(t)) out.push(graph.x(t), graph.y(t));
  for (let i = 0, j = out.length - 2; i < j; i += 2, j -= 2) {
    const x = out[i]!, y = out[i + 1]!;
    out[i] = out[j]!; out[i + 1] = out[j + 1]!;
    out[j] = x; out[j + 1] = y;
  }
  return true;
}
