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
  'fleet-fight': {
    rxKBps: 275, minSwarm: 30,
    measured: 'rx 216–218 KB/s laptop 2026-11-06. Work, desktop 4 runs 2026-11-08: bodies 38.4–39.9, ai 37.1–38.1, swarm recs 33.4–35.8, bytes 1141–1226, ents/snap 61.9–68.5',
    work: { bodiesPerTick: 50, aiAgentsPerTick: 48, swarmRecordsPerTick: 45, swarmBytesPerTick: 1533, entitiesPerSnapshot: 86 },
  },
  // 2026-11-06, laptop, two runs: 67.8 / 67.8 KB/s (174 entities: citadel + raid).
  'teleport-raid': {
    rxKBps: 85, minSwarm: 100,
    measured: 'rx 67.8 KB/s laptop 2026-11-06. Work, desktop 4 runs 2026-11-08: bodies 157.1–157.2, ai 22.2–22.4, swarm recs 26.2–26.7, bytes 894–911, ents/snap 0',
    work: { bodiesPerTick: 197, aiAgentsPerTick: 28, swarmRecordsPerTick: 34, swarmBytesPerTick: 1139, entitiesPerSnapshot: 1 },
  },
  // 2026-11-08: the 80-ship sustained fight seen from the zoom-out floor (asteroids on).
  'wide-view': {
    rxKBps: 418, minSwarm: 50,
    measured: 'desktop 3 runs 2026-11-08: rx 308–334 KB/s, swarm 104–118. Work: bodies 73.6–77.9, ai 69.5–73.8, swarm recs 69.8–73.7, bytes 2380–2513, ents/snap 80.3–93.4',
    work: { bodiesPerTick: 98, aiAgentsPerTick: 93, swarmRecordsPerTick: 93, swarmBytesPerTick: 3142, entitiesPerSnapshot: 117 },
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
  'fleet-fight/baked': {
    drawCallsP95: 93, displayObjects: 6990, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 10,
    measured: 'desktop SwiftShader 960×540, 3 runs 2026-11-08: draw p95 40–74, objects 4920–5592, uploads 0, pages 8',
  },
  'fleet-fight/high': {
    drawCallsP95: 230, displayObjects: 9053, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 7,
    measured: 'desktop SwiftShader 960×540, 3 runs 2026-11-08: draw p95 145–184, objects 5353–7242, uploads 0, pages 5',
  },
  'wide-view/baked': {
    drawCallsP95: 28, displayObjects: 13198, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 10,
    measured: 'desktop SwiftShader 960×540, 3 runs 2026-11-08: draw p95 20–22, objects 6977–10558, uploads 0, pages 8',
  },
  'wide-view/high': {
    drawCallsP95: 32, displayObjects: 12590, uploadTexels: UPLOAD_TEXELS_FLOOR, atlasPages: 7,
    measured: 'desktop SwiftShader 960×540, 3 runs 2026-11-08: draw p95 25–25, objects 8313–10072, uploads 0, pages 5',
  },
};
