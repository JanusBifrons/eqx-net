# Structure network at base scale: measurements and budget ledger

Plan: `soft-leaping-truffle` v2. NPC bases are built from real structures (Capital, Connectors, Solars, Batteries, Shield Pylon fences, Cargo Bays, Turrets), so they are bound by the same building rules a player follows. Most bases are modest outposts of about 10–30 structures. A citadel in the core sector of a major power is about 400.

This page records what the structure system costs at that scale, and the budget each phase must meet. Every budget number lives in [`src/shared-types/structureBudgets.ts`](../../src/shared-types/structureBudgets.ts).

## How it is measured (A0)

**The lattice.** [`buildStructureLattice`](../../src/core/structures/structureLattice.ts) builds a valid base of N structures:
- a Capital at the centre;
- a grid of Connector hubs (a vertical spine plus row chains);
- 2–3 leaves per connector (a Solar / Battery / Cargo Bay / Turret mix, with Solars added until the base is powered);
- a closed Shield Pylon fence, tapped into the row ends.

`structureLattice.test.ts` checks every placement and every link against the real `placementRejection` and `canConnect`, and checks that everything reaches the Capital.

**The room.** The testMode room option `scaleGrid {n, seed, fence}` seeds that lattice server-side, so it isn't limited by the 64-entry seed cap. It places structures with `skipAutoConnect` and applies the lattice's links through `connectExplicit`, which re-checks the real rule.

**The measurement test.** [`tests/integration/sectorRoom/structureScale.measure.test.ts`](../../tests/integration/sectorRoom/structureScale.measure.test.ts) boots real rooms at N = 30 / 100 / 400 / 800 with 300 drones, then measures:
- the grid pulse, turret tick and snapshot-slice rebuild, through `_internals`;
- the structures slice packed with the real `@colyseus/msgpackr` encoder.

It writes `diag/structure-scale/a0-measure.json`.

**The bench.** [`benchmarks/structures-scale.bench.ts`](../../benchmarks/structures-scale.bench.ts) covers the parts of the pure Grid that grow with N.

## A0 results (dev box, 2026-11-01)

| N (lattice) | Structures (+fence) | Turrets | Slice per snapshot | Slice per client | Binary full refresh | Turret tick (median / max) | Grid pulse (median / max) | Slice rebuild |
|---|---|---|---|---|---|---|---|---|
| 30 | 46 | 3 | 3,524 B | 69 KB/s | 1.6 KB/s | 0.41 / 1.5 ms | 0.33 / 0.55 ms | 0.11 ms |
| 100 | 132 | 11 | 10,119 B | 198 KB/s | 4.5 KB/s | 1.2 / 6.9 ms | 0.81 / 1.2 ms | 0.11 ms |
| 400 | 448 | 44 | 35,278 B | 689 KB/s | 15 KB/s | 5.1 / 12.6 ms | 1.2 / 2.5 ms | 0.24 ms |
| 800 | 864 | 89 | 68,482 B | 1,338 KB/s | 29 KB/s | 7.8 / 35.8 ms | 2.3 / 9.6 ms | 0.40 ms |

Core Grid bench results:

| Operation | 448 structures | 864 structures |
|---|---|---|
| Uncached route (Capital → farthest) | 0.94 ms | 2.7 ms |
| `Grid.rebuild` | 0.10 ms | 0.16 ms |
| Placement legality sweep (`canConnect` against all N) | 0.06 ms | 0.11 ms |

### What this says

1. **The structures slice is the biggest problem.**
   - It costs about 79 B per structure, and every row goes to every client in every 20 Hz snapshot.
   - A 46-structure outpost already adds 69 KB/s per client, more than the whole per-client baseline (about 58 KB/s for 4 players and 100 drones).
   - A citadel adds 689 KB/s per client, 4× the WebRTC degrade threshold per snapshot.
   - The fix is A2: move structure state into Colyseus room state (sent once on join, then delta patches), and keep only fast cosmetics in the snapshot.
2. **Turret targeting is the CPU problem.**
   - It is O(turrets × all swarm entities) every 100 ms.
   - The citadel takes 5 ms per tick, with 12.6 ms spikes. That runs on the main thread between 60 Hz physics ticks, so it delays them.
   - The fix is A1: a per-tick combatant grid, with each turret querying only nearby cells.
3. **Routing spikes after damage.**
   - Every topology change (any structure destroyed) wipes the route cache.
   - Each damaged structure then re-runs A* (0.94 ms per route at the citadel). A fight that breaks a few structures could spike the pulse by tens of ms.
   - The fix is A1: one shortest-path tree from each Capital per topology change, O(V+E).
4. **These are fine today:**
   - Grid rebuild and the placement sweep: no line-of-sight broadphase is needed.
   - The steady 1 Hz pulse.
5. **The binary pose channel** resends every structure once a second (15 KB/s at the citadel). The fix is A2: decimate the full refresh for sleeping, out-of-interest structures.

## Budget ledger

Each phase appends a row with its measured numbers against the budgets in `structureBudgets.ts`.

