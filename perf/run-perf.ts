/* eslint-disable no-console -- a CLI: it reports on the console. */
/**
 * Perf scenes runner (plan prancy-squishing-donut P3).
 *
 *   pnpm perf:scenes [--scenes fleet-fight,teleport-raid] [--reps 5]
 *                    [--base origin/main] [--head-only] [--headed]
 *
 * Plays each scene in a real browser (real GPU) against an isolated server
 * pair per arm, interleaved base/head/base/head on the same machine in the
 * same session, so the laptop's own noise cancels. Reads the client probe
 * (`?perfprobe=1`, `window.__eqxPerf`) and the server (`GET /dev/perf`), writes
 * one JSON to `perf/ledger/`, and prints a verdict per scene and metric.
 *
 * The base arm is a git worktree at `.claude/worktrees/perf-base`, linked to
 * the root `node_modules`. `--head-only` skips the A/B (a quick look).
 */
import { chromium, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CaptureServers, type ServerPorts } from '../showcase/servers.js';
import { PERF_SCENES, type PerfScene } from '../src/server/rooms/scene/perfScenes.js';
import { compareArms, type RunMetrics, type ArmVerdict } from './verdict.js';

const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

interface Args { scenes: string[]; reps: number; base: string; headOnly: boolean; headed: boolean; out: string; burnServerMs: number; burnClientMs: number }

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    scenes: (get('--scenes') ?? PERF_SCENES.map((s) => s.id).join(',')).split(',').filter(Boolean),
    reps: Number(get('--reps') ?? 5),
    base: get('--base') ?? 'origin/main',
    headOnly: argv.includes('--head-only'),
    headed: argv.includes('--headed'),
    out: get('--out') ?? path.resolve('perf/ledger'),
    // Self-test only: slow the HEAD arm on purpose; the verdict must go RED.
    burnServerMs: Number(get('--inject-server-burn') ?? 0),
    burnClientMs: Number(get('--inject-client-burn') ?? 0),
  };
}

const ROOT = process.cwd();

function prepareBase(ref: string): string {
  const dir = path.join(ROOT, '.claude', 'worktrees', 'perf-base');
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: ROOT, stdio: 'inherit' });
  if (!existsSync(dir)) {
    execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: ROOT, stdio: 'inherit' });
  } else {
    execFileSync('git', ['checkout', '-q', '--detach', ref], { cwd: dir, stdio: 'inherit' });
  }
  // Share the root packages through a junction. NEVER `git worktree remove`
  // this dir with the junction in place: it deletes through the link.
  const nm = path.join(dir, 'node_modules');
  if (!existsSync(nm)) {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'mklink', '/J', nm, path.join(ROOT, 'node_modules')], { stdio: 'ignore' });
    else spawnSync('ln', ['-s', path.join(ROOT, 'node_modules'), nm]);
  }
  return dir;
}

interface Arm { name: 'base' | 'head'; dir: string; ports: ServerPorts; servers: CaptureServers; sha: string; clientParams: Record<string, string> }

async function devPerf(serverUrl: string): Promise<{ rooms: Array<Record<string, any>> }> {
  return fetch(`${serverUrl}/dev/perf`).then((r) => r.json() as Promise<{ rooms: Array<Record<string, any>> }>);
}

