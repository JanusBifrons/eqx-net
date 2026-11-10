/**
 * Records one shot: real browser (headless Chromium on the real GPU via ANGLE),
 * CDP screencast frames streamed to disk with their compositor timestamps.
 * The compositor later resamples them to constant frame rate using those
 * timestamps, so dropped frames hold rather than speed the clip up.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import type { CameraCue } from '../src/core/contracts/cameraScript.js';
import type { HudMode, Shot, ShotContext, ShotTarget, ShotViewport } from './types.js';
import { browserPid, sleep, trackPid } from './tools.js';

export interface FrameIndex {
  /** Frame files relative to the clip dir, with capture time (ms, monotonic). */
  frames: Array<{ file: string; t: number }>;
  startT: number;
  endT: number;
}

export interface RecordResult {
  clipDir: string;
  index: FrameIndex;
  deliveredFps: number;
  gapP95Ms: number;
  gapMaxMs: number;
  /** Netcode health over the take (null when there is no local pilot). */
  net: NetStats | null;
  /** The longest frames of the take with what ran in them (Chrome's
   *  long-animation-frame API), worst first. Empty when none ran long. */
  longFrames: LongFrame[];
}

/** One long frame: its time into the take, length, and the scripts it ran. */
export interface LongFrame { atMs: number; ms: number; blockingMs: number; scripts: string }


/** How the server and the local prediction behaved while a take recorded. */
export interface NetStats {
  /** Server ticks per wall-clock second (60 when it keeps pace). */
  serverHz: number;
  /** Snapshots whose prediction drift exceeded the noise floor. */
  corrections: number;
  snapshots: number;
}

/** How long the screencast runs before a take starts (its start-up stall). */
const SCREENCAST_SETTLE_MS = 900;

