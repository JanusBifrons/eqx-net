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

/** Whole sector, all owners (e.g. a citadel + player bases + outposts). The
 *  A0 lattice proved 864 structures seed and run; 800 keeps margin. Shares the
 *  swarm slot pool (MAX_ENTITIES 5120) with ships, asteroids, scrap, pods. */
export const MAX_STRUCTURES_PER_SECTOR = 800;

// ── Wire (per client) ──────────────────────────────────────────────────────

/** The per-snapshot structures slice after A2 carries only fast cosmetics
 *  (turret/mining targets of in-interest firing structures). Measured today:
 *  35 278 B at the citadel. */
export const STRUCTURE_SNAPSHOT_SLICE_MAX_BYTES = 512;

/** Steady structure state patches (room-state deltas) for an idle citadel,
 *  per client. Matches the bases' steady-extra budget (baseBudgets
 *  MAX_STEADY_EXTRA_BYTES_PER_SEC = 2048) with room left for combat. */
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

/** Frame-time p99 regression allowed with a citadel on screen (mirrors
 *  baseBudgets CLIENT_FRAME_P99_REL_MAX). */
export const STRUCTURE_CLIENT_FRAME_P99_REL_MAX = 0.1;
