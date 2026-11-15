/**
 * Count budgets for the perf scenes (plan prancy-squishing-donut P3.5; work
 * counters: plan machine-independent-perf WS3), gated on every PR by
 * `tests/integration/sectorRoom/perfSceneCounts.test.ts`.
 *
 * Counts, not timings: they barely depend on the machine. Each budget names
 * the measurement that set it. Raise one only with a new measurement and a
 * reason in the PR, never to get green; shrink the design instead.
 */
export interface CountBudget {
  /** Bytes a pilot's socket receives per second, over the test window (KB/s). */
  rxKBps: number;
  /** The scene must be at least this busy, or the run says nothing. */
  minSwarm: number;
  /** Server work per tick over the first `WORK_WINDOW_TICKS` scene ticks
   *  (`SceneWorkCounters`). The scene script is tick-driven, so a slow host
   *  plays the same ticks: these don't depend on the machine. */
  work?: WorkBudget;
  /** Where the number came from. */
  measured: string;
  /** The re-measure when the break-up (capital + sub-cap wrecks) was switched
   *  on by default (owner, 2026-11-14), for the budgets it moved. */
  measuredBreakUp?: string;
}

/** Ceilings on the server's per-tick work (`ScenePerfView.work`).
 *  `contactsPerTick` is NOT gated: it is a handful of rams per second that
 *  swings ±25 % run to run on one machine (0.09–0.14 / tick, fleet-fight). It
 *  stays in the printout. */
export interface WorkBudget {
  bodiesPerTick: number;
  aiAgentsPerTick: number;
  swarmRecordsPerTick: number;
  swarmBytesPerTick: number;
  entitiesPerSnapshot: number;
}

/** Scene ticks the work counters cover: 12 s of scene time at 60 Hz. */
export const WORK_WINDOW_TICKS = 720;