const GPU_ARGS = [
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

export class Recorder {
  private browser: Browser | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly serverUrl: string,
    private readonly log: (m: string) => void,
    private readonly restartServer: () => Promise<void>,
    private readonly headed = false,
    /**
     * Browser viewport the game renders at. Default 1280×720: measured on the
     * laptop GPU (Iris Xe), the game holds 60 fps at 720p but only ~47 at 1080p
     * BEFORE any capture, and CDP screencast at 1080p dragged it to ~20. The
     * compositor upscales to the 1080p output. See `showcase/bench-capture.ts`.
     */
    private readonly capture: { width: number; height: number } = { width: 1280, height: 720 },
  ) {}

  async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: !this.headed, args: GPU_ARGS });
    trackPid(await browserPid(this.browser));
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  /**
   * Warm-up after a server boot: load the app once in a throwaway tab so Vite
   * compiles the client and the server settles (living-world squads spawning)
   * before anything is filmed. Without it the first take of a batch is often a
   * cold-start stutter or a join timeout.
   */
  async warmUp(settleMs = 8000): Promise<void> {
    const ctx = await this.browser!.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${this.baseUrl}/?worker=0&diag=0`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await page.locator('canvas').first().waitFor({ timeout: 120_000 });
      await sleep(settleMs);
    } catch (e) {
      this.log(`  [warm-up] ${(e as Error).message.split('\n')[0]}`);
    } finally {
      await ctx.close();
    }
  }

  /** Real GPU check — a SwiftShader fallback renders filters black. */
  async gpuName(): Promise<string> {
    const ctx = await this.browser!.newContext();
    const page = await ctx.newPage();
    const name = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    await ctx.close();
    return name;
  }

  async record(shot: Shot, clipDir: string): Promise<RecordResult> {
    if (!this.browser) throw new Error('recorder not open');
    rmSync(clipDir, { recursive: true, force: true });
    mkdirSync(path.join(clipDir, 'frames'), { recursive: true });

    const viewport = shot.viewport ?? 'desktop';
    const context = await this.browser.newContext(contextOptionsFor(viewport, this.capture));
    try {
      return await this.recordIn(context, shot, clipDir, viewport);
    } finally {
      await context.close();
    }
  }

  private async recordIn(context: BrowserContext, shot: Shot, clipDir: string, viewport: ShotViewport): Promise<RecordResult> {
    const phone = viewport !== 'desktop';
    const storage: Record<string, string> = { ...(shot.storage ?? {}) };
    if (shot.auth !== false) {
      const res = await fetch(`${this.serverUrl}/auth/dev/test-token`, { method: 'POST' });
      storage['eqxAuthToken'] = ((await res.json()) as { token: string }).token;
    }
    await context.addInitScript((kv: Record<string, string>) => {
      for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
    }, storage);
    const page = await context.newPage();
    page.on('pageerror', (e) => this.log(`  [pageerror] ${e.message}`));

    const ctx = this.makeContext(page, shot.hud ?? 'minimal', page.viewportSize() ?? this.capture);
    await ctx.enter(shot.target);
    await assertProductionPath(page, shot.target);
    if (shot.prepare) await shot.prepare(ctx);
    if (shot.startWhen) await shot.startWhen(ctx);
    await waitForSteadyPrediction(page, this.log);

    // ---- record ----
    const cdp = await context.newCDPSession(page);
    const index: FrameIndex = { frames: [], startT: 0, endT: 0 };
    let n = 0;
    let writing = Promise.resolve();
    let stopped = false;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      // A frame that arrives after the take ended would keep an absolute
      // time (the rebase below has run) and wreck the encode timeline.
      if (stopped) { void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); return; }
      const t = (f.metadata.timestamp ?? Date.now() / 1000) * 1000;
      const file = `frames/${String(n++).padStart(6, '0')}.jpg`;
      index.frames.push({ file, t });
      // Async write: a sync write here blocks the Node event loop that also
      // carries the Playwright protocol, which throttles the frame stream.
      writing = writing.then(() => writeFile(path.join(clipDir, file), Buffer.from(f.data, 'base64')));
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    const size = screencastSize(viewport, this.capture);
    // EQX_CAPTURE_QUALITY: JPEG quality of the screencast. A frame full of bright,
    // detailed hulls costs Chrome more to encode, and fewer frames arrive.
    const quality = Number(process.env['EQX_CAPTURE_QUALITY'] ?? 80);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1, ...size });
    // Starting the screencast stalls the page for a few hundred ms (long
    // frames of 125-760 ms at 0.1-0.6 s in every take, no script: the
    // capture spinning up). Let it settle, then discard those frames so the
    // take starts on steady capture.
    await sleep(SCREENCAST_SETTLE_MS);
    await writing;
    for (const f of index.frames) rmSync(path.join(clipDir, f.file), { force: true });
    index.frames.length = 0;
    n = 0;
    index.startT = Date.now();
    // EQX_TRACE=1: a Chrome performance trace of the take (trace.json), to see
    // what runs inside a long frame (GPU uploads, shader compiles, GC).
    const tracing = process.env['EQX_TRACE'] === '1';
    if (tracing) {
      await cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'gpu', 'v8', 'blink.user_timing', 'disabled-by-default-gpu.service', 'toplevel'] },
      });
    }
    const net0 = await readNet(page);
    await startLongFrames(page);
    await startPoseTrace(page);
    if (shot.camera) await ctx.cinema.play(scaleCues(shot.camera, phone ? 1 : ctx.viewport.width / 1920));
    // A failed action means the take did not show what the caption says:
    // fail the take (after stopping the screencast) so it is retaken.
    let actionError: Error | null = null;
    const actions = shot.run
      ? shot.run(ctx).catch((e: Error) => {
          actionError = e;
        })
      : null;
    await sleep(shot.durationMs);
    const net1 = await readNet(page);
    const longFrames = await takeLongFrames(page);
    const trace = await takePoseTrace(page);
    if (trace) writeFileSync(path.join(clipDir, 'pose-trace.json'), trace);
    stopped = true;
    if (tracing) await saveTrace(cdp, path.join(clipDir, 'trace.json'));
    await cdp.send('Page.stopScreencast');
    index.endT = Date.now();
    await actions;
    await writing;
    if (actionError) throw new Error(`action failed: ${(actionError as Error).message.split('\n')[0]}`);

    // Rebase timestamps onto the screencast clock's first frame.
    if (index.frames.length > 0) {
      const t0 = index.frames[0]!.t;
      for (const f of index.frames) f.t -= t0;
    }
    writeFileSync(path.join(clipDir, 'frames.json'), JSON.stringify(index));
    return { clipDir, index, ...frameStats(index, shot.durationMs), net: netDelta(net0, net1), longFrames };
  }

  private makeContext(page: Page, hud: HudMode, viewport: { width: number; height: number }): ShotContext {
    const testId = `showcase-${randomUUID()}`;
    const baseUrl = this.baseUrl;
    const ctx: ShotContext = {
      page,
      baseUrl,
      serverUrl: this.serverUrl,
      testId,
      viewport,
      px: (x, y) => ({ x: (x * viewport.width) / 1920, y: (y * viewport.height) / 1080 }),
      log: this.log,
      sleep,
      hold: async (keys, ms) => {
        for (const k of keys) await page.keyboard.down(k);
        await sleep(ms);
        for (const k of keys) await page.keyboard.up(k);
      },
      cinema: {
        play: (cues: CameraCue[]) =>
          page.evaluate((c) => (window as unknown as CinemaWindow).__eqxCinema.play(c), cues),
        stop: () => page.evaluate(() => (window as unknown as CinemaWindow).__eqxCinema.stop()),
        hud: (mode: HudMode) =>
          page.evaluate((m) => (window as unknown as CinemaWindow).__eqxCinema.setHud(m), mode),
      },
      restartServer: this.restartServer,
      enter: async (target: ShotTarget) => {
        await page.goto(targetUrl(baseUrl, target, testId, hud), { waitUntil: 'domcontentloaded', timeout: 180_000 });
        if (target.landing) await waitForLanding(page);
        else await waitForInGame(page);
      },
    };
    return ctx;
  }
}

/** Landscape phone: an iPhone-12-class screen held sideways. 2× DPR gives a
 *  1688×780 capture — crisp in the 1920×1080 bezel frame, and much cheaper
 *  for the GPU than Pixel 5's 2.75× (the take must hold 60 fps under capture). */
export const PHONE_LANDSCAPE = { width: 844, height: 390, deviceScaleFactor: 2 } as const;

/** Browser context for a shot's viewport. Phones are real touch devices
 *  (isMobile + hasTouch), so the game takes its touch/mobile paths. */
export function contextOptionsFor(viewport: ShotViewport, capture: { width: number; height: number }): BrowserContextOptions {
  if (viewport === 'phone') return { ...devices['Pixel 5'] };
  if (viewport === 'phone-landscape') {
    const { width, height, deviceScaleFactor } = PHONE_LANDSCAPE;
    return {
      ...devices['Pixel 5 landscape'],
      viewport: { width, height },
      screen: { width, height },
      deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    };
  }
  return { viewport: capture, deviceScaleFactor: 1 };
}

/** Screencast frame-size cap (device pixels) for a shot's viewport. */
export function screencastSize(
  viewport: ShotViewport,
  capture: { width: number; height: number },
): { maxWidth: number; maxHeight: number } {
  if (viewport === 'phone') return { maxWidth: 1080, maxHeight: 2340 };
  if (viewport === 'phone-landscape') {
    const k = PHONE_LANDSCAPE.deviceScaleFactor;
    return { maxWidth: PHONE_LANDSCAPE.width * k, maxHeight: PHONE_LANDSCAPE.height * k };
  }
  return { maxWidth: capture.width, maxHeight: capture.height };
}

interface CinemaWindow {
  __eqxCinema: {
    version: number;
    play(c: unknown): void;
    stop(): void;
    setHud(m: string): void;
  };
}

/**
 * Shot zooms are authored against a 1920-wide frame. Scale them by the capture
 * width so a take frames the same world area at any capture resolution.
 */
export function scaleCues(cues: readonly CameraCue[], k: number): CameraCue[] {
  if (k === 1) return [...cues];
  return cues.map((c) => {
    const s = c.shot;
    switch (s.kind) {
      case 'hold':
      case 'track':
      case 'orbit':
        return { ...c, shot: { ...s, zoom: s.zoom * k } };
      case 'path':
        return { ...c, shot: { ...s, keys: s.keys.map((key) => ({ ...key, zoom: key.zoom * k })) } };
      case 'frame':
        return {
          ...c,
          shot: {
            ...s,
            ...(s.minZoom !== undefined ? { minZoom: s.minZoom * k } : {}),
            ...(s.maxZoom !== undefined ? { maxZoom: s.maxZoom * k } : {}),
          },
        };
      default:
        return c;
    }
  });
}

/** URL params for a desktop player's default look (see targetUrl). */
export const PLAYER_LOOK = { art: 'machined', fx: 'new', shiplight: 'high' } as const;

export function targetUrl(baseUrl: string, target: ShotTarget, testId: string, hud: HudMode): string {
  // cleanworld=1: no debug world overlays (spatial grid, aim guides, NPC callsigns).
  // The look a desktop player gets by default: Machined art, the new effects,
  // GPU lighting at High (self-shadows, capital shadows, engine lights). The
  // capture browser is automated, and automation otherwise falls back to the
  // classic/baked look (artMode.ts), so shots filmed without these showed a
  // flatter game than players see (user, 2026-11-10). A shot's params or
  // EQX_SHOWCASE_PARAMS still override any of them.
  const p = new URLSearchParams({ worker: '0', diag: '0', hud, cleanworld: '1', ...PLAYER_LOOK });
  if (target.room) {
    p.set('room', target.room);
    p.set('testId', testId);
  }
  if (target.galaxy) p.set('galaxy', target.galaxy);
  for (const [k, v] of Object.entries(target.params ?? {})) p.set(k, String(v));
  // Ship scale: the capture servers inherit EQX_SHIP_SCALE / EQX_SHIP_TUNING
  // from this process; the page must load at the same scale (the welcome checks).
  if (process.env['EQX_SHIP_SCALE']) p.set('shipScale', process.env['EQX_SHIP_SCALE']);
  if (process.env['EQX_SHIP_TUNING']) p.set('shipTuning', process.env['EQX_SHIP_TUNING']);
  if (process.env['EQX_SHIP_KIND_SCALE']) p.set('shipKindScale', process.env['EQX_SHIP_KIND_SCALE']);
  if (process.env['EQX_CAPITAL_STYLE']) p.set('capStyle', process.env['EQX_CAPITAL_STYLE']);
  if (process.env['EQX_CAPITAL_MAP']) p.set('capMap', process.env['EQX_CAPITAL_MAP']);
  // Extra URL params for every shot in a run (e.g. `art=machined&fx=new`, so
  // comparison arms all film the same look).
  for (const [k, v] of new URLSearchParams(process.env['EQX_SHOWCASE_PARAMS'] ?? '')) p.set(k, v);
  return `${baseUrl}/?${p.toString()}`;
}

/**
 * Don't roll until the local prediction is in step: a run of frames that each
 * advance at most two ticks with no server correction being smoothed. Right
 * after a join (or a long loading hold while art bakes) the client can still
 * be catching up, which films as a 20 Hz judder of the ship (round 3 fly-by,
 * 2026-11-05). Shots with no local ship (landing, galaxy) pass at once.
 */
/**
 * Game-side ground truth for smoothness: every animation frame, the RENDERED
 * pose of the local ship and of the biggest other ship (the mirror after the
 * frame's single pose resolve), plus the prediction lerp offset. Video-based
 * gates infer motion from pixels; this says what the game itself drew.
 */
async function startPoseTrace(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const g = globalThis;
    g.__eqxTrace = [];
    g.__eqxTraceOn = true;
    const step = () => {
      if (!g.__eqxTraceOn) return;
      const c = g.__eqxClient;
      const m = c && c.mirror;
      if (m) {
        const me = m.localPlayerId ? m.ships.get(m.localPlayerId) : null;
        let big = null, br = 0;
        if (m.swarm) m.swarm.forEach((e) => { if (e.kind === 1 && (e.radius || 0) > br) { br = e.radius || 0; big = e; } });
        const lo = c.reconciler && c.reconciler.lerpOffset;
        const ps = c.predWorld && m.localPlayerId ? c.predWorld.getShipState(m.localPlayerId) : null;
        g.__eqxTrace.push([performance.now(), me ? me.x : NaN, me ? me.y : NaN, me ? me.angle : NaN, big ? big.x : NaN, big ? big.y : NaN, big ? big.angle : NaN, lo ? lo.x : 0, lo ? lo.y : 0, c.inputTick || 0, m.frameTimeMs || 0, c._lastLocalTickAtMs ?? -1, ps ? ps.x : NaN, ps ? ps.y : NaN, ps ? ps.vx : NaN, ps ? ps.vy : NaN]);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`).catch(() => undefined);
}

