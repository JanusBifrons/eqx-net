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
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { CameraCue } from '../src/core/contracts/cameraScript.js';
import type { HudMode, Shot, ShotContext, ShotTarget } from './types.js';
import { sleep } from './tools.js';

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
}

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

    const phone = shot.viewport === 'phone';
    const context = await this.browser.newContext(
      phone ? { ...devices['Pixel 5'] } : { viewport: this.capture, deviceScaleFactor: 1 },
    );
    try {
      return await this.recordIn(context, shot, clipDir, phone);
    } finally {
      await context.close();
    }
  }

  private async recordIn(context: BrowserContext, shot: Shot, clipDir: string, phone: boolean): Promise<RecordResult> {
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

    // ---- record ----
    const cdp = await context.newCDPSession(page);
    const index: FrameIndex = { frames: [], startT: 0, endT: 0 };
    let n = 0;
    let writing = Promise.resolve();
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const t = (f.metadata.timestamp ?? Date.now() / 1000) * 1000;
      const file = `frames/${String(n++).padStart(6, '0')}.jpg`;
      index.frames.push({ file, t });
      // Async write: a sync write here blocks the Node event loop that also
      // carries the Playwright protocol, which throttles the frame stream.
      writing = writing.then(() => writeFile(path.join(clipDir, file), Buffer.from(f.data, 'base64')));
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    const size = phone ? { maxWidth: 1080, maxHeight: 2340 } : { maxWidth: this.capture.width, maxHeight: this.capture.height };
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1, ...size });
    index.startT = Date.now();
    if (shot.camera) await ctx.cinema.play(scaleCues(shot.camera, phone ? 1 : ctx.viewport.width / 1920));
    const actions = shot.run ? shot.run(ctx).catch((e: Error) => this.log(`  [action error] ${e.message}`)) : null;
    await sleep(shot.durationMs);
    await cdp.send('Page.stopScreencast');
    index.endT = Date.now();
    await actions;
    await writing;

    // Rebase timestamps onto the screencast clock's first frame.
    if (index.frames.length > 0) {
      const t0 = index.frames[0]!.t;
      for (const f of index.frames) f.t -= t0;
    }
    writeFileSync(path.join(clipDir, 'frames.json'), JSON.stringify(index));
    return { clipDir, index, ...frameStats(index, shot.durationMs) };
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

export function targetUrl(baseUrl: string, target: ShotTarget, testId: string, hud: HudMode): string {
  // cleanworld=1: no debug world overlays (spatial grid, aim guides, NPC callsigns).
  const p = new URLSearchParams({ worker: '0', diag: '0', hud, cleanworld: '1' });
  if (target.room) {
    p.set('room', target.room);
    p.set('testId', testId);
  }
  if (target.galaxy) p.set('galaxy', target.galaxy);
  for (const [k, v] of Object.entries(target.params ?? {})) p.set(k, String(v));
  return `${baseUrl}/?${p.toString()}`;
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
