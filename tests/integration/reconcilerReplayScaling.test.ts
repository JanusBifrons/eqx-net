/**
 * Reconciler relevance-culled-replay SCALING regression lock (Option A).
 *
 * Origin: phone smoke-test diag 2026-05-16 `a3f5na` — 116–266 ms client
 * frame stalls on a sector change with only ~25 drones, while the
 * architecture's design target is ~500 in a sector (server proven: 33
 * swarm + 25 AI at 1.19 ms/tick). Measured root cause: `Reconciler`'s
 * uncapped replay loop re-ticks every drone's `HostileDroneBehaviour`
 * brain per replayed tick (`perReplayTick → tickClientAi`) → the
 * O(ticksAhead × N) cost — ~48 ms at ticksAhead=48 / N=500 (≈3× the
 * 16.67 ms frame budget). NOT object count, NOT throttleable.
 *
 * Shipped fix (Option A, 2026-05-17): relevance-culled re-sim. Only the
 * NEAR drones (`partitionDronesByRelevance`) are brain-re-simmed via
 * `AiController.tickOnly(NEAR)`; the FAR majority is **dead-reckoned, NOT
 * frozen** — `replaySeed` re-anchors them, the unfrozen replay
 * `world.tick()` integrates them ballistically. (A *freeze* of FAR was
 * built first and rejected: it regressed the quiet-host canary
 * `swarmSnapP50` 11→20 — a frozen body is held a whole snapshot interval
 * while `_droneSnapshotAnchored` gates off the binary correction. See
 * `docs/architecture/reconciler-replay-scaling.md` §9 + LESSONS 2026-05-17.)
 *
 * The bug LIVES in `Reconciler.reconcile`'s loop, so the lock exercises
 * that exact path with a real `PhysicsWorld` + N drones via the real
 * `AiController.tickOnly` (no browser). `vitest bench` is repo-wide
 * broken under vitest 2.x (0 samples even for the pre-existing
 * physics-tick.bench.ts — tracked LESSONS 2026-05-17), so this is a
 * `performance.now()` assertion test — a better lock anyway (runs in
 * `pnpm test:integration` and gates). Thresholds are RATIO-based +
 * same-env, so the lock is host-load-robust; reverting the cull collapses
 * the ratio and re-fails (invariant #13).
 */