/** Stop the pose trace; JSON rows [t, meX, meY, meA, bigX, bigY, bigA, lerpX, lerpY, inputTick, frameTimeMs, tickDueMs, physX, physY, physVx, physVy]. */
async function takePoseTrace(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`(() => { const g = globalThis; g.__eqxTraceOn = false; return g.__eqxTrace ? JSON.stringify(g.__eqxTrace) : null; })()`).catch(() => null);
}

/** End a CDP trace and stream it to a file. */
async function saveTrace(cdp: import('@playwright/test').CDPSession, file: string): Promise<void> {
  const done = new Promise<string>((resolve) => cdp.once('Tracing.tracingComplete', (e: { stream?: string }) => resolve(e.stream ?? '')));
  await cdp.send('Tracing.end');
  const stream = await done;
  if (!stream) return;
  const chunks: string[] = [];
  for (;;) {
    const r = (await cdp.send('IO.read', { handle: stream })) as { data: string; eof: boolean; base64Encoded?: boolean };
    chunks.push(r.base64Encoded ? Buffer.from(r.data, 'base64').toString('utf8') : r.data);
    if (r.eof) break;
  }
  await cdp.send('IO.close', { handle: stream });
  writeFileSync(file, chunks.join(''));
}

/** Start collecting long animation frames (> 50 ms) in the page. */
async function startLongFrames(page: Page): Promise<void> {
  // A string, not a function: tsx injects `__name` into named functions.
  await page.evaluate(`(() => {
    const g = globalThis;
    g.__eqxLoaf = [];
    g.__eqxLoafT0 = performance.now();
    try {
      g.__eqxLoafObs?.disconnect();
      g.__eqxLoafObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) g.__eqxLoaf.push(e); });
      g.__eqxLoafObs.observe({ type: 'long-animation-frame', buffered: false });
    } catch { /* API missing: no attribution */ }
  })()`).catch(() => undefined);
}

