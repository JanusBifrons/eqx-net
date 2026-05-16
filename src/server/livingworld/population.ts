/**
 * Living World — pure population math.
 *
 * Zero I/O, zero zone awareness beyond the galaxy graph + shared sector
 * bounds. Every function here is deterministic given its arguments (the
 * RNG is an injected seam — `Rng`), so the whole distribution / migration
 * policy is unit-testable without a server, in the spirit of the
 * gold-standard `TransitOrchestrator.test.ts` hand-rolled style.
 *
 * The `LivingWorldDirector` composes these; it owns the timers, bus
 * subscriptions and room references. This module owns only the decisions.
 */
import { getSector, getNeighbours } from '../../core/galaxy/galaxy.js';
import { clampToSectorBounds, SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';

/** A source of randomness in `[0, 1)` — `Math.random` in production, a
 *  seeded generator in tests. Mirrors the `SpawnerHooks.pickDroneKind`
 *  injection seam so respawn-sector / edge-pose choices are deterministic
 *  under test. */
export type Rng = () => number;

/** Minimum bots assigned to a sector that has at least one player, so a
 *  lone-player sector still gets a real pack rather than a trickle. Only
 *  honoured when the placeable budget can actually afford it for every
 *  occupied sector; otherwise the split degrades to pure proportional so
 *  the busiest sectors still win. */
export const MIN_PACK_PER_OCCUPIED = 2;

/** Fraction of the playable half-extent at which a respawning bot warps
 *  in "from outside known space" — far enough to read as an arrival from
 *  the edge, inside the clamp so it never spawns out of bounds. */
const RESPAWN_EDGE_FRACTION = 0.92;

/** Inbound cruise speed (u/s) a freshly-warped-in bot carries toward the
 *  sector centre. The drone AI takes over steering immediately; this is
 *  just so the arrival has visible momentum rather than a dead drop-in. */
const RESPAWN_INBOUND_SPEED = 60;

/**
 * Largest-remainder (Hamilton) apportionment. Splits `total` across `keys`
 * proportional to `weights`, returning integer counts that sum to exactly
 * `total`. Deterministic: remainder seats go to the largest fractional
 * parts, ties broken by `keys` order. All-zero (or absent) weights ⇒ even
 * split (every key weight 1).
 */
export function apportion(
  weights: ReadonlyMap<string, number>,
  total: number,
  keys: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, 0);
  if (keys.length === 0 || total <= 0) return out;

  let sumW = 0;
  for (const k of keys) sumW += Math.max(0, weights.get(k) ?? 0);
  // Degenerate: no positive weight anywhere ⇒ treat as equal weights.
  const effWeight = (k: string): number =>
    sumW > 0 ? Math.max(0, weights.get(k) ?? 0) : 1;
  const effSum = sumW > 0 ? sumW : keys.length;

  const remainders: Array<{ key: string; frac: number }> = [];
  let assigned = 0;
  for (const k of keys) {
    const exact = (effWeight(k) / effSum) * total;
    const floor = Math.floor(exact);
    out.set(k, floor);
    assigned += floor;
    remainders.push({ key: k, frac: exact - floor });
  }

  let leftover = total - assigned;
  // Stable: highest fractional part first; ties keep `keys` order (the
  // index tie-break makes the sort deterministic).
  const order = keys.reduce<Map<string, number>>((m, k, i) => m.set(k, i), new Map());
  remainders.sort((a, b) => b.frac - a.frac || order.get(a.key)! - order.get(b.key)!);
  for (let i = 0; leftover > 0 && i < remainders.length; i++, leftover--) {
    const k = remainders[i]!.key;
    out.set(k, out.get(k)! + 1);
  }
  return out;
}

export interface DistributionInput {
  /** All galaxy sector keys, in a stable order (the apportionment
   *  tie-break depends on this order being identical run-to-run). */
  readonly sectorKeys: readonly string[];
  /** Per-sector count of active, alive players. Missing ⇒ 0. */
  readonly playerCounts: ReadonlyMap<string, number>;
  /** How many bots can actually be placed this pass: the global cap minus
   *  bots currently respawning (dead, waiting) or shed-paused. */
  readonly budget: number;
}

