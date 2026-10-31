/**
 * Ambient-load perf baseline capture (plan: perf-floor, Phase 2).
 *
 * NOT a regression lock — this spec PRODUCES the baseline JSON that
 * Phase 5's `perf-<scenario>.spec.ts` locks read. Run via:
 *
 *   pnpm e2e:perf
 *
 * Each invocation appends to `diag/perf-baseline/<scenario>-<arm>.json`
 * (overwriting any previous file for that pair). Commit the JSONs when
 * a baseline is intentional; otherwise treat them as scratch.
 *
 * Per the perf-floor plan, the user-confirmed load target is "ambient
 * + hunters (~39 drones)" — the FLOOR of acceptance. swarm-soak (500
 * entities) and swarm-tidi (4000) are explicitly out of scope. Scenarios:
 *
 *   - `sol-prime-ambient` (`?galaxy=sol-prime`) — real LivingWorldDirector
 *     traffic (≤25 hunters + 2/sector patrol). Closest analogue to "what
 *     a player encounters when alone." Live LivingWorldDirector may drift
 *     hunter count by ±N — the capture reads `/dev/population` to record
 *     the actual count next to the baseline.
 *   - `feel-test-25` (`?room=feel-test-25`) — deterministic 25-drone
 *     engineering room (the same room the netcode-health gate uses).
 *     Pins drone count for cross-run reproducibility.
 *
 * Per-spec arms:
 *   - `desktop` — default Playwright chromium.
 *   - `mobile-shaped` — same browser with CDP
 *     `Emulation.setCPUThrottlingRate(4)` + DPR 2 + viewport 414×896.
 *     Reproduces CPU-side pressure (Pattern B). Does NOT reproduce radio
 *     buffering (Pattern A) — Phase 3's on-device captures do that.
 *
 * **Anti-patterns explicitly avoided** (per plan):
 *   - NO `?diag=1` — `evaluatePerf` precondition is `diagEnabled===false`.
 *     The spec asserts this *before* emitting the baseline.
 *   - NO Playwright `isMobile: true` — that flips CSS breakpoints, NOT
 *     CPU. The CDP throttle is the load-bearing surface.
 *   - NO HTTP+WS proxy — perf captures run direct-to-dev:server. The
 *     netgate's proxy injects ±30 ms jitter that would falsify
 *     `clientRafP99Ms`.
 */
import { test, type CDPSession, type Page, type BrowserContext, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aggregateSamples,
  framePercentile,
  parseTickBudgetEvent,
  type PerSampleArm,
  type TickBudgetSample,
} from './perfCapture.js';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_BASE = process.env['EQX_SERVER_URL'] ?? 'http://localhost:2567';
const OUT_DIR = resolve(process.cwd(), 'diag', 'perf-baseline');
const WARMUP_MS = 5_000;
const MEASURE_MS = 25_000;
const SAMPLE_INTERVAL_MS = 200; // 5 Hz client-side polling

interface PredStats {
  rafP50Ms: number;
  rafP99Ms: number;
  longtaskCount30s: number;
  rafGapCount30s: number;
  heapUsedMb?: number;
  rollingCorrRate: number;
  maxDriftUnits: number;
  totalDriftUnits: number;
  snapshotCount: number;
  ticksAhead: number;
}

async function readPredStats(page: Page): Promise<PredStats | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    if (!el) return null;
    const raw = el.getAttribute('data-pred-stats');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PredStats;
    } catch {
      return null;
    }
  });
}

async function readDiagFlag(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled === true;
  });
}

interface DevEvent {
  tag: string;
  ts: number;
  data: Record<string, unknown>;
}

/** Drain `tick_budget` events for the room under test (the only room with a
 *  live player) newer than `seenLatestTick`. The /dev/events ring is GLOBAL
 *  (~21 eager galaxy rooms emit one each per second), so the spec drains every
 *  `TICK_DRAIN_INTERVAL_MS` instead of once at the end — a single end-of-window
 *  read only ever saw the last few seconds. Parsing lives in the pure
 *  `parseTickBudgetEvent` (unit-locked against the real server shape). */
async function fetchTickBudgets(seenLatestTick: number): Promise<{
  newSamples: TickBudgetSample[];
  latestTick: number;
}> {
  const res = await fetch(`${SERVER_BASE}/dev/events?limit=500`);
  if (!res.ok) return { newSamples: [], latestTick: seenLatestTick };
  const body = (await res.json()) as { events?: DevEvent[] };
  const out: TickBudgetSample[] = [];
  let latest = seenLatestTick;
  for (const ev of body.events ?? []) {
    if (ev.tag !== 'tick_budget') continue;
    const sample = parseTickBudgetEvent(ev.data);
    if (sample === null || sample.serverTick <= seenLatestTick) continue;
    out.push(sample);
    if (sample.serverTick > latest) latest = sample.serverTick;
  }
  return { newSamples: out, latestTick: latest };
}

/** Page-side frame sampler, installed before navigation. It records rAF deltas
 *  into a fixed ring independent of `?diag` — the client's own `rafP50Ms` is
 *  derived from the diag log ring, which is EMPTY on the production path the
 *  perf gate must measure (`?diag=0`), so every baseline recorded null frame
 *  times. Cost: one rAF callback + one typed-array write per frame. */
