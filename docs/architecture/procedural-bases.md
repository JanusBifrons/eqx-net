# Procedural bases — architecture + budget ledger

> Plan: `soft-leaping-truffle` (cities · military · warehouses). This doc grows
> stage by stage. The **budget ledger** below is appended by every PR in the
> sequence: measured vs budget, so drift is visible across PRs.

## Why budgets come first

The user's directive was that each stage must stay grounded in what the game
can afford, with locked tests that stop any performance budget spiralling. So
before any base code exists, PR-B:

1. Measured today's headroom (the perf baseline, with two harness bugs fixed;
   see below).
2. Measured the dominant new cost, static geometry in physics, with
   `benchmarks/base-static-colliders.bench.ts`.
3. Wrote every budget, with its measurement, into
   `src/shared-types/baseBudgets.ts` (the single source of truth).
4. Locked the budgets against each other and against the live game in
   `tests/unit/baseBudgets.test.ts`.

**Rule:** a budget is only raised in a reviewed change that cites a new
measurement. If a stage doesn't fit, the design shrinks.

## Key measurements that shaped the design

**Static geometry must be one trimesh collider per chunk.** 25 moving ships among N static pieces (desktop):

| N pieces | per-piece colliders: step / 20-tick replay | trimesh per chunk: step / 20-tick replay |
|---|---|---|
| 0 | 0.05 / 1.0 ms | 0.05 / 1.0 ms |
| 1,000 | 0.15 / 3.4 ms | 0.08 / 1.5 ms |
| 4,000 | 0.77 / 14 ms | 0.11 / 2.1 ms |
| 8,000 | 1.20 / 27 ms | 0.14 / 2.5 ms |

Static colliders are not free: the broad-phase tracks every collider proxy.
Grouping cuboids under one body per chunk did not help. Only collapsing each
chunk into a single trimesh collider (with its own internal BVH) did. The
client's prediction replays ~20 ticks per snapshot, and mobile is ~4× slower,
so per-piece colliders would have cost a phone ~50 ms per snapshot.

**Tunnelling is solved by soft CCD, not wall thickness (PR-C).** Ship movement
had no swept test. A body whose centre crossed a wall's midline within one step
was ejected out the far side, and shields-down hulls tunnelled even 76 u walls
at 2× top speed. Rapier soft CCD (`SOFT_CCD_PREDICTION = 48`) on every dynamic
body gives zero pass-throughs on 16 u walls for ≤ 0.06 ms per step.
`MIN_WALL_THICKNESS` is therefore a visual floor (16 u).

**Server headroom is large; mobile client frames are the constraint.** See the
baseline table in `baseBudgets.ts`. The server averages ~0.5–1.2 ms of its
16.67 ms tick. The 25-drone room already shows bad mobile frame spikes (p99
600 ms). That is pre-existing and unrelated to bases, but bases must not make it
worse. Wall-clock gates are therefore relative to a same-session baseline arm.

## Harness bugs fixed in PR-B

The perf baseline spec had silently been recording nothing useful:

- **Server tick time.** It parsed a top-level `total` field the server never
  emits (the real shape is `avgMs.total` + `maxTotalMs`), so every capture had
  0 tick samples. The global `/dev/events` ring also mixes ~21 galaxy rooms.
  Fixed with the pure, unit-locked `parseTickBudgetEvent`, filtered to the room
  with the live player, and drained every 5 s.
- **Client frame time.** It came from the diag-only log ring, which is empty on
  the production path the gate must measure (`?diag=0`). Fixed with a page-side
  rAF sampler.
- Both are now **hard** preconditions: an empty capture fails instead of writing
  nulls.

## Lock tiers (every stage)

1. **Deterministic** (`pnpm test`): budget consistency, generator-output sweeps
   (pieces, chunks, Tier B, bytes), wire bytes from the real encoders, op
   counts, zero-allocation `heapDelta` tests, game-design locks (corridors,
   reachability, CCD coverage, roam-ring keep-out).
2. **Bench** (`pnpm bench`): generator ms, step/replay overhead,
   `rayFirstPiece`, chunk cull.
3. **Wall-clock** (`pnpm e2e:perf`, same-session baseline arm): server tick,
   client frame p99, heap slope, bytes/s.

## Budget ledger

| Stage / PR | Pieces (max base) | Step overhead (ms) | 20-tick replay overhead (ms) | Server tick added (ms) | Frame p99 Δ | Wire join (B/base) | Notes |
|---|---|---|---|---|---|---|---|
| Budget | ≤ 4000 | ≤ 0.25 | ≤ 2.5 | ≤ 1.0 | ≤ +10 % | ≤ 1024 | from `baseBudgets.ts` |
| PR-B (harness) | — | 0.09 (8k trimesh, bench) | 1.5 (8k trimesh, bench) | — | — | — | baseline captured; no base code yet |
| PR-C (soft CCD) | — | ≤ +0.06 (100 ships + 4k) | — | — | — | — | tunnelling: 0 at 16 u walls |
| Generator core (warehouse) | 223 worst (800-layout sweep) | — (no runtime yet) | — | — | — | — | 21 pieces/chunk worst, 4.2 KB layout, 0.88 ms generate (p99 2.1), ≤ 3 re-seeds, ≥ 80 % first-attempt validity |

## Generator (`src/core/procgen/`)

- `rng.ts`: integer-only mulberry32 streams, one per sub-generator (`stream(seed, name)`).
- `baseLayout.ts`: flat typed-array layout. Pieces are split at chunk lines, with a stable `layoutHash` and `BASE_GENERATOR_VERSION`.
- `archetypes/warehouse.ts`: aisle carving.
  - perimeter wall with 2–4 gates and loading bays lined with container stacks;
  - main cross-aisles every ~3000 u;
  - double-depth rack rows in ONE seeded direction (about 1 zone in 8 turns 90° as an accent);
  - rows trimmed, not dropped, around bay keep-outs.
- `validate.ts`: budgets, thickness, bounds, and **fly-through**. A coarse 32 u occupancy grid gets a 3-4 chamfer distance transform, then a flood fill from outside the base. Every cell with enough clearance for the largest flyable ship must be reachable. The same grid seeds the obstacle field for PR-N roaming.
- `generateBase.ts`: generate-then-curate, with deterministic re-seeds (`hash(seed, attempt)`, cap 8).
- **Locks** (`generateBase.test.ts`): determinism, origin-independence, version check, pinned hashes, a 200-seed × 4-size budget sweep, and a first-attempt-quality floor. Bench: `benchmarks/base-generator.bench.ts`.

Visual review notes (for the kit / visual pass):
- 8000 u warehouses read well: dense parallel rows.
- Below ~5000 u the double-depth racks leave zones sparse. Scale rack depth with footprint.
- Small footprints form sealed pockets between a bay's container column, the wall and a row end. The validator rejects them (min size 4000). Carve them at the source.