import { test, expect } from 'vitest';
import { PhysicsWorld } from '../../src/core/physics/World.js';
import { Reconciler, type InputRecord } from '../../src/core/prediction/Reconciler.js';
import { AiController, type AiIntentSink } from '../../src/core/ai/AiController.js';
import { HostileDroneBehaviour } from '../../src/core/ai/HostileDroneBehaviour.js';
import {
  partitionDronesByRelevance,
  DRONE_RESIM_BUDGET,
  type DroneRelevanceInput,
} from '../../src/core/prediction/droneRelevance.js';
import type { AiEntity, AiPlayerView } from '../../src/core/contracts/IAiBehaviour.js';
import type { ShipPhysicsState } from '../../src/core/physics/World.js';
import { getShipKind, SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';

const K = getShipKind(SHIP_KINDS_LIST[0]!.id);
const PLAYER = 'local';
const NOOP_SINK: AiIntentSink = { postIntent(): void {} };
const PLAYERS: ReadonlyArray<AiPlayerView> = [{ id: PLAYER, x: 0, y: 0, vx: 0, vy: 0 }];
const TICKS_AHEAD = 48; // the stall-window lookahead the capture observed
const N = 500; // the architecture's design target — must scale to this

const dkey = (i: number): string => `swarm-${i}`;

function median(fn: () => void, runs = 4, warmup = 1): number {
  for (let i = 0; i < warmup; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  return xs[xs.length >> 1]!;
}

function loadInputs(rec: Reconciler): void {
  for (let t = 1; t <= TICKS_AHEAD; t++) {
    const input: InputRecord = { tick: t, thrust: true, turnLeft: false, turnRight: false, sentAt: performance.now() };
    rec.recordInput(input);
  }
}

const serverState: ShipPhysicsState = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };

/**
 * Option A (2026-05-17, diag a3f5na) — relevance-culled replay, NO freeze.
 *
 * The expensive part of the chapter-2 Phase C replay re-sim is
 * `HostileDroneBehaviour.tick` per drone per replayed tick; the cheap part is
 * Rapier integrating the body. Option A culls only the EXPENSIVE brain:
 * `AiController.tickOnly(NEAR)` re-sims the k drones the player can perceive;
 * the FAR majority is **dead-reckoned, NOT frozen** — `replaySeed` re-anchors
 * every in-interest drone, then the (unfrozen) replay `world.tick()`
 * integrates them ballistically. A *freeze* of the FAR set was implemented
 * first and rejected: it regressed the quiet-host `feel-test-lockstep` canary
 * (`swarmSnapP50` 11→20, `swarmAngleP99` 0.1→1.2) because a frozen body is
 * held a whole snapshot interval while `_droneSnapshotAnchored` gates off the
 * binary correction (LESSONS.md 2026-05-17). Dead-reckon keeps the linear
 * motion; only the AI curve over the window is lost — small for a stable far
 * drone.
 *
 * Contract is RATIO-based + host-robust (same philosophy as the blanket lock
 * above — every measurement is in this same env so load cancels):
 *
 *   (a) culled ≪ all-brain  — culling the brain re-sim is a ≥2.5× win.
 *   (b) culled ≲ zero-brain-floor × 2.0 — Option A pays only a BOUNDED
 *       premium (the k brain ticks) over the k=0 dead-reckon floor.
 *       Reverting the cull (NEAR→all) collapses culled→all-brain ≫ floor×2,
 *       re-failing this (invariant #13).
 *
 * NOT asserted: strict O(1)-in-N flatness. The body integration is O(N) and
 * always was (it is O(N) on `main` too — `main` integrates every drone every
 * replayed tick). The N→N/2 line is printed as informational evidence the
 * EXPENSIVE (brain) cost is k-driven.
 */
async function buildSplitScene(
  n: number,
  kNear: number,
): Promise<{
  world: PhysicsWorld;
  seed: Map<string, ShipPhysicsState>;
  near: ReadonlySet<string>;
  tickAll: () => void;
  tickCulled: () => void;
}> {
  const world = await PhysicsWorld.create();
  world.spawnShip(PLAYER, 0, 0);
  const ai = new AiController(NOOP_SINK);
  const seed = new Map<string, ShipPhysicsState>();
  const inputs: DroneRelevanceInput[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    // First kNear sit well inside DRONE_RELEVANCE_RADIUS (≈1000) → brain
    // re-sim; the rest sit far outside → dead-reckon. 300 / 50_000 are
    // extreme enough that any sane radius retune keeps the split (asserted
    // below so a tuning change fails loudly, not as a perf flake).
    const r = i < kNear ? 300 : 50_000;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    world.spawnObstacle(dkey(i), x, y, 24, 3);
    ai.register(dkey(i), i, new HostileDroneBehaviour(K));
    seed.set(dkey(i), { x, y, vx: 0, vy: 0, angle, angvel: 0 });
    inputs.push({ id: dkey(i), x, y, hostile: false });
  }
  // maxResim:Infinity — this scene locks the RADIUS cull (far drones cheap);
  // the per-snapshot k-cap (in-pack melee) has its own lock below. Without
  // this the default DRONE_RESIM_BUDGET would cap near and trip the sanity
  // check (kNear=20 > budget).
  const { near, far } = partitionDronesByRelevance(inputs, { playerX: 0, playerY: 0, maxResim: Infinity });
  if (near.size !== kNear || far.length !== n - kNear) {
    throw new Error(
      `scene split unexpected (near ${near.size}/${kNear}, far ${far.length}/${n - kNear}) — DRONE_RELEVANCE_RADIUS retuned past the 300/50000 scene bounds?`,
    );
  }
  const snap = (id: string): AiEntity | null => {
    const s = world.getShipState(id);
    return s ? { id, x: s.x, y: s.y, vx: s.vx ?? 0, vy: s.vy ?? 0, angle: s.angle, angvel: s.angvel ?? 0 } : null;
  };
  const tickAll = (): void => ai.tick(0, 1 / 60, PLAYERS, snap);
  // Production replay path: O(k) — iterate only the NEAR set, NOT a
  // predicate over all N (that would keep the O(ticksAhead × N) scan).
  const tickCulled = (): void => ai.tickOnly(near, 0, 1 / 60, PLAYERS, snap);
  return { world, seed, near, tickAll, tickCulled };
}

test(
  'Option A: relevance-culled brain re-sim is a ≥2.5× win vs all-brain at a bounded premium over the zero-brain floor',
  async () => {
    const kNear = 20;

    // `main` behaviour: every drone brain-re-simmed each replayed tick
    // (no freeze; bodies always integrate).
    const all = await buildSplitScene(N, kNear);
    const recAll = new Reconciler(all.world, PLAYER);
    loadInputs(recAll);
    const allBrainMs = median(() =>
      recAll.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, () => all.tickAll(), { drones: all.seed }),
    );

    // Option A production path: only the k NEAR brain-re-simmed (real
    // `tickOnly`); the N−k FAR dead-reckon (NO freeze — bodies integrate).
    const culled = await buildSplitScene(N, kNear);
    const recCull = new Reconciler(culled.world, PLAYER);
    loadInputs(recCull);
    const culledMs = median(() =>
      recCull.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, () => culled.tickCulled(), { drones: culled.seed }),
    );

    // Zero-brain floor (k=0): no swarm AI at all, all drones dead-reckon —
    // the theoretical minimum for the no-freeze model, SAME scene/env.
    const floor = await buildSplitScene(N, kNear);
    const recFloor = new Reconciler(floor.world, PLAYER);
    loadInputs(recFloor);
    const floorMs = median(() =>
      recFloor.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, undefined, { drones: floor.seed }),
    );

    // Informational only: same k=20 NEAR, half the N — evidence the
    // EXPENSIVE (brain) cost is k-driven (the residual N term is the
    // always-O(N) body integration, present on `main` too).
    const half = await buildSplitScene(N / 2, kNear);
    const recHalf = new Reconciler(half.world, PLAYER);
    loadInputs(recHalf);
    const culledHalfMs = median(() =>
      recHalf.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, () => half.tickCulled(), { drones: half.seed }),
    );

    const winVsAll = allBrainMs / Math.max(culledMs, 1e-3);
    const premiumVsFloor = culledMs / Math.max(floorMs, 1e-3);
    // eslint-disable-next-line no-console
    console.log(
      `\n=== Option A relevance-culled replay (k=${kNear}, ticksAhead=${TICKS_AHEAD}, NO freeze) ===\n` +
        `  all-brain re-sim     @ N=${N}     : ${allBrainMs.toFixed(2)} ms\n` +
        `  culled (k NEAR)      @ N=${N}     : ${culledMs.toFixed(2)} ms\n` +
        `  zero-brain floor     @ N=${N}     : ${floorMs.toFixed(2)} ms\n` +
        `  culled (k NEAR)      @ N=${N / 2}     : ${culledHalfMs.toFixed(2)} ms  (informational)\n` +
        `  (a) win vs all-brain             : ${winVsAll.toFixed(1)}×  (gate: ≥2.5×)\n` +
        `  (b) premium vs zero-brain floor  : ${premiumVsFloor.toFixed(2)}×  (gate: ≤2.0×)\n` +
        `  N→N/2 brain sensitivity          : ${(culledMs / Math.max(culledHalfMs, 1e-3)).toFixed(2)}× (informational)`,
    );

    // (a) Culling the brain re-sim is a large, N-driven win vs all-brain —
    // same ratio philosophy + ≥2.5× threshold as the blanket lock above.
    expect(
      culledMs * 2.5,
      `relevance-cull must be a ≥2.5× win at N=${N}, k=${kNear} (culled ${culledMs.toFixed(1)} ms vs all-brain ${allBrainMs.toFixed(1)} ms)`,
    ).toBeLessThan(allBrainMs);

    // (b) Option A pays only a BOUNDED premium over the zero-brain floor for
    // the k brain ticks it keeps: culled ≤ 2.0 × floor. Reverting the cull
    // (NEAR→all) makes culled≈all-brain ≫ 2× floor and re-fails this
    // (invariant #13). Both ratios are same-env, so host load cancels.
    expect(
      culledMs,
      `Option A premium over the zero-brain floor must stay ≤2.0× (culled ${culledMs.toFixed(1)} ms vs floor ${floorMs.toFixed(1)} ms — a regression toward all-brain ${allBrainMs.toFixed(1)} ms blows this)`,
    ).toBeLessThan(floorMs * 2.0);
  },
  120_000,
);

