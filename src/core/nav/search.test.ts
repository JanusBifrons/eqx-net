import { describe, it, expect } from 'vitest';
import { GraphSearch, NodeGoal, UnitGraph, type SearchGoal, type SearchGraph } from './search.js';

/** Deterministic PRNG for the random graphs. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAdj(n: number, degree: number, r: () => number): number[][] {
  const adj: number[][] = [];
  for (let i = 0; i < n; i++) {
    const out: number[] = [];
    for (let k = 0; k < degree; k++) {
      const j = Math.floor(r() * n);
      if (j !== i && !out.includes(j)) out.push(j);
    }
    adj.push(out);
  }
  return adj;
}

/** The hand-written FIFO BFS the old searches used (HeldSectorRoutes.nearestHeld). */
function referenceBfs(adj: number[][], from: number, isGoal: (i: number) => boolean): { hit: number; prev: Int32Array } {
  const n = adj.length, q = new Int32Array(n), prev = new Int32Array(n), seen = new Uint8Array(n);
  let head = 0, tail = 0;
  q[tail++] = from; seen[from] = 1; prev[from] = -1;
  while (head < tail) {
    const i = q[head++]!;
    if (isGoal(i)) return { hit: i, prev };
    for (const j of adj[i]!) {
      if (seen[j] === 1) continue;
      seen[j] = 1; prev[j] = i; q[tail++] = j;
    }
  }
  return { hit: -1, prev };
}

class SetGoal implements SearchGoal {
  set = new Set<number>();
  isGoal(i: number): boolean { return this.set.has(i); }
  heuristic(): number { return 0; }
}

describe('GraphSearch', () => {
  it('with unit costs, matches a FIFO BFS exactly (same goal, same first hop, ties included)', () => {
    const r = rng(7);
    const search = new GraphSearch();
    const goal = new SetGoal();
    for (let trial = 0; trial < 300; trial++) {
      const n = 5 + Math.floor(r() * 40);
      const adj = randomAdj(n, 1 + Math.floor(r() * 4), r);
      const graph = new UnitGraph(adj);
      goal.set.clear();
      const goals = 1 + Math.floor(r() * 3);
      for (let k = 0; k < goals; k++) goal.set.add(Math.floor(r() * n));
      const from = Math.floor(r() * n);
      const ref = referenceBfs(adj, from, (i) => goal.set.has(i));
      const hit = search.search(graph, from, goal);
      expect(hit).toBe(ref.hit);
      if (hit >= 0 && hit !== from) {
        let t = hit;
        while (ref.prev[t] !== from) t = ref.prev[t]!;
        expect(search.firstHop(from, hit)).toBe(t);
      }
    }
  });

  it('with weights, finds the cheapest path (vs Floyd–Warshall)', () => {
    const r = rng(11);
    const search = new GraphSearch();
    const goal = new NodeGoal();
    for (let trial = 0; trial < 60; trial++) {
      const n = 4 + Math.floor(r() * 20);
      const adj = randomAdj(n, 3, r);
      const w = adj.map((out) => out.map(() => 1 + Math.floor(r() * 9)));
      const graph: SearchGraph = {
        nodeCount: n,
        edgeCount: (i) => adj[i]!.length,
        edgeTo: (i, k) => adj[i]![k]!,
        edgeCost: (i, k) => w[i]![k]!,
      };
      const d = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
      adj.forEach((out, i) => out.forEach((j, k) => { d[i]![j] = Math.min(d[i]![j]!, w[i]![k]!); }));
      for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (d[i]![k]! + d[k]![j]! < d[i]![j]!) d[i]![j] = d[i]![k]! + d[k]![j]!;
      }
      const from = Math.floor(r() * n);
      goal.target = Math.floor(r() * n);
      const hit = search.search(graph, from, goal);
      if (d[from]![goal.target] === Infinity) expect(hit).toBe(-1);
      else {
        expect(hit).toBe(goal.target);
        expect(search.cost(hit)).toBe(d[from]![goal.target]);
      }
    }
  });

  it('A* with an admissible heuristic finds the same cost as Dijkstra, expanding fewer nodes', () => {
    // 40×40 4-connected grid with a wall; cost 1 per step.
    const W = 40, H = 40;
    const wall = (x: number, y: number) => x === 20 && y < 35;
    const dx = [1, -1, 0, 0], dy = [0, 0, 1, -1];
    const nbr = (i: number, k: number) => {
      const x = i % W, y = (i / W) | 0, nx = x + dx[k]!, ny = y + dy[k]!;
      return nx < 0 || ny < 0 || nx >= W || ny >= H || wall(nx, ny) ? -1 : ny * W + nx;
    };
    // Edges as a fixed 4-slot list; blocked slots point back at self with a huge cost (never chosen).
    const graph: SearchGraph = {
      nodeCount: W * H,
      edgeCount: () => 4,
      edgeTo: (i, k) => { const j = nbr(i, k); return j < 0 ? i : j; },
      edgeCost: (i, k) => (nbr(i, k) < 0 ? 1e9 : 1),
    };
    const target = 39 * W + 39, from = 0;
    const tx = target % W, ty = (target / W) | 0;
    const aStar: SearchGoal = {
      isGoal: (i) => i === target,
      heuristic: (i) => Math.abs((i % W) - tx) + Math.abs(((i / W) | 0) - ty),
    };
    const dijkstra = new NodeGoal();
    dijkstra.target = target;
    const s = new GraphSearch();
    expect(s.search(graph, from, dijkstra)).toBe(target);
    const dCost = s.cost(target), dExpanded = s.expanded;
    expect(s.search(graph, from, aStar)).toBe(target);
    expect(s.cost(target)).toBe(dCost);
    expect(s.expanded).toBeLessThan(dExpanded);
    console.log(`[nav search] 40x40 wall grid: dijkstra expanded ${dExpanded}, A* expanded ${s.expanded}`);
  });

  it('reuses its scratch arrays once warm (no allocation on repeat searches, #14)', () => {
    const r = rng(3);
    const adj = randomAdj(200, 3, r);
    const graph = new UnitGraph(adj);
    const goal = new NodeGoal();
    const s = new GraphSearch();
    const internals = s as unknown as Record<string, unknown>;
    goal.target = 150;
    for (let k = 0; k < 20; k++) s.search(graph, k, goal); // warm (heap may grow here)
    const before = ['g', 'prevNode', 'stamp', 'closed', 'heapNode', 'heapF', 'heapSeq'].map((f) => internals[f]);
    for (let k = 0; k < 200; k++) { goal.target = (k * 37) % 200; s.search(graph, k, goal); }
    const after = ['g', 'prevNode', 'stamp', 'closed', 'heapNode', 'heapF', 'heapSeq'].map((f) => internals[f]);
    after.forEach((a, i) => expect(a).toBe(before[i]));
  });

  it('reports hop counts and unreached nodes', () => {
    const graph = new UnitGraph([[1], [2], [], []]);
    const goal = new NodeGoal();
    const s = new GraphSearch();
    goal.target = 2;
    expect(s.search(graph, 0, goal)).toBe(2);
    expect(s.hops(2)).toBe(2);
    expect(s.firstHop(0, 2)).toBe(1);
    expect(s.reached(3)).toBe(false);
    goal.target = 3;
    expect(s.search(graph, 0, goal)).toBe(-1);
    expect(s.firstHop(0, 3)).toBe(-1);
  });
});
