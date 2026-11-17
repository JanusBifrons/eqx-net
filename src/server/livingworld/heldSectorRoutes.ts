/**
 * Routes over the sectors a power holds, for its flagship fleet
 * (`FlagshipDirector`, owner 2026-11-17: "One flagship fleet per power").
 *
 * Split out of `FlagshipDirector.ts` (god-file cap). The gate graph is the
 * galaxy's (`GalaxySector.neighbours`), restricted to the sectors that have a
 * room in this process, built once. Queries run on the director's control
 * tick and allocate nothing: the search is the game's one graph searcher
 * (`core/nav/search.ts`) with a reused goal ("the nearest sector this power
 * holds").
 */
import { getSector } from '../../core/galaxy/galaxy.js';
import { GraphSearch, UnitGraph, type SearchGoal } from '../../core/nav/search.js';

/** "Nearest sector held by `factionId`" (mutated per query, never reallocated). */
class HeldGoal implements SearchGoal {
  factionId = '';
  constructor(
    private readonly keys: readonly string[],
    private readonly holderOf: (sectorKey: string) => string | null,
  ) {}
  isGoal(i: number): boolean { return this.holderOf(this.keys[i]!) === this.factionId; }
  heuristic(): number { return 0; }
}

export class HeldSectorRoutes {
  private readonly keys: string[] = [];
  private readonly idx = new Map<string, number>();
  private readonly adj: number[][] = [];
  private readonly graph: UnitGraph;
  private readonly search = new GraphSearch();
  private readonly goal: HeldGoal;

  constructor(
    sectorKeys: Iterable<string>,
    /** The power holding a sector (null when nobody does). */
    private readonly holderOf: (sectorKey: string) => string | null,
  ) {
    for (const key of sectorKeys) {
      if (getSector(key) === undefined) continue;
      this.idx.set(key, this.keys.length);
      this.keys.push(key);
    }
    for (const key of this.keys) {
      const out: number[] = [];
      for (const n of getSector(key)!.neighbours) {
        const j = this.idx.get(n);
        if (j !== undefined) out.push(j);
      }
      this.adj.push(out);
    }
    this.graph = new UnitGraph(this.adj);
    this.goal = new HeldGoal(this.keys, holderOf);
  }

  /** Where a power's fleet (re)spawns: `heart` while it holds it, else the
   *  nearest sector it holds (gate hops from the heart). Holding nothing, the
   *  heart itself (the fleet comes to fight for it). With no room for the
   *  heart, the first held sector, else null. */
  homeSector(heart: string | null, factionId: string): string | null {
    const h = heart !== null ? this.idx.get(heart) : undefined;
    if (h !== undefined) {
      const t = this.nearestHeld(h, factionId);
      return this.keys[t >= 0 ? t : h]!;
    }
    for (const k of this.keys) if (this.holderOf(k) === factionId) return k;
    return null;
  }

  /** The neighbour to cross into to head home: the first hop toward the
   *  nearest sector `factionId` holds. Null while `from` is held, or when the
   *  power holds nothing reachable (the fleet stays and fights). */
  rehomeHop(from: string | null, factionId: string): string | null {
    const i = from !== null ? this.idx.get(from) : undefined;
    if (i === undefined) return null;
    const t = this.nearestHeld(i, factionId);
    if (t < 0 || t === i) return null;
    return this.keys[this.search.firstHop(i, t)]!;
  }

  /** A random neighbour of `from` that `factionId` holds, or null. */
  heldNeighbour(from: string | null, factionId: string, rng: () => number): string | null {
    const i = from !== null ? this.idx.get(from) : undefined;
    if (i === undefined) return null;
    const ns = this.adj[i]!;
    let n = 0;
    for (const j of ns) if (this.holderOf(this.keys[j]!) === factionId) n++;
    if (n === 0) return null;
    let k = Math.floor(rng() * n) % n;
    for (const j of ns) {
      if (this.holderOf(this.keys[j]!) !== factionId) continue;
      if (k-- === 0) return this.keys[j]!;
    }
    return null;
  }

  /** Nearest sector held by `factionId` from node `from` (`from` itself
   *  when held), in gate hops: its node index, or -1. */
  private nearestHeld(from: number, factionId: string): number {
    this.goal.factionId = factionId;
    return this.search.search(this.graph, from, this.goal);
  }
}
