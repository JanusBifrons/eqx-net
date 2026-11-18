/**
 * Gate-hop routes over the whole galaxy graph, through the game's one graph
 * searcher (`core/nav/search.ts`). Unit costs, so the search is an exact FIFO
 * BFS in `GalaxySector.neighbours` order: the first shortest path is stable.
 *
 * The graph is built once from `GALAXY_SECTORS`; queries reuse one searcher
 * and one goal (no allocation per call).
 */
import { GALAXY_SECTORS, getSector } from './galaxy.js';
import { GraphSearch, NodeGoal, UnitGraph } from '../nav/search.js';

let keys: string[] | null = null;
let index: Map<string, number> | null = null;
let graph: UnitGraph | null = null;
const search = new GraphSearch();
const goal = new NodeGoal();

function build(): void {
  keys = GALAXY_SECTORS.map((s) => s.key);
  index = new Map(keys.map((k, i) => [k, i]));
  const adj: number[][] = keys.map((k) => {
    const out: number[] = [];
    for (const n of getSector(k)!.neighbours) {
      const j = index!.get(n);
      if (j !== undefined) out.push(j);
    }
    return out;
  });
  graph = new UnitGraph(adj);
}

/** Index of a sector key in the gate graph, or -1 when unknown. */
function nodeOf(key: string): number {
  if (index === null) build();
  return index!.get(key) ?? -1;
}

/** Searches from `from` to `to`; the goal node or -1. */
function run(from: number, to: number): number {
  goal.target = to;
  return search.search(graph!, from, goal);
}

/** The neighbour of `from` on a shortest gate route to `to`, or null when the
 *  two are equal, either is unknown, or `to` is unreachable. */
export function gateFirstHop(from: string, to: string): string | null {
  if (from === to) return null;
  const a = nodeOf(from), b = nodeOf(to);
  if (a < 0 || b < 0 || run(a, b) < 0) return null;
  return keys![search.firstHop(a, b)]!;
}

/** Gate hops from `from` to `to`: 0 when equal, Infinity when unknown or unreachable. */
export function gateHops(from: string, to: string): number {
  if (from === to) return 0;
  const a = nodeOf(from), b = nodeOf(to);
  if (a < 0 || b < 0 || run(a, b) < 0) return Infinity;
  return search.hops(b);
}
