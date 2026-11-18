/**
 * The game's one graph searcher (navigation plan, Stage E slice 1).
 *
 * A* over a graph addressed by node index, with Dijkstra (no heuristic) and
 * breadth-first search (unit edge costs) as special cases. Every route or hop
 * search in the game runs through this class: sector gate hops, held-sector
 * routes, the structure power grid, and the in-sector route planner.
 *
 * Allocation-free after warm-up: g-costs, parents and the open heap live in
 * typed arrays sized to the graph and grown only when a bigger graph or a
 * fuller heap is seen. A visit stamp replaces clearing arrays per search.
 *
 * Ties pop in insertion order, so with unit costs the visit order is exactly a
 * FIFO breadth-first search: callers moved here from a hand-written BFS keep
 * their answers, tie-breaks included.
 */

/** A graph the searcher walks: node `i` has `edgeCount(i)` out-edges. */
export interface SearchGraph {
  readonly nodeCount: number;
  edgeCount(i: number): number;
  /** Target node of out-edge `k` of node `i`. */
  edgeTo(i: number, k: number): number;
  /** Cost of out-edge `k` of node `i` (> 0). Unit-cost graphs return 1. */
  edgeCost(i: number, k: number): number;
}

/** What a search is looking for. Callers keep one instance and mutate its
 *  fields between searches (no closure per call, #14). */
export interface SearchGoal {
  isGoal(i: number): boolean;
  /** Admissible estimate of the cost from `i` to the nearest goal; 0 ⇒ Dijkstra/BFS. */
  heuristic(i: number): number;
}

/** A goal that is one fixed node, with no heuristic. */
export class NodeGoal implements SearchGoal {
  target = -1;
  isGoal(i: number): boolean { return i === this.target; }
  heuristic(): number { return 0; }
}

/** Adjacency lists as a {@link SearchGraph} with unit costs (gate graphs). */
export class UnitGraph implements SearchGraph {
  constructor(private readonly adj: ReadonlyArray<ReadonlyArray<number>>) {}
  get nodeCount(): number { return this.adj.length; }
  edgeCount(i: number): number { return this.adj[i]!.length; }
  edgeTo(i: number, k: number): number { return this.adj[i]![k]!; }
  edgeCost(): number { return 1; }
}

export class GraphSearch {
  private g = new Float64Array(0);
  private prevNode = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint32Array(0);
  private run = 0;
  // Binary min-heap on (f, seq); lazy deletion (stale entries are skipped).
  private heapNode = new Int32Array(16);
  private heapF = new Float64Array(16);
  private heapSeq = new Uint32Array(16);
  private heapLen = 0;
  private seq = 0;
  /** Nodes popped and expanded by the last search (work counter). */
  expanded = 0;

  /** Search from `from`; returns the first goal node popped, or -1 (none, or
   *  `limit` nodes expanded first). After a hit, {@link prev} / {@link cost}
   *  describe the path. */
  search(graph: SearchGraph, from: number, goal: SearchGoal, limit = Infinity): number {
    this.ensure(graph.nodeCount);
    const run = this.nextRun();
    const g = this.g, prev = this.prevNode, stamp = this.stamp, closed = this.closed;
    this.heapLen = 0;
    this.seq = 0;
    this.expanded = 0;
    stamp[from] = run;
    g[from] = 0;
    prev[from] = -1;
    this.push(from, goal.heuristic(from));
    while (this.heapLen > 0) {
      const i = this.pop();
      if (closed[i] === run) continue;
      closed[i] = run;
      if (goal.isGoal(i)) return i;
      if (this.expanded >= limit) return -1;
      this.expanded++;
      const gi = g[i]!;
      const n = graph.edgeCount(i);
      for (let k = 0; k < n; k++) {
        const j = graph.edgeTo(i, k);
        if (closed[j] === run) continue;
        const gj = gi + graph.edgeCost(i, k);
        if (stamp[j] === run && gj >= g[j]!) continue;
        stamp[j] = run;
        g[j] = gj;
        prev[j] = i;
        this.push(j, gj + goal.heuristic(j));
      }
    }
    return -1;
  }

  /** Parent of `i` on the last search's tree (-1 at the start). */
  prev(i: number): number { return this.prevNode[i]!; }

  /** Path cost to `i` found by the last search (valid for reached nodes). */
  cost(i: number): number { return this.g[i]!; }

  /** Was `i` reached (seen) by the last search? */
  reached(i: number): boolean { return i >= 0 && i < this.stamp.length && this.stamp[i] === this.run; }

  /** The node right after `from` on the last search's path to `to`, or -1
   *  when `to` is `from` or was not reached. */
  firstHop(from: number, to: number): number {
    if (to === from || !this.reached(to)) return -1;
    let t = to;
    while (this.prevNode[t] !== from) {
      t = this.prevNode[t]!;
      if (t < 0) return -1;
    }
    return t;
  }

  /** Edge count of the last search's path from its start to `to` (-1 if unreached). */
  hops(to: number): number {
    if (!this.reached(to)) return -1;
    let n = 0;
    for (let t = to; this.prevNode[t]! >= 0; t = this.prevNode[t]!) n++;
    return n;
  }

  private nextRun(): number {
    this.run++;
    if (this.run === 0xffffffff) { // wrap: clear stamps once every 4 billion searches
      this.stamp.fill(0);
      this.closed.fill(0);
      this.run = 1;
    }
    return this.run;
  }

  private ensure(n: number): void {
    if (this.g.length >= n) return;
    const cap = Math.max(n, this.g.length * 2);
    this.g = new Float64Array(cap);
    this.prevNode = new Int32Array(cap);
    this.stamp = new Uint32Array(cap);
    this.closed = new Uint32Array(cap);
    this.run = 0;
  }

  private less(a: number, b: number): boolean {
    const fa = this.heapF[a]!, fb = this.heapF[b]!;
    return fa < fb || (fa === fb && this.heapSeq[a]! < this.heapSeq[b]!);
  }

  private swap(a: number, b: number): void {
    const hn = this.heapNode, hf = this.heapF, hs = this.heapSeq;
    const n = hn[a]!, f = hf[a]!, s = hs[a]!;
    hn[a] = hn[b]!; hf[a] = hf[b]!; hs[a] = hs[b]!;
    hn[b] = n; hf[b] = f; hs[b] = s;
  }

  private push(node: number, f: number): void {
    if (this.heapLen === this.heapNode.length) this.growHeap();
    let i = this.heapLen++;
    this.heapNode[i] = node;
    this.heapF[i] = f;
    this.heapSeq[i] = this.seq++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  private pop(): number {
    const top = this.heapNode[0]!;
    const last = --this.heapLen;
    if (last > 0) {
      this.heapNode[0] = this.heapNode[last]!;
      this.heapF[0] = this.heapF[last]!;
      this.heapSeq[0] = this.heapSeq[last]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < last && this.less(l, m)) m = l;
        if (r < last && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private growHeap(): void {
    const cap = this.heapNode.length * 2;
    const hn = new Int32Array(cap), hf = new Float64Array(cap), hs = new Uint32Array(cap);
    hn.set(this.heapNode); hf.set(this.heapF); hs.set(this.heapSeq);
    this.heapNode = hn; this.heapF = hf; this.heapSeq = hs;
  }
}
