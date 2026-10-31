/**
 * Procedural-bases BUDGETS — the single source of truth every base stage is
 * locked against (plan: soft-leaping-truffle, "Budget lock").
 *
 * Rules (the user's directive: "stay grounded … locked grounded testing …
 * don't spiral the budgets"):
 *  - Every number carries the MEASUREMENT or DESIGN reason it came from.
 *  - A budget is only ever RAISED in a reviewed change that cites a NEW
 *    measurement. Never widen one to get green — shrink the design instead
 *    (fewer pieces, bigger chunks, smaller base).
 *  - Deterministic locks (counts / bytes / allocations) read these constants
 *    directly; bench + wall-clock gates read the timing ones.
 *  - The budget ledger (measured vs budget per stage) lives in
 *    `docs/architecture/procedural-bases.md`.
 *
 * Measurement provenance (2026-10-31, desktop, quiet host):
 *  - `benchmarks/base-static-colliders.bench.ts` — 25 thrusting ships inside an
 *    8000 u square of N static cuboid pieces:
 *      body-per-piece   N=0 / 1k / 4k / 8k → step 0.05 / 0.15 / 0.77 / 1.20 ms,
 *                                            20-tick replay 1.0 / 3.4 / 14 / 27 ms
 *      body-per-chunk   (≈ same as body-per-piece — chunking bodies does NOT help)
 *      trimesh-per-chunk N=0 / 1k / 4k / 8k → step 0.05 / 0.08 / 0.11 / 0.14 ms,
 *                                            20-tick replay 1.0 / 1.5 / 2.1 / 2.5 ms
 *    ⇒ static colliders are NOT free (the broad-phase tracks every collider
 *      proxy); ONE solid trimesh collider per chunk is ~10× cheaper and nearly
 *      flat in N. Tier A geometry MUST use the trimesh-per-chunk layout.
 *  - `tests/perf/perf-baseline.spec.ts` — server tick + client frame headroom
 *    of today's game (see SERVER_/CLIENT_ budgets below).
 */

// ── Tier A: static seed-derived geometry ─────────────────────────────────────

/** Side of a spatial chunk (u). One fixed body + one trimesh collider + one
 *  retained render `Graphics` per chunk. 1024 keeps a destroy-triggered chunk
 *  rebuild small and gives ≤ 8×8 chunks across the largest (8000 u) base. */
export const BASE_CHUNK_SIZE = 1024;

/** Max Tier A pieces in ONE base. 4000 trimesh pieces measured +0.06 ms/step
 *  and +1.1 ms per 20-tick replay over an empty world (desktop). */
export const MAX_PIECES_PER_BASE = 4000;

/** Max Tier A pieces summed over every base in ONE sector. 8000 trimesh pieces
 *  measured +0.09 ms/step, +1.5 ms per 20-tick replay (desktop). */
export const MAX_PIECES_PER_SECTOR = 8000;

/** Max pieces in one chunk — bounds the cost of rebuilding a chunk's trimesh
 *  when a piece is destroyed (rare, event-driven) and the per-chunk draw. */
export const MAX_PIECES_PER_CHUNK = 512;

/** Bench gate: added server/predWorld step cost (ms, desktop, 25 moving
 *  ships) of a max-sector base field over an empty world. Measured 0.09;
 *  budget leaves ~2.5× headroom for real (non-rack) archetype geometry. */
export const STEP_OVERHEAD_MS_MAX = 0.25;

/** Bench gate: added cost (ms, desktop) of a 20-tick predWorld replay burst
 *  (≈ one reconcile at ticksAhead 20). Measured 1.5 at a max sector. */
export const REPLAY20_OVERHEAD_MS_MAX = 2.5;

/** Client predWorld only instantiates base chunks within this radius of the
 *  local ship (chunk streaming). Ships at ≤ 950 u/s cross < 1 chunk per second,
 *  so a 2-chunk margin is ample; mobile CPU is ~4× desktop, so the client must
 *  not carry a whole sector of colliders into every replay. */
export const PREDWORLD_ACTIVE_RADIUS = 2048;

/** Max pieces the client predWorld may hold at once (the active set). */
export const MAX_CLIENT_ACTIVE_PIECES = 2000;

/** Layout memory per base: pieces stored as flat typed arrays
 *  (kind u8, x/y/w/h i32, rot u8, chunk u16 ≈ 20 B) → 4000 × 20 = 80 KB. */
export const MAX_LAYOUT_BYTES_PER_BASE = 128 * 1024;

/** Generator wall time for one max-size base (desktop). It runs once at room
 *  create (server) and once per join/chunk-stream on the client worker. */
export const GENERATE_MS_MAX = 50;

// ── Tier B: live entities (turrets, shield gens, hangars, patrols) ────────────

/** Every Tier B entity is a swarm slot + Rapier body + a `structures[]` /
 *  `drones[]` snapshot row. 40 keeps a full NPC base well under the 5120-slot
 *  pool and the JSON slice small. */