/** The take's five longest frames with their top scripts (stop collecting). */
async function takeLongFrames(page: Page): Promise<LongFrame[]> {
  return page.evaluate<LongFrame[]>(`(() => {
    const g = globalThis;
    g.__eqxLoafObs?.disconnect();
    const t0 = g.__eqxLoafT0 ?? 0;
    const all = (g.__eqxLoaf ?? []).slice().sort((a, b) => b.duration - a.duration).slice(0, 5);
    return all.map((e) => {
      const scripts = (e.scripts ?? []).slice().sort((a, b) => b.duration - a.duration).slice(0, 3)
        .map((s) => (s.sourceFunctionName || s.invoker || '?') + ' (' + String(s.sourceURL || '').split('/').pop().split('?')[0] + ') ' + Math.round(s.duration) + 'ms')
        .join('; ');
      return { atMs: Math.round(e.startTime - t0), ms: Math.round(e.duration), blockingMs: Math.round(e.blockingDuration ?? 0), scripts: scripts || 'no script (render/GC/GPU)' };
    });
  })()`).catch(() => []);
}

interface NetSample { t: number; serverTick: number; corrections: number; snapshots: number }

/** The local client's prediction counters (null with no local pilot). */
async function readNet(page: Page): Promise<NetSample | null> {
  // A string, not a function: tsx injects `__name` into named functions.
  return page.evaluate<NetSample | null>(`(() => {
    const c = globalThis.__eqxClient;
    if (!c || !c.stats || !c.mirror || !c.mirror.localPlayerId) return null;
    return { t: performance.now(), serverTick: c.stats.lastServerTick, corrections: c.stats.significantCorrectionCount, snapshots: c.stats.snapshotCount };
  })()`).catch(() => null);
}