/**
 * The target number of bots per sector.
 *
 * - **No players anywhere** ⇒ even spread of `budget` across every sector
 *   (largest-remainder), so the empty galaxy stays uniformly alive.
 * - **Players present** ⇒ bots converge on player-occupied sectors,
 *   proportional to each sector's player count, with `MIN_PACK_PER_OCCUPIED`
 *   floor when affordable. Empty sectors get 0 — everyone hunts the players.
 *
 * Always sums to exactly `min(budget, …)`; never negative.
 */
export function computeDesiredDistribution(input: DistributionInput): Map<string, number> {
  const { sectorKeys, playerCounts, budget } = input;
  const result = new Map<string, number>();
  for (const k of sectorKeys) result.set(k, 0);
  if (budget <= 0 || sectorKeys.length === 0) return result;

  let totalPlayers = 0;
  for (const k of sectorKeys) totalPlayers += Math.max(0, playerCounts.get(k) ?? 0);

  if (totalPlayers === 0) {
    const equal = new Map<string, number>();
    for (const k of sectorKeys) equal.set(k, 1);
    return apportion(equal, budget, sectorKeys);
  }

  const occupied = sectorKeys.filter((k) => (playerCounts.get(k) ?? 0) > 0);
  const weights = new Map<string, number>();
  for (const k of occupied) weights.set(k, playerCounts.get(k) ?? 0);

  const floorTotal = MIN_PACK_PER_OCCUPIED * occupied.length;
  if (floorTotal >= budget) {
    // Can't floor everyone — proportional so the busiest sectors win.
    const split = apportion(weights, budget, occupied);
    for (const [k, v] of split) result.set(k, v);
    return result;
  }

  const remainder = budget - floorTotal;
  const extra = apportion(weights, remainder, occupied);
  for (const k of occupied) {
    result.set(k, MIN_PACK_PER_OCCUPIED + (extra.get(k) ?? 0));
  }
  return result;
}

/**
 * Shortest-path first hop. Returns the neighbour of `from` that lies on a
 * shortest route to `goal` (BFS over the galaxy graph), or `null` when
 * `from === goal`, either key is unknown, or `goal` is unreachable.
 * Bots may only transit to a *direct* neighbour, so multi-hop routes are
 * realised as one `nextHopToward` step per control-loop iteration.
 *
 * Deterministic: neighbours are explored in `GalaxySector.neighbours`
 * order, so the first shortest path found is stable.
 */
export function nextHopToward(from: string, goal: string): string | null {
  if (from === goal) return null;
  if (!getSector(from) || !getSector(goal)) return null;

  const prev = new Map<string, string>();
  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    for (const n of getNeighbours(cur)) {
      if (visited.has(n.key)) continue;
      visited.add(n.key);
      prev.set(n.key, cur);
      queue.push(n.key);
    }
  }
  if (!prev.has(goal)) return null;

  // Walk predecessors back until the node whose parent is `from`.
  let step = goal;
  while (prev.get(step) !== from) {
    const p = prev.get(step);
    if (p === undefined) return null;
    step = p;
  }
  return step;
}

export interface MigrationPlanInput {
  readonly sectorKeys: readonly string[];
  /** sectorKey → botIds physically present there and eligible to move
   *  (NOT mid-transit, NOT in arrival cooldown). */
  readonly current: ReadonlyMap<string, readonly string[]>;
  /** sectorKey → desired bot count (from `computeDesiredDistribution`). */
  readonly desired: ReadonlyMap<string, number>;
  /** Hard cap on transits started this control tick — keeps the warp
   *  traffic legible and avoids a thundering herd. */
  readonly maxPerTick: number;
}

export interface Migration {
  readonly botId: string;
  readonly from: string;
  /** The immediate *neighbour* the bot transits into this hop (one step
   *  toward the deficit sector), not necessarily the final destination. */
  readonly to: string;
}

/**
 * Greedy surplus→deficit matching. For each deficit sector (most-starved
 * first), pull a bot from the closest surplus sector and route it one hop
 * toward the deficit via `nextHopToward`. Bounded by `maxPerTick`; only
 * acts when |surplus|≥1 and |deficit|≥1 (the ≥1 delta is the hysteresis
 * that stops single-bot flapping when player counts jitter). Pure: callers
 * pre-filter `current` to exclude in-transit / cooldown bots.
 */