export const MAX_TIER_B_PER_BASE = 40;
export const MAX_TIER_B_PER_SECTOR = 80;

// ── Wire ─────────────────────────────────────────────────────────────────────

/** Room-state bytes a joiner receives per base (descriptor + destroy mask). A
 *  4000-piece mask is 125 u32 words = 500 B; the descriptor is ~60 B. */
export const MAX_BASE_JOIN_BYTES = 1024;

/** Bytes per destroyed-piece room-state delta. */
export const MAX_DESTROY_DELTA_BYTES = 16;

/** Added steady-state downstream bytes/s per client with a full NPC base in
 *  the sector and nothing being destroyed (Tier B slice + live entities). */
export const MAX_STEADY_EXTRA_BYTES_PER_SEC = 2048;

// ── Render ───────────────────────────────────────────────────────────────────

/** Chunks drawn in one frame. Below `BASE_LOD_ZOOM` a single silhouette
 *  Graphics replaces the chunks, so this bounds the zoomed-in case. */
export const MAX_VISIBLE_CHUNKS = 24;

/** Zoom below which a base renders as one low-detail silhouette. At zoom 0.4 a
 *  1280 px viewport spans ~3200 u (≈ 3×3 chunks + margin). */
export const BASE_LOD_ZOOM = 0.4;

// ── Game design (grounded to the ship catalogue + physics) ───────────────────

/** Minimum wall/piece thickness (u). CCD is off. The fastest flyable ship at
 *  max topSpeed upgrade moves ~23 u per tick (maxSpeed clamp × 1.45 / 60), and
 *  walls keep a 2× margin over that. A first draft said 40 from an assumed
 *  ~16 u/tick; the consistency lock measured the catalogue and caught it. */
export const MIN_WALL_THICKNESS = 48;

/** Corridor clearance multiple of the largest player-flyable ship radius
 *  (`engineeringOnly` kinds excluded). The lock test derives the absolute
 *  minimum from the live catalogue, so a bigger flyable ship forces a review. */
export const CORRIDOR_RADIUS_MULTIPLE = 6;

/** Absolute floor on corridor width (u) — the bench aisle was 160 u. */
export const MIN_CORRIDOR_WIDTH = 160;

/** Max base extent (u) in a live galaxy sector. A base footprint is a DISC of
 *  diameter `size`. Roaming squads fly legs on the radius-2000 ring
 *  (`FORMATION_DEST_RANGE`) and have no static-obstacle avoidance, so a
 *  sector-centred base must stay inside (ring − ROAM_RING_KEEPOUT_MARGIN):
 *  2 × (2000 − 400) = 3200. (A first draft said 5000 — the consistency lock
 *  caught that it straddles the roam ring.) */
export const GALAXY_BASE_MAX_SIZE = 3200;

/** Max base extent (u) in showcase rooms (user choice: "up to ~8000").
 *  Showcase rooms run no roaming squads, so only the ±5000 bound applies. */
export const SHOWCASE_BASE_MAX_SIZE = 8000;

/** Radius of the ring roaming squads fly (`FORMATION_DEST_RANGE`); galaxy base
 *  footprints must not cross the ring band ± this margin. */
export const ROAM_RING_KEEPOUT_MARGIN = 400;

// ── Wall-clock headroom (tests/perf, same-session baseline arm) ──────────────
//
// Baseline 2026-10-31 (`pnpm e2e:perf tests/perf/perf-baseline.spec.ts`, fixed
// harness — see docs/LESSONS.md 2026-10-31 for the two harness bugs that made
// every earlier capture record null frame times and zero tick samples):
//
//   scenario / arm                 frame p50/p99 (ms)   server tick avg/max (ms)
//   sol-prime-ambient / desktop        16.7 / 16.8          0.49 / 18.9
//   sol-prime-ambient / mobile-4×CPU   16.7 / 33.4          0.46 / 21.5
//   feel-test-25 / desktop             16.7 / 83            1.15 / 120
//   feel-test-25 / mobile-4×CPU        16.7 / 600           0.98 / 449
//
// The server uses ~1 ms of its 16.67 ms tick on average. The 25-drone room
// already shows bad mobile frame spikes — PRE-EXISTING, unrelated to bases;
// bases must not make them worse, so these gates are RELATIVE to a baseline
// arm captured in the same session (the netgate philosophy), never absolute.

/** Server: added mean tick ms with a max base sector vs the empty-room arm. */
export const SERVER_TICK_ADDED_MS_MAX = 1.0;

/** Client: allowed relative growth of frame-time p99 vs the baseline arm. */
export const CLIENT_FRAME_P99_REL_MAX = 0.1;

/** Client: allowed growth of heap slope (MB/s) vs the baseline arm. */
export const CLIENT_HEAP_SLOPE_ADDED_MB_PER_SEC_MAX = 0.05;