const FRAME_SAMPLER_SCRIPT = `(() => {
  const N = 600;
  const ring = new Float64Array(N);
  let i = 0, n = 0, last = 0;
  const loop = (t) => {
    if (last > 0) { ring[i] = t - last; i = (i + 1) % N; if (n < N) n++; }
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__eqxPerfFrames = () => {
    const out = [];
    for (let k = 0; k < n; k++) out.push(ring[(i - 1 - k + N) % N]);
    return out;
  };
})();`;

const TICK_DRAIN_INTERVAL_MS = 5_000;
/** Frames per ~5 s window at 60 Hz — the rolling window the p50/p99 cover. */
const FRAME_WINDOW = 300;

async function readFramePercentiles(page: Page): Promise<{ p50: number; p99: number }> {
  const deltas = await page.evaluate((w) => {
    const f = (window as unknown as { __eqxPerfFrames?: () => number[] }).__eqxPerfFrames;
    return f ? f().slice(0, w) : [];
  }, FRAME_WINDOW);
  return { p50: framePercentile(deltas, 0.5), p99: framePercentile(deltas, 0.99) };
}

async function fetchPopulation(): Promise<{ hunters: number; totalDrones: number } | undefined> {
  try {
    const res = await fetch(`${SERVER_BASE}/dev/population`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    const huntersRaw = body['hunters'] ?? body['huntersTotal'] ?? body['lwbotCount'];
    const totalRaw = body['totalDrones'] ?? body['droneCount'] ?? body['total'];
    const hunters = typeof huntersRaw === 'number' ? huntersRaw : -1;
    const totalDrones = typeof totalRaw === 'number' ? totalRaw : -1;
    if (hunters < 0 && totalDrones < 0) return undefined;
    return { hunters: hunters >= 0 ? hunters : 0, totalDrones: totalDrones >= 0 ? totalDrones : 0 };
  } catch {
    return undefined;
  }
}

async function captureArm(args: {
  scenario: string;
  arm: 'desktop' | 'mobile-shaped';
  url: string;
  context: BrowserContext;
  applyThrottle: boolean;
}): Promise<void> {
  const { scenario, arm, url, context, applyThrottle } = args;
  const page = await context.newPage();
  let cdp: CDPSession | null = null;
  try {
    if (applyThrottle) {
      cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.addInitScript(FRAME_SAMPLER_SCRIPT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for game-surface mount + warp curtain to lift (room joined,
    // first snapshot applied, first frame rendered). Mirrors the existing
    // join-warp-screen.spec.ts pattern.
    // Boot + warp curtain wait timeouts are scaled for the CDP-throttled
    // arm (CPU 4×): 15 s game-surface + 60 s warp-visible covers the
    // worst-case mobile-shaped boot. These are INFRASTRUCTURAL costs (page
    // load + first-frame + first snapshot) — the 25 s measure window is
    // separate and remains the load-bearing game-time budget.
    await page.waitForSelector('[data-testid="game-surface"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="warp-screen"]'))
      .toHaveAttribute('data-warp-visible', '0', { timeout: 60_000 });

    // Precondition: diag MUST be off. If it's on, we'd be measuring the
    // instrumented build (2026-05-19 trap). Phase 0a of e2e-rebuild's
    // `?diag=0` override is supposed to ensure this for webdriver.
    const diagOn = await readDiagFlag(page);
    if (diagOn) {
      console.warn(`[perf] ${scenario}/${arm} diag is ON — capture invalid`);
    }

    // Warmup window: lets the rolling stats fill, RTT welford settle,
    // LivingWorldDirector spawn hunters.
    await page.waitForTimeout(WARMUP_MS);

    // Population snapshot — only meaningful for sol-prime-ambient (the
    // engineering room `feel-test-25` has a pinned 25 drones).
    const population = scenario === 'sol-prime-ambient' ? await fetchPopulation() : undefined;

    // Reset server event ring at measure-window start so we capture only
    // tick_budget samples from the measure window.
    try { await fetch(`${SERVER_BASE}/dev/events/clear`, { method: 'POST' }); } catch { /* ignore */ }

    const samples: PerSampleArm[] = [];
    const tickBudgets: TickBudgetSample[] = [];
    let latestTick = 0;
    let lastDrainAt = Date.now();
    let lastFrameReadAt = 0;
    const start = Date.now();

    while (Date.now() - start < MEASURE_MS) {
      const tMs = Date.now() - start;
      const stats = await readPredStats(page);
      // Frame percentiles from the page-side sampler (diag-independent), read
      // ~1 Hz — each read covers the last ~5 s of frames. NaN on the other
      // samples; the aggregate drops NaN.
      let frames = { p50: Number.NaN, p99: Number.NaN };
      if (Date.now() - lastFrameReadAt >= 1_000) {
        frames = await readFramePercentiles(page);
        lastFrameReadAt = Date.now();
      }
      if (Date.now() - lastDrainAt >= TICK_DRAIN_INTERVAL_MS) {
        const drained = await fetchTickBudgets(latestTick);
        tickBudgets.push(...drained.newSamples);
        latestTick = drained.latestTick;
        lastDrainAt = Date.now();
      }
      if (stats) {
        samples.push({
          tMs,
          rafP50Ms: frames.p50,
          rafP99Ms: frames.p99,
          longtaskCount30s: stats.longtaskCount30s,
          rafGapCount30s: stats.rafGapCount30s,
          heapUsedMb: stats.heapUsedMb,
          rollingCorrRate: stats.rollingCorrRate,
          maxDriftUnits: stats.maxDriftUnits,
          meanDriftUnits: stats.snapshotCount > 0 ? stats.totalDriftUnits / stats.snapshotCount : 0,
          ticksAhead: stats.ticksAhead,
          snapshotCount: stats.snapshotCount,
          diagEnabled: diagOn,
        });
      }
      await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    }

    // Final drain for the tail of the window. Drains run every
    // TICK_DRAIN_INTERVAL_MS (not per-second — per-second fetches starved the
    // sample loop, dropping ~125 expected samples to ~10).
    tickBudgets.push(...(await fetchTickBudgets(latestTick)).newSamples);

    const agg = aggregateSamples({
      scenario,
      arm,
      durationMs: MEASURE_MS,
      samples,
      tickBudgets,
      capturedAt: new Date().toISOString(),
      population,
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const outFile = join(OUT_DIR, `${scenario}-${arm}.json`);
    writeFileSync(outFile, JSON.stringify(agg, null, 2) + '\n', 'utf8');
    console.log(`[perf] wrote ${outFile} — samples=${agg.sampleCount}, diag=${agg.diagEnabledAtCapture}`);

    // Hard preconditions: diag=on invalidates the capture entirely
    // (would be measuring the instrumented build). sampleCount low is
    // a SOFT warning — the capture is still valid for triage data;
    // Phase 5's perfBudget reads its own `MIN_SAMPLES` precondition.
    expect(agg.diagEnabledAtCapture).toBe(false);
    if (agg.sampleCount < 20) {
      console.warn(
        `[perf] ${scenario}/${arm} sampleCount=${agg.sampleCount} — slow page or busy host; ` +
          `Phase 5 budget will treat this as a precondition fail. Re-run on a quiet box.`,
      );
    }
    // HARD preconditions (2026-10-31): a capture with no server tick samples or
    // no frame-time samples is not a baseline — it previously wrote nulls/zeros
    // silently and every budget derived from it would have been ungrounded.
    expect(
      agg.tickBudget.sampleCount,
      `${scenario}/${arm}: no tick_budget samples for the room under test`,
    ).toBeGreaterThan(0);
    expect(
      agg.metrics['rafP50Ms']?.sampleCount ?? 0,
      `${scenario}/${arm}: no frame-time samples from the page sampler`,
    ).toBeGreaterThan(0);
  } finally {
    try { await cdp?.detach(); } catch { /* ignore */ }
    await page.close();
  }
}

// `?diag=0` is LOAD-BEARING — Playwright sets navigator.webdriver=true
// which auto-enables diag (the 2026-05-19 trap). Phase 0a of e2e-rebuild
// wired the `?diag=0` URL override; perf captures MUST pass it explicitly
// or they measure the instrumented build, not the player program.
const SCENARIO_URLS = {
  'sol-prime-ambient': `${BASE_URL}/?galaxy=sol-prime&diag=0`,
  'feel-test-25': `${BASE_URL}/?room=feel-test-25&spawnX=0&spawnY=0&diag=0`,
} as const;

test.describe('perf baseline capture (ambient-floor scope)', () => {
  // One test per (scenario, arm) pair so a failing arm does not skip its
  // sibling. Each test boots its own browser context — Playwright workers
  // are 1, so they run sequentially regardless.

  test('sol-prime-ambient — desktop', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      await captureArm({
        scenario: 'sol-prime-ambient',
        arm: 'desktop',
        url: SCENARIO_URLS['sol-prime-ambient'],
        context: ctx,
        applyThrottle: false,
      });
    } finally {
      await ctx.close();
    }
  });

  test('sol-prime-ambient — mobile-shaped', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
    try {
      await captureArm({
        scenario: 'sol-prime-ambient',
        arm: 'mobile-shaped',
        url: SCENARIO_URLS['sol-prime-ambient'],
        context: ctx,
        applyThrottle: true,
      });
    } finally {
      await ctx.close();
    }
  });

  test('feel-test-25 — desktop', async ({ browser }) => {
    const ctx = await browser.newContext();
    try {
      await captureArm({
        scenario: 'feel-test-25',
        arm: 'desktop',
        url: SCENARIO_URLS['feel-test-25'],
        context: ctx,
        applyThrottle: false,
      });
    } finally {
      await ctx.close();
    }
  });

  test('feel-test-25 — mobile-shaped', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
    try {
      await captureArm({
        scenario: 'feel-test-25',
        arm: 'mobile-shaped',
        url: SCENARIO_URLS['feel-test-25'],
        context: ctx,
        applyThrottle: true,
      });
    } finally {
      await ctx.close();
    }
  });
});
