/**
 * Heap-delta lock for `gameRafLoop` — proves the per-RAF `rafWork` log
 * literal AND the per-5-frame `writeE2EDataset` map/JSON.stringify churn
 * are gated OFF in production (`?diag=0` + no Playwright).
 *
 * Pre-fix behaviour (P1 hostile-`diag=0` allocation profile, capture
 * `5d0e7d` analogue): `gameRafLoop.loop` was the rank-1 sampled allocator
 * at 55.0 KB / 6.8 % of the 25 s window. Two sources inside it:
 *
 *   1. `logEvent('rafWork', { ...6 fields ... })` every RAF (60 Hz). The
 *      `HIGH_VOLUME_TAGS` early-return is INSIDE `logEvent`; by then the
 *      caller has already paid for the `{...}` literal + 5 `toFixed(2)`
 *      strings. `?diag=0` does not suppress them.
 *   2. `writeE2EDataset(...)` every 5th RAF (12 Hz) — JSON.stringify of
 *      shipPositions, swarmDetail, predStats, etc. These attributes
 *      exist purely so Playwright specs can read them; a real player's
 *      browser has no use for them yet pays the allocation cost.
 *
 * The fix: gate (1) on `isFullDiagMode()`, gate (2) on a module-level
 * `E2E_DATASET_ENABLED` derived from `navigator.webdriver` (Playwright
 * sets it to `true`; real browsers leave it undefined/false). Both
 * gates are cached-boolean reads — hot-path cost is ~0.
 *
 * Workload: simulate the per-RAF loop body 3000 times with diag-off +
 * no Playwright (node-env naturally has `typeof navigator === 'undefined'`
 * so `E2E_DATASET_ENABLED === false` without mocking). The `logEvent`
 * spy should never see a `'rafWork'` tag.
 *
 * Run with `pnpm test:gc`.
 *
 * plan: imperative-taco
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ClientLogger so we can both control isFullDiagMode + spy on logEvent.
// `vi.hoisted` ensures the mocks are created before the imports below resolve.
const { logEventMock, isFullDiagModeMock } = vi.hoisted(() => ({
  logEventMock: vi.fn(),
  isFullDiagModeMock: vi.fn(),
}));
vi.mock('../debug/ClientLogger.js', () => ({
  logEvent: (...args: unknown[]) => logEventMock(...args),
  isFullDiagMode: () => isFullDiagModeMock(),
}));

// Zustand store — provide the fields writeE2EDataset reads so the
// call body completes without crashing (the test asserts whether
// it's CALLED, not its inner behaviour).
vi.mock('../state/store.js', () => ({
  useUIStore: {
    getState: () => ({
      setRendererFirstFrameRendered: () => {},
      hullPct: 1,
      shieldPct: 1,
      sectorAlert: null,
      clockRate: 1.0,
      // clientReadySent=true short-circuits the bootstrap-ready check so the
      // loop never calls gameClient.sendClientReady() (not on the stub).
      clientReadySent: true,
    }),
  },
  // gameRafLoop imports these alongside useUIStore; the mock must provide
  // them or module load fails (stale-mock regression, 2026-06-03).
  computeBootstrapReadyFromState: () => false,
  computeIsLoadingActive: () => false,
}));

// Per-frame triggers — pure no-op stub.
vi.mock('../render/perFrameTriggers.js', () => ({
  consumeOneFrameTriggers: () => {},
}));

// Frame-rate cap — never skip a frame so the body runs every call.
vi.mock('../perf/frameRateCap.js', () => ({
  shouldSkipFrame: () => false,
}));

// requestAnimationFrame is not defined in node-env. Stub a no-op that
// returns a numeric handle so the loop's self-rebind doesn't crash.
(globalThis as { requestAnimationFrame?: (cb: (now: number) => void) => number }).requestAnimationFrame = () => 0;

// eslint-disable-next-line import/first
import { createGameRafLoop, type GameRafLoopDeps } from './gameRafLoop';

function makeDeps(): GameRafLoopDeps {
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  return {
    el,
    gameClient: {
      tickPhysics: () => {},
      tickInbound: () => {},
      updateMirror: () => {},
      mirror: {
        ships: new Map(),
        swarm: undefined,
        projectiles: undefined,
        liveBeams: undefined,
        remoteLasers: undefined,
        localPlayerId: null,
        pendingDamageNumbers: [],
        pendingHealthBarHits: [],
        pendingEffectTriggers: [],
      },
      transitInstr: { wantsFrame: () => false, frame: () => {} },
      stats: {},
    } as unknown as GameRafLoopDeps['gameClient'],
    renderer: (() => {
      // Stable feedback object so the stub itself doesn't allocate
      // per-frame — the heap-delta test measures the loop body's
      // allocation, not the stub's.
      const stableFeedback = { firstFrameRendered: false, mountCounts: new Map(), haloArrowCount: 0 };
      return {
        update: () => {},
        getFeedback: () => stableFeedback,
      } as unknown as GameRafLoopDeps['renderer'];
    })(),
    useWorker: false,
    effectiveCapMs: 0,
    phaseEnterPerfNow: 0,
    animFrameRef: { current: 0 },
    isDisposed: () => false,
  };
}

function requireGc(): () => void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    throw new Error('global.gc not available — run via `pnpm test:gc`.');
  }
  return gc;
}

function postGcHeap(): number {
  const gc = requireGc();
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

describe('gameRafLoop — rafWork logEvent + writeE2EDataset gates (plan: imperative-taco)', () => {
  beforeEach(() => {
    logEventMock.mockReset();
    isFullDiagModeMock.mockReset();
  });

  it('does NOT call logEvent for rafWork when isFullDiagMode returns false', () => {
    isFullDiagModeMock.mockReturnValue(false);
    const loop = createGameRafLoop(makeDeps());
    for (let i = 0; i < 10; i++) loop(i * 16);
    const rafWorkCalls = logEventMock.mock.calls.filter((c) => c[0] === 'rafWork');
    expect(rafWorkCalls).toHaveLength(0);
  });

  it('DOES call logEvent for rafWork when isFullDiagMode returns true', () => {
    isFullDiagModeMock.mockReturnValue(true);
    const loop = createGameRafLoop(makeDeps());
    loop(16);
    const rafWorkCalls = logEventMock.mock.calls.filter((c) => c[0] === 'rafWork');
    // One rafWork emit per loop call.
    expect(rafWorkCalls).toHaveLength(1);
    // Sanity: the payload still carries the breakdown fields.
    const payload = rafWorkCalls[0]![1] as Record<string, unknown>;
    expect(payload).toHaveProperty('physicsMs');
    expect(payload).toHaveProperty('mirrorMs');
    expect(payload).toHaveProperty('renderMs');
    expect(payload).toHaveProperty('totalMs');
    expect(payload).toHaveProperty('deltaMs');
  });

  it('does NOT write `data-shipPositions` on `el.dataset` when navigator.webdriver is unset (production)', () => {
    isFullDiagModeMock.mockReturnValue(false);
    const deps = makeDeps();
    // Provide a localShip so the every-5th-frame block has something to render.
    const mirror = deps.gameClient.mirror as { ships: Map<string, { x: number; y: number; angle: number }>; localPlayerId: string | null };
    mirror.ships.set('p1', { x: 1, y: 2, angle: 0.5 });
    mirror.localPlayerId = 'p1';
    const loop = createGameRafLoop(deps);
    // Run > 5 frames so the every-5th-frame branch fires.
    for (let i = 0; i < 12; i++) loop(i * 16);
    const ds = (deps.el as HTMLElement).dataset as Record<string, string>;
    // The heavy E2E surface (`shipPositions`, `predStats`, `swarmDetail`)
    // is gated OFF in node-env (no `navigator.webdriver`). The cheap
    // single-field writes (`shipX`/`shipY`/`shipAngle`/`mountCount`)
    // remain unconditional — they're not the rising-edge.
    expect(ds['shipPositions']).toBeUndefined();
    expect(ds['predStats']).toBeUndefined();
    expect(ds['swarmDetail']).toBeUndefined();
  });

  it('heap growth bounded across 3000 loop iterations in production env', () => {
    // Use a plain function (NOT a vi.fn mock) so the heap measurement
    // captures the loop body's allocation, not vitest's per-call mock
    // bookkeeping (`.mock.calls` etc. append every call → ~250 KB across
    // 3000 iters from the mock infrastructure alone).
    isFullDiagModeMock.mockImplementation(() => false);
    const deps = makeDeps();
    // Populate the mirror so the per-frame iteration has non-empty maps.
    const mirror = deps.gameClient.mirror as {
      ships: Map<string, { x: number; y: number; angle: number }>;
      swarm: Map<number, { x: number; y: number; angle: number; kind: number; sleeping: boolean; lastUpdateTick: number; radius: number }> | undefined;
      localPlayerId: string | null;
    };
    mirror.ships.set('p1', { x: 0, y: 0, angle: 0 });
    mirror.localPlayerId = 'p1';
    mirror.swarm = new Map();
    for (let i = 0; i < 25; i++) {
      mirror.swarm.set(i, { x: i, y: i, angle: 0, kind: 1, sleeping: false, lastUpdateTick: 0, radius: 12 });
    }
    const loop = createGameRafLoop(deps);

    // Warmup — JIT + first-iteration setup cost.
    for (let i = 0; i < 500; i++) loop(i * 16);
    // Clear mock call tracking accumulated during warmup so it doesn't
    // count toward `after - before`.
    logEventMock.mockClear();
    isFullDiagModeMock.mockClear();
    isFullDiagModeMock.mockImplementation(() => false);

    const before = postGcHeap();
    for (let i = 0; i < 3000; i++) loop((500 + i) * 16);
    const after = postGcHeap();

    const growthBytes = after - before;
    // Pre-fix measured 1,057,864 bytes across 3000 iterations (1 MB =
    // ~333 bytes per RAF, dominated by the rafWork `{...}` literal +
    // 5 `toFixed(2)` strings every RAF and the writeE2EDataset
    // map/JSON.stringify churn every 5th RAF). Post-fix the gates
    // suppress all of that on production phones. The residual baseline
    // is V8 compilation cache + IC stabilisation + vitest mock
    // bookkeeping (~100 KB for an empty 3000-iter loop, measured).
    // 500 KB threshold = 53 % below the pre-fix floor; a regression
    // re-enabling rafWork or writeE2EDataset would blow past it.
    expect(growthBytes).toBeLessThan(500_000);
  });
});
