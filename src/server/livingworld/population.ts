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
import { getSector, getNeighbours, getEntrySectors } from '../../core/galaxy/galaxy.js';
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

/**
 * Galaxy-graph hop distance (BFS depth) from `from` to `goal`. 0 when equal,
 * `Infinity` when unreachable or either sector is unknown. Pure. Used by the
 * WaveDirector to dispatch the NEAREST roaming squad toward a ready base
 * (the "review the pools, direct the nearest roaming groups" directive).
 */
export function hopDistance(from: string, goal: string): number {
  if (from === goal) return 0;
  if (!getSector(from) || !getSector(goal)) return Infinity;
  const visited = new Set<string>([from]);
  let frontier: string[] = [from];
  let depth = 0;
  while (frontier.length > 0) {
    depth++;
    const next: string[] = [];
    for (const cur of frontier) {
      for (const n of getNeighbours(cur)) {
        if (n.key === goal) return depth;
        if (visited.has(n.key)) continue;
        visited.add(n.key);
        next.push(n.key);
      }
    }
    frontier = next;
  }
  return Infinity;
}

/** A squad's wave assignment + membership — the fields the galaxy-map enemy
 *  classification needs. Structural (no SquadRecord import coupling). */
export interface WaveSquadView {
  /** The faction this squad is on a wave against, or `null` when roaming. */
  targetFactionId: string | null;
  /** The squad's member bot ids. */
  botIds: readonly string[];
}

/** A bot's live placement — `'active'` bots occupy a real sector; in-transit /
 *  respawning bots are between rooms and don't count toward any sector. */
export interface BotPlacement {
  state: string;
  sectorKey: string;
}

/**
 * Per-sector count of ACTIVE bots belonging to a HOSTILE wave — a squad with a
 * `targetFactionId`. These are the galaxy map's "enemies": faction-hostile from
 * the moment the squad is DISPATCHED (the target is assigned), tallied in
 * whatever sector each member currently occupies as the wave traverses, and
 * **independent of whether the targeted player is present** (Equinox: waves
 * attack regardless of presence — so the map must show them regardless too).
 * Roaming squads (`targetFactionId === null`) contribute nothing — they're
 * neutral until dispatched. In-transit members (not `'active'`) are excluded.
 *
 * Pure + injectable. Called on the director's ~1.5 s control tick (never the
 * 60 Hz loop), so the small allocation is fine.
 */
export function enemyBotCountsBySector(
  squads: Iterable<WaveSquadView>,
  placementOf: (botId: string) => BotPlacement | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sq of squads) {
    if (sq.targetFactionId === null) continue; // roaming ⇒ neutral
    for (const botId of sq.botIds) {
      const p = placementOf(botId);
      if (p && p.state === 'active' && p.sectorKey) {
        counts.set(p.sectorKey, (counts.get(p.sectorKey) ?? 0) + 1);
      }
    }
  }
  return counts;
}

export interface MigrationPlanInput {
  readonly sectorKeys: readonly string[];
  /** sectorKey → ALL bots physically present there (active in that
   *  sector). In-transit bots are excluded entirely (they're between
   *  rooms); arrival-cooldown bots stay here — they count toward
   *  occupancy — and are listed in `frozen` so they're never picked to
   *  move. */
  readonly current: ReadonlyMap<string, readonly string[]>;
  /** sectorKey → desired bot count (from `computeDesiredDistribution`). */
  readonly desired: ReadonlyMap<string, number>;
  /** Hard cap on transits started this control tick — keeps the warp
   *  traffic legible and avoids a thundering herd. */
  readonly maxPerTick: number;
  /** Bots present-but-not-movable (arrival cooldown). They COUNT toward
   *  their sector's occupancy (so the planner doesn't see the sector as
   *  under-supplied and over-migrate — the flapping this guards against)
   *  but are never selected as the bot to move. Absent ⇒ none frozen. */
  readonly frozen?: ReadonlySet<string>;
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
 * that stops single-bot flapping when player counts jitter). `frozen`
 * bots count toward occupancy but are never moved (arrival cooldown).
 * Pure: callers exclude in-transit bots from `current` entirely.
 */
