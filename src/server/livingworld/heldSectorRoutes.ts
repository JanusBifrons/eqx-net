/**
 * Routes over the sectors a power holds, for its flagship fleet
 * (`FlagshipDirector`, owner 2026-11-17: "One flagship fleet per power").
 *
 * Split out of `FlagshipDirector.ts` (god-file cap). The gate graph is the
 * galaxy's (`GalaxySector.neighbours`), restricted to the sectors that have a
 * room in this process, built once. Queries run on the director's control
 * tick and allocate nothing: the BFS uses preallocated scratch. Same BFS idea
 * as `population.nextHopToward`, but the goal is "the nearest sector this
 * power holds", not one fixed key, so it can't reuse that helper.
 */
import { getSector } from '../../core/galaxy/galaxy.js';

export class HeldSectorRoutes {
  private readonly keys: string[] = [];
  private readonly idx = new Map<string, number>();
  private readonly adj: number[][] = [];
  private readonly queue: Int32Array;
  private readonly prev: Int32Array;
  private readonly seen: Uint8Array;

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
    const nn = Math.max(1, this.keys.length);
    this.queue = new Int32Array(nn);
    this.prev = new Int32Array(nn);
    this.seen = new Uint8Array(nn);
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
    let t = this.nearestHeld(i, factionId);
    if (t < 0 || t === i) return null;
    while (this.prev[t] !== i) t = this.prev[t]!;
    return this.keys[t]!;
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

  /** BFS from node `from` to the nearest sector held by `factionId` (`from`
   *  itself when held). Its node index, or -1; `prev` then holds the path. */
  private nearestHeld(from: number, factionId: string): number {
    const q = this.queue, prev = this.prev, seen = this.seen;
    seen.fill(0);
    let head = 0, tail = 0;
    q[tail++] = from;
    seen[from] = 1;
    prev[from] = -1;
    while (head < tail) {
      const i = q[head++]!;
      if (this.holderOf(this.keys[i]!) === factionId) return i;
      const ns = this.adj[i]!;
      for (let k = 0; k < ns.length; k++) {
        const j = ns[k]!;
        if (seen[j] === 1) continue;
        seen[j] = 1;
        prev[j] = i;
        q[tail++] = j;
      }
    }
    return -1;
  }
}