| Stage | Slice B/snapshot (citadel) | Patch B/s idle / combat | Join B | Binary B/s | Turret tick ms | Pulse ms | Notes |
|---|---|---|---|---|---|---|---|
| Budget | ≤ 512 | ≤ 1024 / ≤ 4096 | ≤ 25,600 | ≤ 2048 | ≤ 1.0 | ≤ 2.0 (routes ≤ 0.5) | `structureBudgets.ts` |
| A0 (today) | 35,278 | n/a (no patches) | ~0 | 15,232 | 5.1 / 12.6 max | 1.2 / 2.5 max | Baseline; no behaviour change |
| A1 (server cost) | 35,278 (A2) | n/a (A2) | ~0 | 15,232 (A2) | ~1.7 (parts: slice rebuild 1.07, firing + targeting 0.35, walls 0.25) | routes: one BFS per source, ~0.17 ms incl. rebuild | Targeting 4× faster in a same-run A/B; slice rebuild is now the dominant turret-tick cost and the GC-spike source; A2 removes it |

| A2 (wire split) | ~0 (targets only) | 733 / 1,825 | 16,711 | ~3,000 worst case (out of interest, every 5th refresh) | 0.82 | (A1) | Measured at 448 structures (loaded host) |

## A2: structure state moved to room state

**Before.** Every structure's full row rode every 20 Hz snapshot to every client: ~79 B × N × 20 Hz.

**Now.** Structure grid state lives in Colyseus room state, `SectorState.structures` keyed by entityId.
- **Delivery:** it arrives once in the join payload, then as delta patches.
- **Schema:** `StructureState` is quantised. hp is a 0–100 percent; flags pack built / powered / deconstructing / wall-active.
- **Unset defaults:** fields have no initialisers. A field still at its default is never assigned, so it is never encoded, and the decoder supplies `STRUCTURE_DEFAULTS`.
- **Owners:** interned once per sector (`structureOwners` / `structureOwnerNames` plus a per-row `ownerIdx`).
- **Snapshot:** keeps only the fast cosmetics as flat `structureTargets` triples (turret / mining targets), sent only while some structure has a target.

**Binary pose channel.** A sleeping, out-of-interest structure now rides only every 5th full refresh, once per 5 s instead of every second. Room state now owns a structure's lifetime on the client: the decoder's full-refresh sweep no longer deletes structures, and `syncStructures` drops the pose entry when the row goes.

**Client.** It decodes rows in place into the unchanged `mirror.structures` shape (`structureStateDecode.ts`), so the renderer, inspector and E2E hooks are untouched.

**Locks:**
- `tests/integration/wire/structureStateWire.test.ts`: real schema encode/decode round trip, server row → client mirror row (#15).
- `tests/integration/sectorRoom/structureRoomState.test.ts`: the join payload carries every row, a hit patches live clients, a late joiner reads the changed value, and removal reaches everyone (#16).
- `BinarySwarmBroadcast.test.ts` and `BinarySwarmDecoder.test.ts`: structure decimation, and structures survive a full refresh.

**Measured at 448 structures:**

| Measure | Before | After | Budget |
|---|---|---|---|
| Snapshot structure bytes | 35,278 B | ~0 | — |
| Join payload | 0 | 16.7 KB | 25 KB |
| Idle patches | 0 | 733 B/s | — |
| Patches under ~30 hits/s | 0 | 1.8 KB/s | — |

`_internals.getStructuresSlice` now returns the old per-structure row shape rebuilt from room state, so the existing structure integration tests read the same fields.

## A1: what changed and what the measurement corrected

**Turret targeting.** The server now builds one [`NearestPointGrid`](../../src/core/spatial/NearestPointGrid.ts) (512 u cells) of turret-targetable drones per turret tick. It is rebuilt after any eviction, so a kill mid-tick can't leave a dead drone selectable. Each turret then queries only the cells its range covers.
- **Same result as before.** It picks the same winner as the old linear scan, including exact ties and the inclusive range edge (20,000-query parity test).
- **No allocation.** A heap-delta test confirms it.
- **Op-count lock.** A 900 u query examines ≤ 5 % of the points.

**Routes.** `Grid.route` now reads a cached shortest-hop tree, one BFS per source per topology change. Previously every route ran its own A* with a linear open-set scan. The rules are unchanged: paths only step through built nodes, and an unbuilt node can be a destination. `Grid.routeCost.test.ts` locks one search per source by counting adjacency reads: ≤ 1.1 × V, against 37,921 on the old code at 448 structures.

**Correction to A0.** A0 attributed the 5 ms turret tick to the O(turrets × entities) target scan. Profiling the tick's parts showed otherwise.

| Part of the turret tick (citadel, loaded host) | Median |
|---|---|
| Slice rebuild | 1.07 ms |
| Firing + targeting | 0.35 ms |
| Shield-wall upkeep | 0.25 ms |
| Miners | ~0 |

- The slice rebuild allocates a row object and a `connTo` array per structure every 100 ms. It is also the source of the 20–30 ms GC spikes.
- In a same-run A/B (`benchmarks/structures-scale.bench.ts`), the old scan costs only ~0.09 ms for 44 turrets × 750 entities, and the grid is 4× faster.
- So the A2 wire split, which removes the 10 Hz slice rebuild, matters more than targeting did.
- A shield-wall index was planned for A1 but is not needed at these numbers.

**Measurement note.** These A1 numbers were taken while another session ran a game server and a Playwright recording on the same machine (CPU ~64 %). The medians are noisy, so the locks are deterministic op counts and same-run A/B benches, not absolute times.