// Work budgets: max of the runs named in `measured` + 25 %, rounded up (a
// budget never goes below 1, so a scene that measures 0 has room for noise).
export const COUNT_BUDGETS: Record<string, CountBudget> = {
  // 2026-11-06, laptop, two runs: 216 / 218 KB/s (swarm 67); browser runs 216–263.
  // 2026-11-10, NPC line of fire (friendly fire slice 2): NPCs now hold fire
  // instead of shooting through allies, so fewer ships die in the 12 s window
  // and more stay alive to simulate and send (end swarm 80 vs 65 with the
  // check off, same box). The SCENE changed, not the per-ship cost; the
  // check itself is ~3.5 per tick here (print-only `lineOfFire*`).
  'fleet-fight': {
    rxKBps: 334, minSwarm: 30,
    measured: 'rx 216–218 KB/s laptop 2026-11-06. Work, desktop 4 runs 2026-11-08: bodies 38.4–39.9, ai 37.1–38.1, swarm recs 33.4–35.8, bytes 1141–1226, ents/snap 61.9–68.5; CI (ubuntu, PR #356): 38.6 / 37.5 / 35.8 / 1224 / 66.2, rx 211.9. With NPC line of fire, laptop 3 runs 2026-11-10: bodies 49.6–50.2, ai 48.0–48.7, swarm recs 48.3–48.9, bytes 1649–1670, ents/snap 45.7–47.0, rx 256–267 (check off, same session: 38.6 / 36.8 / 37.5 / 1281 / 46.0, rx 199). Fight-feel alone, re-measured laptop 2026-11-14, feat/ai-fight-feel 4 runs: bodies 67.4–67.7, ai 65.9–66.6, swarm recs 63.2–63.8, bytes 2282–2303, ents/snap 36.3–36.8, rx 209–213; origin/main same session 2 runs: 57.7–57.9 / 56.3–56.6 / 55.7–55.8 / 2013–2017. Raised because fights last longer by the owner’s spread-targets decision (2026-11-14: each AI pilot prefers an unengaged enemy, so more ships stay alive in the window); per-ship cost unchanged: bytes/record 36.1 both, bodies/record 1.06 vs 1.03, ai/record 1.04 vs 1.01; contacts 4–5 vs 47–50 per tick and line-of-fire checks 1.2 vs 5.3 fell',
    // 2026-11-14: owner switched the break-up on (capital + sub-cap wrecks,
    // "land it switched on"). Every kill now leaves 2-3 pieces that are bodies
    // and swarm records; in this 12 s window they are all fresh and drifting.
    measuredBreakUp: 'Break-up ON, desktop 2026-11-14, perf/subcap-final, 4 runs on / 2 off (EQX_*_WRECKS=0): bodies on 74.9–77.3 vs off 58.3–58.4, of which wreck pieces 14.7–17.0 (wreckPiecesPerTick); bodies minus pieces 59.4–61.4, ai 59.3–59.8 vs 56.3–56.4 (+3 ships alive: debris stops shots, so fewer die in the window); swarm recs 73.5–75.5 vs 56.9–57.0; bytes 2653–2724 vs 2056–2059 (36.1 B a record both arms: per-entity cost flat); ents/snap 36.6–38.2 vs 40.2–40.3; rx 283–287 vs 248 KB/s (under 334). Soak (capital-destruction.md): smooth to ~1,600 pieces over 10 min, client never dropped. Budget = on max + 25 %.',
    work: { bodiesPerTick: 97, aiAgentsPerTick: 75, swarmRecordsPerTick: 95, swarmBytesPerTick: 3405, entitiesPerSnapshot: 86 },
  },
  // 2026-11-06, laptop, two runs: 67.8 / 67.8 KB/s (174 entities: citadel + raid).
  'teleport-raid': {
    rxKBps: 85, minSwarm: 100,
    measured: 'rx 67.8 KB/s laptop 2026-11-06. Work, desktop 4 runs 2026-11-08: bodies 157.1–157.2, ai 22.2–22.4, swarm recs 26.2–26.7, bytes 894–911, ents/snap 0; CI (ubuntu, PR #356): 157.2 / 22.3 / 26.5 / 906 / 0, rx 67.8',
    work: { bodiesPerTick: 197, aiAgentsPerTick: 28, swarmRecordsPerTick: 34, swarmBytesPerTick: 1139, entitiesPerSnapshot: 1 },
  },
  // 2026-11-09: 16.9–17.1 KB/s. It rose to ~21 by 2026-11-12 (fire-control
  // `groups` on the own ship, far-drone slices, wreck / time-scale / turret-
  // angle keys) and then fell when undefined-valued keys left the wire
  // (`setOrDrop`, 2026-11-14 trim). Then locks at any distance (owner,
  // 2026-11-14): the 20 on-sight-hostile robots 9 km out now lock the pilot,
  // and the own-ship `lockedBy` slice (#16: the pilot's only view of it)
  // carried ~20 rows. Then (owner, same day) the slice was capped to the 8
  // nearest lockers + a total count (`lockedByN`), so it stays flat however
  // many hostiles lock on. Budget = max of the 5 capped runs + 25 %.
  'capital-fleet': {
    rxKBps: 22, minSwarm: 20,
    measured: 'lockedBy capped to 8 rows + lockedByN, 2026-11-14: laptop 5 runs 16.6–17.4 KB/s; same session uncapped (LOCKED_BY_WIRE_ROWS = 1000) 4 runs 18.0–18.1. Before, locks at any distance, 2026-11-14: laptop 7 runs 17.6–18.3 KB/s, CI (PR #603) 18.1; probe: lockedBy ~20 rows (10 locked, 10 acquiring) ≈ +4 KB/s, the whole rise. Before: laptop 8 runs 2026-11-14 after the snapshot trim: 13.2–14.2 KB/s, swarm 29 (split ~ swarm 8.0, snapshot JSON 5.5, collision_resolved 1.0). Snapshot JSON was 9.8 KB/s on 2026-11-09 and 13.1 on main before the trim: + own-ship lock groups 0.6 (real, sent every snapshot), far-drone slices 0.5 (real hostile/hp), and ~2 KB/s of empty keys (structureMountAngles, wreck deltas, timeScale, shellKey, lockedBy), which the trim removed with the ~5 KB/s of older empty keys. Earlier: 16.9–17.1 KB/s, 2026-11-09',
  },
  // 2026-11-09, laptop, two runs: 11.6 / 11.6 KB/s (one battleship firing on the pilot).
  'capital-duel': { rxKBps: 15, minSwarm: 1, measured: '11.6 KB/s, 2026-11-09' },
  // 2026-11-08: the 80-ship sustained fight seen from the zoom-out floor (asteroids on).
  'wide-view': {
    rxKBps: 418, minSwarm: 50,
    measured: 'desktop 3 runs 2026-11-08: rx 308–334 KB/s, swarm 104–118. Work: bodies 73.6–77.9, ai 69.5–73.8, swarm recs 69.8–73.7, bytes 2380–2513, ents/snap 80.3–93.4; CI (ubuntu, PR #356): 73.1 / 68.6 / 69.3 / 2363 / 91.7, rx 327.7, swarm 101. Fight-feel alone, re-measured laptop 2026-11-14, feat/ai-fight-feel 5 runs: bodies 89.9–93.5, ai 85.8–89.1, swarm recs 85.8–89.5, bytes 3098–3230, ents/snap 47.5–48.8, rx 280–282, end swarm 162–163; origin/main same session 2 runs: 82.7–83.3 / 78.9–79.2 / 78.8–79.4 / 2846–2867, rx 329–332, end swarm 136–137. Raised because fights last longer by the owner’s spread-targets decision (2026-11-14: each AI pilot prefers an unengaged enemy, so more ships stay alive); per-ship cost unchanged: bytes/record 36.1 both, bodies/record 1.04–1.05 both, ai/record 1.00 both',
    // 2026-11-14: break-up switched on (see fleet-fight).
    measuredBreakUp: 'Break-up ON, desktop 2026-11-14, perf/subcap-final, 4 runs on / 2 off: bodies on 98.1–99.1 vs off 81.6–81.9, of which wreck pieces 13.3–14.8; bodies minus pieces 84.3–84.8, ai 81.9–82.8 vs 78.8–79.2 (+3 ships alive); swarm recs 97.5–98.6 vs 81.1–81.3; bytes 3518–3556 vs 2926–2935 (36.1 B a record both arms); ents/snap 51.6–52.4 vs 55.1–55.4; rx 377–381 vs 343–346 KB/s (under 418). Budget = on max + 25 %.',
    work: { bodiesPerTick: 124, aiAgentsPerTick: 93, swarmRecordsPerTick: 124, swarmBytesPerTick: 4445, entitiesPerSnapshot: 117 },
  },
};