/**
 * In-pack combat reconcile-cost spiral lock (diag m6rq2t, 2026-05-17).
 * Inside the bot pack EVERY drone is near/hostile, so Option A's radius cull
 * gives ZERO relief — pre-fix per-snapshot reconcile is O(replayWindow × N);
 * as the client's snapshot-handle interval slows the window grows → work
 * grows → the progressive combat-lag spiral that killed the player BEFORE
 * death. The per-snapshot k-cap (DRONE_RESIM_BUDGET) bounds the EXPENSIVE
 * brain re-sim to K regardless of pack size → cost FLAT in N → spiral
 * broken. Ratio-based + same-env (host-robust, same philosophy as the
 * Option A lock above).
 */
async function buildInPackScene(n: number): Promise<{
  world: PhysicsWorld;
  seed: Map<string, ShipPhysicsState>;
  tickCapped: () => void;
  tickAll: () => void;
}> {
  const world = await PhysicsWorld.create();
  world.spawnShip(PLAYER, 0, 0);
  const ai = new AiController(NOOP_SINK);
  const seed = new Map<string, ShipPhysicsState>();
  const inputs: DroneRelevanceInput[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const r = 250 + (i % 5) * 30; // ALL well inside the radius — in-pack melee
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    world.spawnObstacle(dkey(i), x, y, 24, 3);
    ai.register(dkey(i), i, new HostileDroneBehaviour(K));
    seed.set(dkey(i), { x, y, vx: 0, vy: 0, angle, angvel: 0 });
    inputs.push({ id: dkey(i), x, y, hostile: true }); // melee: all hostile
  }
  const { near: nearCapped } = partitionDronesByRelevance(inputs, { playerX: 0, playerY: 0 });
  const { near: nearAll } = partitionDronesByRelevance(inputs, { playerX: 0, playerY: 0, maxResim: Infinity });
  if (nearCapped.size !== DRONE_RESIM_BUDGET) {
    throw new Error(`expected capped near == budget ${DRONE_RESIM_BUDGET}, got ${nearCapped.size}`);
  }
  if (nearAll.size !== n) {
    throw new Error(`expected uncapped near == n ${n}, got ${nearAll.size}`);
  }
  const snap = (id: string): AiEntity | null => {
    const s = world.getShipState(id);
    return s ? { id, x: s.x, y: s.y, vx: s.vx ?? 0, vy: s.vy ?? 0, angle: s.angle, angvel: s.angvel ?? 0 } : null;
  };
  const tickCapped = (): void => ai.tickOnly(nearCapped, 0, 1 / 60, PLAYERS, snap);
  const tickAll = (): void => ai.tickOnly(nearAll, 0, 1 / 60, PLAYERS, snap);
  return { world, seed, tickCapped, tickAll };
}

