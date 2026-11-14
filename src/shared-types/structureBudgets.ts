/**
 * Structure-network scale budgets (plan soft-leaping-truffle v2).
 *
 * Bases are built from REAL structures, so a citadel is ~400 of them. Every
 * number here is either a design ceiling or a cost budget DERIVED from the A0
 * measurement (tests/integration/sectorRoom/structureScale.measure.test.ts →
 * diag/structure-scale/a0-measure.json, and benchmarks/structures-scale.bench.ts).
 * Ledger: docs/architecture/structure-network-scale.md.
 *
 * RULE (root CLAUDE.md budget rule): a budget is raised only by a reviewed
 * change citing a NEW measurement — never widened to get green. Over budget ⇒
 * make each structure cheaper (wire / CPU / render). Do NOT reach for bigger
 * consolidated kinds to cut the count: scale is the point.
 *
 * A0 baseline (dev box, 2026-11-01; "citadel" = the 400-lattice + fence = 448
 * structures, 44 turrets, 300 drones in the sector):
 *   structures[] slice     35 278 B per snapshot (78.7 B/row) → 689 KB/s per client
 *   (outpost, 46 structures:  3 524 B → 69 KB/s — already above the whole
 *    per-client baseline of ~58 KB/s)
 *   binary full refresh    448 × 34 B × 1 Hz = 15 KB/s per client
 *   turret tick            5.1 ms median / 12.6 ms max per 10 Hz invocation
 *   grid pulse             1.2 ms median / 2.5 ms max per 1 Hz invocation
 *   slice rebuild          0.24 ms median (×11/s)
 *   Grid.route uncached    0.94 ms (448) / 2.7 ms (864) — per route, cache
 *                          wiped by every topology change
 */

/** Largest base (citadel tier). The generator's sweep must stay ≤ this. */
export const MAX_STRUCTURES_PER_BASE = 400;

/** Whole sector, all owners (e.g. a citadel + player bases + outposts).
 *  Phase V (large footprints): a fenced lattice stays inside the ±5000 u
 *  sector up to 664 structures (n = 600 + fence) — re-measured and lowered
 *  800 → 650. Shares the swarm slot pool (MAX_ENTITIES 5120) with ships,
 *  asteroids, scrap, pods. */
export const MAX_STRUCTURES_PER_SECTOR = 650;

/** All NPC bases in one galaxy sector together, counted by each tier's
 *  structure ceiling (`TIER_MAX_STRUCTURES`). Set to the N = 400 point the
 *  join-payload budget (`STRUCTURE_JOIN_MAX_BYTES`) was measured at, leaving
 *  the rest of `MAX_STRUCTURES_PER_SECTOR` for players' bases. */
export const NPC_STRUCTURES_PER_SECTOR_MAX = 400;

// ── Wire (per client) ──────────────────────────────────────────────────────

/** The per-snapshot structures slice after A2 carries only fast cosmetics
 *  (turret/mining targets of in-interest firing structures). Measured today:
 *  35 278 B at the citadel. */
export const STRUCTURE_SNAPSHOT_SLICE_MAX_BYTES = 512;

/** Added steady-state downstream bytes/s per client with a full NPC base in
 *  the sector and nothing being destroyed. The ceiling the idle-patch and
 *  binary budgets below must fit under (carried over from the retired Tier A
 *  base budget). */
export const STRUCTURE_STEADY_EXTRA_MAX_BYTES_PER_SEC = 2048;

/** Steady structure state patches (room-state deltas) for an idle citadel,
 *  per client. Half the steady-extra ceiling, leaving room for combat. */
export const STRUCTURE_PATCH_IDLE_MAX_BYTES_PER_SEC = 1024;

/** Structure patches while the citadel is under sustained fire (hp/shield
 *  changes on ~30 hits/s). */
export const STRUCTURE_PATCH_COMBAT_MAX_BYTES_PER_SEC = 4096;

/** One-time join payload for a citadel's structure state (≈ 400 rows). */
export const STRUCTURE_JOIN_MAX_BYTES = 25 * 1024;

/** Binary pose channel: sleeping, out-of-interest structures must not be
 *  re-sent every second. Measured today: 15 232 B/s at the citadel. */
export const STRUCTURE_BINARY_MAX_BYTES_PER_SEC = 2048;

// ── Server CPU (main thread; timers run between 60 Hz ticks) ────────────────

/** One turret-tick invocation (10 Hz) at the citadel with 300 drones. A
 *  callback longer than ~1 ms delays the next physics tick. Today 5.1 / 12.6 ms. */
export const TURRET_TICK_MAX_MS = 1.0;

/** One grid-pulse invocation (1 Hz) at the citadel, including a topology
 *  change (route recompute). Today 1.2 median / 2.5 max with a warm cache. */
export const GRID_PULSE_MAX_MS = 2.0;

/** Recompute of every route from the capital after a topology change, at the
 *  citadel. Today one uncached A* route alone is 0.94 ms. */
export const GRID_ROUTES_REBUILD_MAX_MS = 0.5;

// ── Client ─────────────────────────────────────────────────────────────────

/** A3 — the client prediction world carries a structure (or shield wall)
 *  body only while its EDGE is within this distance of the local ship. Every
 *  server correction replays ~20 physics ticks; with a whole citadel in the
 *  prediction world (456 structures) that replay measured 2.36 ms median /
 *  5.1 ms p95 on a desktop (~4× that on a phone), against 0.16 ms with none
 *  and 0.31 ms with only the structures within 1500 u. Ships move < 50 u
 *  between swarm packets and predicted weapons reach ≤ 325 u, so 1500 u is
 *  ample. Measured by src/core/physics/World.structureStreaming.test.ts. */
export const PREDWORLD_STRUCTURE_RADIUS = 1500;
/** Extra distance before a streamed-in structure body is released again, so
 *  a ship hovering at the edge doesn't churn bodies. */
export const PREDWORLD_STRUCTURE_HYSTERESIS = 300;
/** Wreck pieces (swarm kind 4) get their own, smaller prediction radius: at
 *  the structure radius most of a pile still had a predWorld body and the
 *  predWorld step was 23 % of the client main thread (decisive soak,
 *  2026-11-13). Measured as the GAP between hulls: piece edge to the local
 *  hull's edge (ColyseusClient.syncSwarmIntoPredWorld subtracts both radii).
 *  A piece only matters to prediction where the local ship can touch it
 *  during a reconcile replay, or a predicted weapon can reach it (<= 325 u).
 *  Why 600 u is safe (shipping 2x scale):
 *   - Fastest playable ship: havok, maxSpeed 850 u/s. Boost adds thrust only;
 *     applyShipInput still clamps at maxSpeed x the topSpeed stat.
 *   - Fully levelled (LEVEL_CAP 10 => 9 points, +5 % each): 1232.5 u/s.
 *   - A correction replays ~20 ticks (1/3 s): 283 u un-levelled, 411 u
 *     levelled. Both well inside 600 u; the set is re-checked on every swarm
 *     packet, and a piece already in keeps its body out to 600 + 300 u.
 *   - The hull is not part of the budget: a 2x crossguard's radius is 213 u,
 *     which is why the gap, not the centre distance, is used.
 *  Not covered: a stall that fills the 128-tick input ring (~2.1 s) replays
 *  further than any radius short of the sector (a rubber-band anyway), and
 *  warp cruise (20,000 u/s). Locked by tests/unit/wreckPredCost.test.ts. */
export const PREDWORLD_WRECK_RADIUS = 600;

/** Frame-time p99 regression allowed with a citadel on screen. */
export const STRUCTURE_CLIENT_FRAME_P99_REL_MAX = 0.1;