/**
 * CLIENT count budgets (WS3), gated by `pnpm perf:counts` (`perf/run-counts.ts`,
 * CI job `perf-counts`). Keyed `<scene>/<shiplight>`. Read in a real browser
 * with software WebGL (SwiftShader, the same on every host) and the effects
 * tier pinned to High, over a fixed stretch of SCENE time.
 */
export interface ClientCountBudget {
  /** WebGL draw calls per rendered frame, 95th percentile. */
  drawCallsP95: number;
  /** Nodes in the Pixi stage tree at the end of the window. */
  displayObjects: number;
  /** Texels uploaded to atlas pages during the window. */
  uploadTexels: number;
  /** Atlas pages live at the end of the window. */
  atlasPages: number;
  measured: string;
}

/** No upload is expected inside the window (art is baked before the curtain
 *  lifts; every calibration run read 0), so the floor is one 2048² atlas page:
 *  a whole new page mid-scene fails. */
export const UPLOAD_TEXELS_FLOOR = 2048 * 2048;

// Max of the runs in `measured` + 25 %, rounded up. The spread in draw calls
// and display objects is the SCENE, not the host: combat plays out differently
// run to run (wide-view ended one run with 50 ships, another with 135), so
// explosions and live ships on screen differ. Draw calls on the wide shots are
// near-constant (LOD dots); the close fleet fight swings with the effects.
export const CLIENT_COUNT_BUDGETS: Record<string, ClientCountBudget> = {
  // The close fleet fight's draw calls swing with the explosions on screen
  // (p95 40–140 over 6 runs, two hosts): a loose gate that still catches a
  // batching collapse (per-sprite draws run to hundreds). wide-view is tight.
  'fleet-fight/baked': {
    drawCallsP95: 175, displayObjects: 6990, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 10,
    measured: 'SwiftShader 960×540 2026-11-08, desktop 4 runs: draw p95 40–140, objects 4920–5592, uploads 0, pages 8; CI (ubuntu, PR #356) 2 runs: draw p95 60–96, objects 5077–5157, uploads 0, pages 8',
  },
  'fleet-fight/high': {
    drawCallsP95: 230, displayObjects: 9053, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 7,
    measured: 'SwiftShader 960×540 2026-11-08, desktop 4 runs: draw p95 145–184, objects 4607–7242, uploads 0, pages 5; CI (ubuntu, PR #356) 2 runs: draw p95 157–160, objects 4818–4848, uploads 0–1 page (4194304 texels), pages 5',
  },
  'wide-view/baked': {
    // Atlas pages: 9 on CI vs 8 on the desktop (one more 2048² page; bake
    // completion order packs differently). Budget from the CI max.
    drawCallsP95: 28, displayObjects: 13198, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 12,
    measured: 'SwiftShader 960×540 2026-11-08, desktop 4 runs: draw p95 20–22, objects 6977–10558, uploads 0, pages 8; CI (ubuntu, PR #356) 2 runs: draw p95 20, objects 6243–6433, uploads 0, pages 8–9',
  },
  'wide-view/high': {
    drawCallsP95: 32, displayObjects: 12590, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 7,
    measured: 'SwiftShader 960×540 2026-11-08, desktop 4 runs: draw p95 24–25, objects 6631–10072, uploads 0, pages 5; CI (ubuntu, PR #356) 2 runs: draw p95 25, objects 6360–6615, uploads 0, pages 5',
  },
};