test(
  'in-pack k-cap: ≥2× win vs the all-near spiral at a bounded premium over the zero-brain floor',
  async () => {
    const N_BIG = 60; // a dense pack — toward the 500-target regime

    // The spiral: all-near (pre-cap behaviour) at the dense pack.
    const sp = await buildInPackScene(N_BIG);
    const recSp = new Reconciler(sp.world, PLAYER);
    loadInputs(recSp);
    const spiralMs = median(() =>
      recSp.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, () => sp.tickAll(), { drones: sp.seed }),
    );

    // k-cap at the dense pack — same scene/env.
    const cb = await buildInPackScene(N_BIG);
    const recCb = new Reconciler(cb.world, PLAYER);
    loadInputs(recCb);
    const cappedMs = median(() =>
      recCb.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, () => cb.tickCapped(), { drones: cb.seed }),
    );

    // Zero-brain floor at the SAME N — no swarm AI, all dead-reckon. Pays
    // the SAME irreducible O(N) ballistic body integration as `capped`; the
    // only delta is the bounded-K brain. (Total reconcile is NOT flat in N —
    // body integration is O(N), on `main` too — so the honest invariant is
    // "bounded BRAIN premium over the floor", mirroring the Option-A lock,
    // NOT strict N-flatness. An earlier draft asserted flatness and was
    // wrong for exactly the reason the Option-A docstring documents.)
    const fl = await buildInPackScene(N_BIG);
    const recFl = new Reconciler(fl.world, PLAYER);
    loadInputs(recFl);
    const floorMs = median(() =>
      recFl.reconcile(serverState, 0, TICKS_AHEAD + 1, 0, undefined, { drones: fl.seed }),
    );

    const winVsSpiral = spiralMs / Math.max(cappedMs, 1e-3);
    const premiumVsFloor = cappedMs / Math.max(floorMs, 1e-3);
    // eslint-disable-next-line no-console
    console.log(
      `\n=== in-pack k-cap (budget=${DRONE_RESIM_BUDGET}, ticksAhead=${TICKS_AHEAD}, N=${N_BIG} all-near) ===\n` +
        `  spiral (all-near)  : ${spiralMs.toFixed(2)} ms\n` +
        `  capped (k-cap)     : ${cappedMs.toFixed(2)} ms\n` +
        `  zero-brain floor   : ${floorMs.toFixed(2)} ms\n` +
        `  (a) win vs spiral  : ${winVsSpiral.toFixed(1)}×  (gate ≥2.0×)\n` +
        `  (b) premium vs floor: ${premiumVsFloor.toFixed(2)}×  (gate ≤2.0×)`,
    );

    // (a) The k-cap is a large win over the all-near spiral. Gate ≥2.0×
    // (not the far-cull lock's ≥2.5×): in a melee the irreducible O(N)
    // ballistic body integration is a larger share of total cost, so the
    // brain-cull RATIO is necessarily lower — 2.0× is the honest,
    // host-robust floor. Same-env, so host load cancels.
    expect(
      cappedMs * 2.0,
      `k-cap must be ≥2× faster than the all-near spiral (capped ${cappedMs.toFixed(1)} ms vs spiral ${spiralMs.toFixed(1)} ms)`,
    ).toBeLessThan(spiralMs);

    // (b) The k-cap pays only a BOUNDED brain premium over the zero-brain
    // floor at the same N (both pay identical O(N) body integration; the
    // delta is the K-capped brain, flat regardless of pack size). Reverting
    // the cap (NEAR→all) makes capped≈spiral ≫ 2× floor → re-fails
    // (invariant #13). Mirrors the Option-A (b) contract; host-robust.
    expect(
      cappedMs,
      `k-cap brain premium over the zero-brain floor must stay ≤2.0× (capped ${cappedMs.toFixed(1)} ms vs floor ${floorMs.toFixed(1)} ms — a regression toward spiral ${spiralMs.toFixed(1)} ms blows this)`,
    ).toBeLessThan(floorMs * 2.0);
  },
  120_000,
);