export function netDelta(a: NetSample | null, b: NetSample | null): NetStats | null {
  if (!a || !b || b.t <= a.t || b.snapshots <= a.snapshots) return null;
  return {
    serverHz: Math.round(((b.serverTick - a.serverTick) / ((b.t - a.t) / 1000)) * 10) / 10,
    corrections: b.corrections - a.corrections,
    snapshots: b.snapshots - a.snapshots,
  };
}

async function waitForSteadyPrediction(page: Page, log: (m: string) => void): Promise<void> {
  // A string, not a function: tsx injects `__name` into named functions,
  // which doesn't exist in the page.
  const ok = await page.evaluate<boolean>(`new Promise((resolve) => {
    const c = globalThis.__eqxClient;
    if (!c || !c.mirror || !c.mirror.localPlayerId) { resolve(true); return; }
    const t0 = performance.now();
    let prev = c.inputTick, clean = 0;
    const step = () => {
      const d = c.inputTick - prev; prev = c.inputTick;
      const lo = c.reconciler && c.reconciler.lerpOffset;
      const lerping = !!lo && (lo.x !== 0 || lo.y !== 0);
      // 0 or 2 ticks happen now and then as the display drifts against the
      // tick grid; catch-up runs 3-4 a frame.
      clean = d <= 2 && !lerping ? clean + 1 : 0;
      if (clean >= 60) { resolve(true); return; }
      if (performance.now() - t0 > 45000) { resolve(false); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`);
  if (!ok) log('  · prediction never settled (45 s); filming anyway');
}

