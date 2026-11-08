/* eslint-disable no-console -- a CLI: it reports on the console. */
/**
 * Client count gate (plan machine-independent-perf WS3).
 *
 *   pnpm perf:counts [--scenes fleet-fight,wide-view] [--shiplight baked,high]
 *                    [--worker 0|1] [--calibrate] [--headed] [--out file.json]
 *
 * Plays each perf scene × ship-lighting level in a real browser and asserts
 * the CLIENT count budgets (`CLIENT_COUNT_BUDGETS`, perfBudgets.ts): draw
 * calls per frame (p95), display objects, texels uploaded, atlas pages.
 *
 * Counts, never timings, so it gates on ANY host, a GitHub runner included:
 *  - software WebGL (SwiftShader) on every host, so the GL driver is the same;
 *  - the effects tier is pinned to High (`?perfcounts=1`), so a slow host
 *    draws the same effects as a fast one;
 *  - the window is SCENE time (server ticks, from /dev/perf), not wall time:
 *    a slow host measures the same part of the scene.
 * Timings stay in `pnpm perf:scenes` (an A/B on one machine).
 *
 * Ports: capture ports shifted by EQX_SHOWCASE_PORT_OFFSET (default 400 here:
 * server 3167, Vite 5773), so it never touches the dev ports 2567/5173 or
 * another session's run. It refuses to start if anything already listens on
 * its ports (it never kills a process it didn't start).
 *
 * Exit: 0 within budget, 1 over budget or invalid, 2 crashed / ports busy.
 * `--calibrate` prints the readings and the budgets they would set, exit 0.
 */
import { chromium, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CaptureServers, defaultPorts } from '../showcase/servers.js';
import { listListeners } from '../showcase/hostLoad.js';
import { perfSceneById } from '../src/shared-types/perf/perfScenes.js';
import { CLIENT_COUNT_BUDGETS } from '../src/shared-types/perf/perfBudgets.js';
import { judgeCounts, calibrate, type ClientCountReading } from './countsGate.js';

/** Software GL everywhere: the same rasteriser on a laptop, a desktop and CI. */
const SOFTWARE_GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
/** Scene-time window: after the t = 10 s reinforcements land, before t = 20 s. */
export const WINDOW_START_MS = 12_000;
export const WINDOW_END_MS = 19_500;
const DEFAULT_OFFSET = '400';
/** Small enough that SwiftShader keeps ~25 frames in the window on a 2-core
 *  runner. Not smaller: the camera zoom scales with the width, and at 640 px
 *  the fleet fight drops to LOD dots (17 draw calls instead of ~150 lit
 *  ships), so the gate would stop covering the lit-ship path. Counts DO depend
 *  on the viewport: keep it fixed. */
const VIEWPORT = { width: 960, height: 540 };

interface Args { scenes: string[]; shiplight: string[]; worker: string | null; calibrate: boolean; headed: boolean; out: string | undefined }

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    scenes: (get('--scenes') ?? 'fleet-fight,wide-view').split(',').filter(Boolean),
    shiplight: (get('--shiplight') ?? 'baked,high').split(',').filter(Boolean),
    worker: get('--worker') ?? null,
    calibrate: argv.includes('--calibrate'),
    headed: argv.includes('--headed'),
    out: get('--out'),
  };
}

type DevPerfRoom = { players: number; scene: { elapsedMs: number; ended: boolean; refused: number }; swarm: number };
async function sceneRoom(serverUrl: string): Promise<DevPerfRoom | undefined> {
  const r = await fetch(`${serverUrl}/dev/perf`).then((x) => x.json() as Promise<{ rooms: DevPerfRoom[] }>).catch(() => null);
  return r?.rooms.find((x) => x.players > 0);
}