async function runOnce(browser: Browser, arm: Arm, scene: PerfScene, log: (m: string) => void): Promise<RunMetrics> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  // Bytes received over the game socket, from DevTools network events: exact,
  // and no app instrumentation (works the same on a phone over adb).
  let rxBytes = 0;
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (e: { response: { opcode: number; payloadData: string } }) => {
    const d = e.response.payloadData;
    rxBytes += e.response.opcode === 1 ? d.length : Math.floor((d.length * 3) / 4);
  });
  try {
    const p = new URLSearchParams({
      room: `perf-${scene.id}`, testId: randomUUID(), spawnX: String(scene.spawn.x), spawnY: String(scene.spawn.y),
      shipKind: 'fighter', initialHull: '1000000', art: 'machined', fx: 'new', cleanworld: '1', hud: 'none', diag: '0', perfprobe: '1',
      ...arm.clientParams,
    });
    await page.goto(`${arm.servers.baseUrl}/?${p}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => !!(globalThis as { __eqxPerf?: unknown }).__eqxPerf, null, { timeout: 120_000 });
    // The loading curtain holds while art bakes; measure only after it lifts.
    await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 180_000 });
    await page.evaluate((c) => (globalThis as unknown as { __eqxCinema?: { play(c: unknown[]): void } }).__eqxCinema?.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: c.x, y: c.y, zoom: c.zoom * (1280 / 1920) } }]), scene.camera);
    await page.evaluate(() => (globalThis as unknown as { __eqxPerf: { reset(): Promise<void> } }).__eqxPerf.reset());
    rxBytes = 0;
    // Wait for the scene to end (server side).
    const deadline = Date.now() + scene.durationMs + 60_000;
    let room: Record<string, any> | undefined;
    for (;;) {
      room = (await devPerf(arm.servers.serverUrl)).rooms.find((r) => r['players'] > 0);
      if (room?.['scene']?.ended) break;
      if (Date.now() > deadline) throw new Error(`scene ${scene.id} never ended (${JSON.stringify(room?.['scene'])})`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const client = await page.evaluate(() => (globalThis as unknown as { __eqxPerf: { read(): Promise<any> } }).__eqxPerf.read());
    const s = room!;
    const minutes = Math.max(1e-3, client.elapsedMs / 60_000);
    const valid = s['scene'].refused === 0 && s['swarm'] >= scene.minSwarm && client.main.frames > 30;
    const m: RunMetrics = {
      valid,
      invalidReason: valid ? undefined : `refused ${s['scene'].refused}, swarm ${s['swarm']} (min ${scene.minSwarm}), frames ${client.main.frames}`,
      timing: {
        serverTickP95: s['tick'].p95, serverTickP99: s['tick'].p99, serverTickMax: s['tick'].max,
        workerTickP95: s['workerTick'].p95,
        clientFrameP95: client.main.p95, clientFrameP99: client.main.p99,
        clientHitchesPerMin: client.main.hitches / minutes,
        renderP95: client.render?.render.p95 ?? 0, renderP99: client.render?.render.p99 ?? 0,
        longTaskMsPerMin: client.longTaskMs / minutes,
      },
      counts: {
        rxKBps: rxBytes / 1024 / (client.elapsedMs / 1000),
        displayObjects: client.render?.displayObjects ?? 0,
        sprites: client.render?.sprites ?? 0,
        swarmAtEnd: s['swarm'],
        heapMb: client.heapMb ?? 0,
      },
      raw: { client, server: s },
    };
    log(`  ${arm.name.padEnd(4)} ${scene.id}: tick p95 ${m.timing.serverTickP95} ms · frame p95 ${m.timing.clientFrameP95} / p99 ${m.timing.clientFrameP99} ms · render p95 ${m.timing.renderP95} ms · hitches ${(m.timing.clientHitchesPerMin ?? 0).toFixed(1)}/min · rx ${(m.counts.rxKBps ?? 0).toFixed(0)} KB/s${valid ? '' : ' · INVALID: ' + m.invalidReason}`);
    return m;
  } finally {
    await ctx.close();
  }
}

function gitSha(dir: string): string {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenes = args.scenes.map((id) => {
    const s = PERF_SCENES.find((x) => x.id === id);
    if (!s) throw new Error(`unknown scene ${id} (have ${PERF_SCENES.map((x) => x.id).join(', ')})`);
    return s;
  });
  const runDir = path.join(ROOT, 'perf', '.run');
  rmSync(runDir, { recursive: true, force: true });
  const log = (m: string): void => { console.log(m); };

  const arms: Arm[] = [];
  const mk = (name: Arm['name'], dir: string, ports: ServerPorts): Arm => {
    const rd = path.join(runDir, name); mkdirSync(rd, { recursive: true });
    const head = name === 'head';
    const env: Record<string, string> = head && args.burnServerMs > 0 ? { EQX_PERF_BURN_MS: String(args.burnServerMs) } : {};
    const clientParams: Record<string, string> = head && args.burnClientMs > 0 ? { perfburn: String(args.burnClientMs) } : {};
    return { name, dir, ports, servers: new CaptureServers(dir, rd, ports, env), sha: gitSha(dir), clientParams };
  };
  if (!args.headOnly) arms.push(mk('base', prepareBase(args.base), { server: 2767, vite: 5373 }));
  arms.push(mk('head', ROOT, { server: 2768, vite: 5374 }));

  const browser = await chromium.launch({ headless: !args.headed, args: GPU_ARGS });
  const results: Record<string, Record<string, RunMetrics[]>> = {};
  try {
    log(`perf scenes: ${scenes.map((s) => s.id).join(', ')} · reps ${args.reps} · arms ${arms.map((a) => `${a.name}@${a.sha}`).join(' vs ')}`);
    for (const a of arms) { log(`starting ${a.name} servers…`); await a.servers.ensure('lean'); }
    for (const scene of scenes) {
      results[scene.id] = { base: [], head: [] };
      for (let rep = 0; rep < args.reps; rep++) {
        for (const a of arms) {
          let m: RunMetrics;
          try { m = await runOnce(browser, a, scene, log); } catch (e) {
            log(`  ${a.name} ${scene.id}: FAILED ${(e as Error).message}`);
            m = { valid: false, invalidReason: (e as Error).message, timing: {}, counts: {}, raw: null };
          }
          results[scene.id]![a.name]!.push(m);
        }
      }
    }
  } finally {
    await browser.close();
    for (const a of arms) a.servers.stop();
  }

  const verdicts: Record<string, ArmVerdict | null> = {};
  for (const scene of scenes) {
    const r = results[scene.id]!;
    verdicts[scene.id] = args.headOnly ? null : compareArms(r['base']!, r['head']!);
  }
  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const head = arms.find((a) => a.name === 'head')!;
  const file = path.join(args.out, `${stamp}-${head.sha}-desktop.json`);
  writeFileSync(file, JSON.stringify({
    when: new Date().toISOString(), device: 'desktop', reps: args.reps,
    arms: arms.map((a) => ({ name: a.name, sha: a.sha })),
    scenes: Object.fromEntries(scenes.map((s) => [s.id, {
      title: s.title,
      injected: { serverBurnMs: args.burnServerMs, clientBurnMs: args.burnClientMs },
      verdict: verdicts[s.id],
      base: results[s.id]!['base']!.map(({ raw: _raw, ...rest }) => rest),
      head: results[s.id]!['head']!.map(({ raw: _raw, ...rest }) => rest),
    }])),
  }, null, 2));
  log(`\nledger: ${path.relative(ROOT, file)}`);
  let red = false;
  for (const scene of scenes) {
    const v = verdicts[scene.id];
    if (!v) continue;
    log(`\n${scene.id}: ${v.status}`);
    for (const row of v.rows) log(`  ${row.status.padEnd(7)} ${row.metric.padEnd(20)} base ${row.base} · head ${row.head} · ×${row.ratio} · p=${row.p}`);
    if (v.status === 'RED' || v.status === 'INVALID') red = true;
  }
  rmSync(runDir, { recursive: true, force: true });
  process.exit(red ? 1 : 0);
}

void main().catch((e) => { console.error(e); process.exit(2); });