async function waitForInGame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __eqxStore?: { getState(): Record<string, unknown> } }).__eqxStore?.getState();
      return (
        !!s && s['phase'] === 'game' && !!s['firstSnapshotApplied'] && !!s['rendererFirstFrameRendered'] && !!s['joinMinimumElapsed']
      );
    },
    null,
    { timeout: 120_000, polling: 250 },
  );
  // The load curtain must be fully gone (it lags the join flags on a loaded host)…
  await page
    .locator('[data-testid="warp-screen"]')
    .first()
    .evaluate((el) => el.getAttribute('data-warp-visible'))
    .then(async (v) => {
      if (v !== null && v !== '0') {
        await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { timeout: 30_000 });
      }
    })
    .catch(() => {});
  // …then let the arrival flash finish before anything is filmed.
  await sleep(1500);
}

async function waitForLanding(page: Page): Promise<void> {
  await page.locator('canvas').first().waitFor({ timeout: 120_000 });
  await page.locator('[data-testid="galaxy-loading"]').waitFor({ state: 'detached', timeout: 120_000 });
  await page.locator('[data-testid="server-health-banner"]').waitFor({ state: 'detached', timeout: 120_000 });
  await sleep(800);
}

/** Film the build players run: diag off, and the cinema hook present at this ref. */
async function assertProductionPath(page: Page, target: ShotTarget): Promise<void> {
  const r = await page.evaluate(() => ({
    diag: (window as unknown as { __eqxDiagEnabled?: boolean }).__eqxDiagEnabled,
    cinema: typeof (window as unknown as { __eqxCinema?: unknown }).__eqxCinema,
  }));
  if (r.cinema !== 'object') {
    throw new Error('window.__eqxCinema missing — this ref predates the cinematic camera (PR A); cannot film it.');
  }
  if (!target.landing && r.diag !== false) {
    throw new Error(`diag must be off while filming (got ${String(r.diag)}) — check ?diag=0 handling.`);
  }
}

export function frameStats(index: FrameIndex, durationMs: number): {
  deliveredFps: number;
  gapP95Ms: number;
  gapMaxMs: number;
} {
  const ts = index.frames.map((f) => f.t);
  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
  gaps.sort((a, b) => a - b);
  const pick = (q: number): number => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]! : Infinity);
  return {
    deliveredFps: Math.round((ts.length / (durationMs / 1000)) * 10) / 10,
    gapP95Ms: Math.round(pick(0.95)),
    gapMaxMs: Math.round(gaps.length ? gaps[gaps.length - 1]! : Infinity),
  };
}