async function waitSceneMs(serverUrl: string, ms: number, deadlineMs: number): Promise<DevPerfRoom> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const room = await sceneRoom(serverUrl);
    if (room && room.scene.elapsedMs >= ms) return room;
    if (Date.now() > end) throw new Error(`scene never reached t = ${ms} ms (at ${room?.scene.elapsedMs ?? 'no room'})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface Row { key: string; reading: ClientCountReading | null; error?: string; atCurtainMs?: number; raw?: unknown }

async function measure(browser: Browser, servers: CaptureServers, sceneId: string, shiplight: string, worker: string | null): Promise<Row> {
  const key = `${sceneId}/${shiplight}`;
  const scene = perfSceneById(sceneId);
  if (!scene) return { key, reading: null, error: `unknown scene ${sceneId}` };
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  try {
    const p = new URLSearchParams({
      room: `perf-${scene.id}`, testId: randomUUID(), spawnX: String(scene.spawn.x), spawnY: String(scene.spawn.y),
      shipKind: 'fighter', initialHull: '1000000', art: 'machined', fx: 'new', diag: '0',
      perfprobe: '1', perfcounts: '1', shiplight,
      ...(worker !== null ? { worker } : {}),
    });
    await page.goto(`${servers.baseUrl}/?${p}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => !!(globalThis as { __eqxPerf?: unknown }).__eqxPerf, null, { timeout: 120_000 });
    await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 180_000 });
    const atCurtainMs = (await sceneRoom(servers.serverUrl))?.scene.elapsedMs ?? -1;
    if (atCurtainMs > WINDOW_START_MS - 1000) {
      return { key, reading: null, atCurtainMs, error: `the loading curtain lifted at scene t = ${atCurtainMs} ms, too late for the ${WINDOW_START_MS} ms window` };
    }
    await page.evaluate((c) => (globalThis as unknown as { __eqxCinema?: { play(c: unknown[]): void } }).__eqxCinema?.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: c.x, y: c.y, zoom: c.zoom * (c.vw / 1920) } }]), { ...scene.camera, vw: VIEWPORT.width });
    await waitSceneMs(servers.serverUrl, WINDOW_START_MS, 120_000);
    await page.evaluate(() => (globalThis as unknown as { __eqxPerf: { reset(): Promise<void> } }).__eqxPerf.reset());
    const room = await waitSceneMs(servers.serverUrl, WINDOW_END_MS, 120_000);
    const client = await page.evaluate(() => (globalThis as unknown as { __eqxPerf: { read(): Promise<any> } }).__eqxPerf.read());
    const c = client.render?.counts;
    if (!c) return { key, reading: null, atCurtainMs, error: 'the renderer reported no counts (count probe not enabled?)', raw: client };
    if (room.scene.refused > 0) return { key, reading: null, atCurtainMs, error: `${room.scene.refused} scene spawns refused` };
    const reading: ClientCountReading = {
      drawCallsP95: c.drawCalls.p95, displayObjects: client.render.displayObjects,
      uploadTexels: c.uploadTexels, atlasPages: c.atlasPages, frames: c.drawCalls.frames,
    };
    return { key, reading, atCurtainMs, raw: { counts: c, effectQuality: client.render.effectQuality, swarm: room.swarm, worker: client.worker } };
  } catch (e) {
    return { key, reading: null, error: (e as Error).message };
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env, EQX_SHOWCASE_PORT_OFFSET: process.env['EQX_SHOWCASE_PORT_OFFSET'] ?? DEFAULT_OFFSET };
  const ports = defaultPorts(env);
  const busy = listListeners().filter((l) => l.port === ports.server || l.port === ports.vite);
  if (busy.length) {
    console.error(`ports busy: ${busy.map((l) => `:${l.port} pid ${l.pid}`).join(', ')}. Another run (or session) owns them; set EQX_SHOWCASE_PORT_OFFSET to a free offset. Nothing was killed.`);
    process.exit(2);
  }
  const runDir = path.resolve('perf', '.run', `counts-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const servers = new CaptureServers(process.cwd(), runDir, ports);
  console.log(`perf:counts · scenes ${args.scenes.join(', ')} · shiplight ${args.shiplight.join(', ')} · ports ${ports.server}/${ports.vite} · window t = ${WINDOW_START_MS}–${WINDOW_END_MS} ms scene time`);
  const rows: Row[] = [];
  let browser: Browser | null = null;
  try {
    await servers.ensure('lean');
    browser = await chromium.launch({ headless: !args.headed, args: SOFTWARE_GL_ARGS });
    for (const sceneId of args.scenes) {
      for (const sl of args.shiplight) {
        const row = await measure(browser, servers, sceneId, sl, args.worker);
        rows.push(row);
        const r = row.reading;
        console.log(r
          ? `  ${row.key.padEnd(18)} draw calls p95 ${r.drawCallsP95} · display objects ${r.displayObjects} · upload texels ${r.uploadTexels} · atlas pages ${r.atlasPages} · frames ${r.frames} · curtain at t = ${row.atCurtainMs} ms · ${JSON.stringify(row.raw)}`
          : `  ${row.key.padEnd(18)} INVALID: ${row.error}`);
      }
    }
  } finally {
    await browser?.close();
    servers.stop();
    try { rmSync(runDir, { recursive: true, force: true }); } catch { /* a server may still hold the DB */ }
  }

  if (args.out) writeFileSync(args.out, JSON.stringify({ when: new Date().toISOString(), platform: process.platform, rows }, null, 2));

  let failed = 0;
  console.log('');
  for (const row of rows) {
    if (!row.reading) { failed++; console.log(`INVALID ${row.key}: ${row.error}`); continue; }
    if (args.calibrate) {
      const r = row.reading;
      console.log(`calibrate ${row.key}: { drawCallsP95: ${calibrate([r.drawCallsP95])}, displayObjects: ${calibrate([r.displayObjects])}, uploadTexels: ${calibrate([r.uploadTexels])}, atlasPages: ${calibrate([r.atlasPages])} }`);
      continue;
    }
    const b = CLIENT_COUNT_BUDGETS[row.key];
    if (!b) { failed++; console.log(`NO BUDGET ${row.key}: add one to CLIENT_COUNT_BUDGETS (perfBudgets.ts)`); continue; }
    const f = judgeCounts(row.reading, b);
    if (f.length) { failed++; console.log(`OVER ${row.key}: ${f.join('; ')} (${b.measured})`); } else console.log(`ok   ${row.key}`);
  }
  process.exit(args.calibrate ? (rows.every((r) => r.reading) ? 0 : 1) : failed > 0 ? 1 : 0);
}

void main().catch((e) => { console.error(e); process.exit(2); });