export function planMigrations(input: MigrationPlanInput): Migration[] {
  const { sectorKeys, current, desired, maxPerTick } = input;
  const out: Migration[] = [];
  if (maxPerTick <= 0) return out;

  // Mutable working counts + per-sector movable bot queues.
  const count = new Map<string, number>();
  const pool = new Map<string, string[]>();
  for (const k of sectorKeys) {
    const ids = [...(current.get(k) ?? [])];
    pool.set(k, ids);
    count.set(k, ids.length);
  }
  const order = sectorKeys.reduce<Map<string, number>>((m, k, i) => m.set(k, i), new Map());
  const deficitOf = (k: string): number => (desired.get(k) ?? 0) - (count.get(k) ?? 0);
  const surplusOf = (k: string): number => (count.get(k) ?? 0) - (desired.get(k) ?? 0);

  while (out.length < maxPerTick) {
    // Neediest deficit sector (largest deficit, then sector order).
    const deficits = sectorKeys
      .filter((k) => deficitOf(k) >= 1)
      .sort((a, b) => deficitOf(b) - deficitOf(a) || order.get(a)! - order.get(b)!);
    if (deficits.length === 0) break;
    const target = deficits[0]!;

    // Closest surplus donor (min graph distance, then largest surplus,
    // then sector order). Graph distance via successive nextHopToward is
    // unnecessary — galaxy is tiny; use BFS-length through `hopCount`.
    const donors = sectorKeys
      .filter((k) => k !== target && surplusOf(k) >= 1 && (pool.get(k)?.length ?? 0) > 0)
      .sort(
        (a, b) =>
          hopCount(a, target) - hopCount(b, target) ||
          surplusOf(b) - surplusOf(a) ||
          order.get(a)! - order.get(b)!,
      );
    if (donors.length === 0) break;
    const from = donors[0]!;

    const hop = nextHopToward(from, target);
    if (hop === null) break; // unreachable / mis-shaped graph — bail safely
    const botId = pool.get(from)!.shift()!;
    count.set(from, (count.get(from) ?? 0) - 1);
    count.set(hop, (count.get(hop) ?? 0) + 1);
    out.push({ botId, from, to: hop });
  }
  return out;
}

/** BFS hop count between two sectors; `Infinity` if unreachable. Cheap —
 *  the galaxy is 7 nodes. Internal to `planMigrations`'s donor ranking. */
function hopCount(from: string, goal: string): number {
  if (from === goal) return 0;
  const visited = new Set<string>([from]);
  let frontier: string[] = [from];
  let dist = 0;
  while (frontier.length > 0) {
    dist++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of getNeighbours(cur)) {
        if (n.key === goal) return dist;
        if (visited.has(n.key)) continue;
        visited.add(n.key);
        next.push(n.key);
      }
    }
    frontier = next;
  }
  return Infinity;
}

/** Uniform-random sector for a "from outside known space" respawn. */
export function pickRespawnSector(rng: Rng, sectorKeys: readonly string[]): string {
  if (sectorKeys.length === 0) throw new Error('pickRespawnSector: no sectors');
  const idx = Math.min(sectorKeys.length - 1, Math.floor(rng() * sectorKeys.length));
  return sectorKeys[idx]!;
}

export interface EdgePose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

/**
 * A spawn pose on a random bearing near the sector edge, nose + velocity
 * pointed inward toward the centre — a bot "warping in from outside known
 * space". The forward convention matches `World.applyInput` /
 * `HostileDroneBehaviour` (`nose = (-sin θ, cos θ)`, so the heading is
 * `atan2(-dirX, dirY)`). Position is clamped defensively even though the
 * edge fraction keeps it well inside the playable bounds.
 */
export function sectorEdgePose(rng: Rng): EdgePose {
  const bearing = rng() * Math.PI * 2;
  const r = SECTOR_PLAYABLE_HALF_EXTENT * RESPAWN_EDGE_FRACTION;
  const ex = Math.cos(bearing) * r;
  const ey = Math.sin(bearing) * r;
  // Inward unit vector (toward origin).
  const dirX = -Math.cos(bearing);
  const dirY = -Math.sin(bearing);
  const { x, y } = clampToSectorBounds(ex, ey);
  return {
    x,
    y,
    vx: dirX * RESPAWN_INBOUND_SPEED,
    vy: dirY * RESPAWN_INBOUND_SPEED,
    angle: Math.atan2(-dirX, dirY),
  };
}

/**
 * Deterministic `mulberry32` PRNG factory for tests. Same seed ⇒ same
 * stream; never used in production (production passes `Math.random`).
 */
export function makeSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