export function planMigrations(input: MigrationPlanInput): Migration[] {
  const { sectorKeys, current, desired, maxPerTick, frozen } = input;
  const out: Migration[] = [];
  if (maxPerTick <= 0) return out;

  // Occupancy counts include frozen bots; the movable pool excludes them.
  const count = new Map<string, number>();
  const pool = new Map<string, string[]>();
  for (const k of sectorKeys) {
    const all = current.get(k) ?? [];
    count.set(k, all.length);
    pool.set(k, frozen ? all.filter((id) => !frozen.has(id)) : [...all]);
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

/**
 * The galaxy ENTRY (edge) sectors among the rooms the director actually holds.
 *
 * `getEntrySectors()` is galaxy-GLOBAL (reads `GALAXY_SECTORS`), but the
 * director may run over a subset of live rooms (a test harness boots only some
 * sectors). We intersect with `liveSectorKeys` and FALL BACK to all live
 * sectors when none of the global entry sectors are live — so a single-interior
 * test harness can't deadlock the respawn loop (it would otherwise have no legal
 * ingress sector at all). Order follows `liveSectorKeys` for determinism.
 */
export function liveEntrySectors(liveSectorKeys: readonly string[]): string[] {
  const entry = new Set(getEntrySectors().map((s) => s.key));
  const out: string[] = [];
  for (const k of liveSectorKeys) if (entry.has(k)) out.push(k);
  return out.length > 0 ? out : [...liveSectorKeys];
}

/**
 * A from-nowhere INGRESS sector for a drone "warping in from outside known
 * space" — a random live entry (edge) sector. All from-nowhere materialisation
 * (initial seed + combat respawn) routes through here, so drones never appear
 * in an interior sector out of thin air; they enter at the galaxy edge and hop
 * inward via the graph (drone-warp-in design). See {@link liveEntrySectors} for
 * the live-room intersection + single-sector fallback.
 */
export function pickEntrySector(rng: Rng, liveSectorKeys: readonly string[]): string {
  const entry = liveEntrySectors(liveSectorKeys);
  if (entry.length === 0) throw new Error('pickEntrySector: no sectors');
  const idx = Math.min(entry.length - 1, Math.floor(rng() * entry.length));
  return entry[idx]!;
}

/**
 * A slow-roam next goal: a random LIVE neighbour of `from` (a galaxy-graph
 * random walk), or `from` itself when it has no live neighbour. Idle squads
 * drift the galaxy this way between waves — the move is a real despawn→spawn
 * HOP (never a from-nowhere ingress), so it can legally land in interior
 * sectors. Restricted to `liveSectorKeys` so a squad never roams toward a sector
 * the director doesn't hold a room for. Deterministic given the RNG.
 */
export function pickRoamGoal(rng: Rng, from: string, liveSectorKeys: readonly string[]): string {
  const live = new Set(liveSectorKeys);
  const neighbours: string[] = [];
  for (const n of getNeighbours(from)) if (live.has(n.key)) neighbours.push(n.key);
  if (neighbours.length === 0) return from;
  const idx = Math.min(neighbours.length - 1, Math.floor(rng() * neighbours.length));
  return neighbours[idx]!;
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
  return edgePoseAtBearing(bearing, SECTOR_PLAYABLE_HALF_EXTENT * RESPAWN_EDGE_FRACTION);
}

/** Build an inward-facing edge pose at a specific bearing + radius (shared by
 *  `sectorEdgePose` + `squadEdgePose`). */
function edgePoseAtBearing(bearing: number, r: number): EdgePose {
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

/** Deterministic 32-bit FNV-1a string hash → stable across runs (no RNG state).
 *  Used to derive a per-squad spawn bearing so a squad's members cluster at ONE
 *  edge point instead of scattering to independent random bearings. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Angular spread (rad) of a squad's members around their shared spawn anchor.
 *  At the ~4600 u edge radius, ±0.06 rad ≈ ±275 u tangential. */
export const SQUAD_SPAWN_ANGULAR_JITTER = 0.06;
/** Radial spread (u) of a squad's members around the edge radius. */
export const SQUAD_SPAWN_RADIAL_JITTER = 250;

/**
 * Edge spawn pose for a SQUAD member. Every member of `squadKey` arriving at
 * `sectorKey` shares ONE anchor bearing (a deterministic hash of the pair), with
 * a small deterministic per-`botKey` angular + radial jitter so they don't stack
 * but still land in a ~±300 u cluster. The squad therefore "warps in together"
 * as a herd — flocking (cohesion + separation) tightens + maintains it from
 * there, instead of the old per-bot random `sectorEdgePose` that scattered a
 * squad across the entire sector edge (max gap ≈ the sector diameter, which
 * flocking then had to gather from at the slow drone cruise). Still an edge
 * spawn (radius unchanged), so the entry-only-ingress invariant is preserved —
 * only the BEARING is shared. Deterministic ⇒ no RNG, replay-safe, testable.
 */
export function squadEdgePose(squadKey: string, sectorKey: string, botKey: string): EdgePose {
  const base = (hashStr(`${squadKey}:${sectorKey}`) / 0xffffffff) * Math.PI * 2;
  const aJit = (hashStr(`${botKey}:a`) / 0xffffffff - 0.5) * 2 * SQUAD_SPAWN_ANGULAR_JITTER;
  const rJit = (hashStr(`${botKey}:r`) / 0xffffffff - 0.5) * 2 * SQUAD_SPAWN_RADIAL_JITTER;
  return edgePoseAtBearing(base + aJit, SECTOR_PLAYABLE_HALF_EXTENT * RESPAWN_EDGE_FRACTION + rJit);
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
