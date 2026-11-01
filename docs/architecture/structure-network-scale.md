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