/**
 * Projectile broadphase (ranges plan, risk 2): narrow-phase sweeps per tick
 * with 500 shells among 1,000 entities (40 km square, naval shell speed,
 * capitals every 50th entity). Gated by
 * `src/server/rooms/ProjectilePipeline.broadphase.test.ts`. A synthetic scene,
 * so the count is exact on every host. Same rule as above: max measured
 * + 25 %, raised only with a new measurement. Measured 2026-11-10 (laptop;
 * deterministic scene, so CI reads the same): broadphase 63, full scan 500,000.
 */
export const PROJECTILE_NARROW_CHECKS_BUDGET = 79;

/**
 * NPC line-of-fire gate (friendly fire slice 2): work per tick in a synthetic
 * fleet fight where EVERY one of 80 ships is a fire candidate every tick (two
 * 40-ship sides 1,500 u apart, 4 capitals, 300 rocks; real drones fire on a
 * cooldown, so live play does far less). Gated by
 * `src/server/rooms/LineOfFireGate.test.ts`; deterministic, so every host
 * reads the same. `candidates` = bodies the broadphase returned (each costs
 * one friendly test); `narrow` = ray tests run (friendly candidates only, the
 * scan stops at the first hit). A full scan would test 80 × 380 = 30,400.
 * Same rule as above: max measured + 25 %. Measured 2026-11-10 (laptop;
 * deterministic, so CI reads the same): 80 checks, 1,617 candidates, 236
 * narrow tests, 1 grid build per tick.
 */
export const LINE_OF_FIRE_BUDGET = { candidatesPerTick: 2022, narrowPerTick: 296 };
