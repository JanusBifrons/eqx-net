/* eslint-disable no-console -- a CLI: it reports on the console. */
/**
 * Perf scenes runner (plan prancy-squishing-donut P3; honest verdicts: plan
 * machine-independent-perf WS1).
 *
 *   pnpm perf:scenes [--scenes fleet-fight,teleport-raid] [--reps 8]
 *                    [--base origin/main] [--head-only] [--headed]
 *                    [--base-params k=v&k=v] [--head-params k=v&k=v]
 *                    [--base-env K=V&K=V] [--head-env K=V&K=V]   (server env per arm)
 *                    [--noise-check | --no-noise-check]
 *   (extra URL flags per arm: e.g. `--base HEAD --head-params shiplight=gpu`
 *   measures one switch on the same build)
 *                    [--device phone-proxy] [--cpu-rate 4]
 *   (phone-class run on this machine, no phone needed: CPU throttled 4x, a
 *   landscape phone screen at DPR 2.625, touch. A proxy, not the device:
 *   the laptop's integrated GPU stands in for a phone GPU)
 *
 * Plays each scene in a real browser (real GPU) against an isolated server
 * pair per arm, interleaved base/head/base/head on the same machine in the
 * same session, so the laptop's own noise cancels. Reads the client probe
 * (`?perfprobe=1`, `window.__eqxPerf`) and the server (`GET /dev/perf`), writes
 * one JSON to `perf/ledger/`, and prints a verdict per scene and metric:
 * RED, GREEN or INCONCLUSIVE (perf/verdict.ts). Exit code: 0 GREEN, 1 RED or
 * INVALID, 3 INCONCLUSIVE, 2 crashed.
 *
 * Reps: default 8; odd counts round UP to even so each arm runs second in a
 * round equally often (the second slot runs on a warmer machine). Below 4 reps
 * per arm the exact test can never reject, so the verdict can't be GREEN.
 *
 * `--noise-check` adds a third arm, `aa`: the base build and params again. The
 * base-vs-aa spread is this host's same-code noise; a head-vs-base move inside
 * it can't be RED. On by default when base and head are the same commit with
 * the same params (an A/A run), opt-in otherwise.
 *
 * Host load (WS2, showcase/hostLoad.ts): before and after every rep the runner
 * samples system CPU, free RAM and foreign game servers / Vites (another
 * session's). A rep is INVALID and repeated (up to 2 more times) when free RAM
 * < 1 GB, CPU > 25 % of all cores before it starts, or a foreign game server
 * or Vite is listening. `--ignore-ports 2567,5173` acknowledges known
 * listeners (recorded in the ledger). `--max-cpu-pct N` moves the CPU limit;
 * `--no-load-gate` records only.
 *
 * Ports: base 2767/5373, head 2768/5374, shifted by EQX_SHOWCASE_PORT_OFFSET.
 *
 * The base arm is a git worktree at `.claude/worktrees/perf-base`, linked to
 * the root `node_modules`. `--head-only` skips the A/B (a quick look).
 */
import { chromium, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureServers, defaultPorts, portOffset, type ServerPorts } from '../showcase/servers.js';
import { DEFAULT_LIMITS, judgeLoad, sampleHostLoad, type LoadLimits } from '../showcase/hostLoad.js';
import { PERF_SCENES, type PerfScene } from '../src/shared-types/perf/perfScenes.js';
import { compareArms, MIN_DECISIVE_REPS, type RunMetrics, type ArmVerdict } from './verdict.js';
import { armOrder, evenReps } from './order.js';

const GPU_ARGS = ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];

interface Args { scenes: string[]; reps: number; base: string; headOnly: boolean; headed: boolean; out: string; burnServerMs: number; burnClientMs: number; append: string | undefined; baseParams: string; headParams: string; baseEnv: string; headEnv: string; device: 'desktop' | 'phone-proxy'; cpuRate: number; noiseCheck: boolean | undefined; ignorePorts: number[]; loadGate: boolean; limits: LoadLimits }

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  return {
    scenes: (get('--scenes') ?? PERF_SCENES.map((s) => s.id).join(',')).split(',').filter(Boolean),
    reps: Number(get('--reps') ?? 8),
    base: get('--base') ?? 'origin/main',
    headOnly: argv.includes('--head-only'),
    headed: argv.includes('--headed'),
    out: get('--out') ?? path.resolve('perf/ledger'),
    // Self-test only: slow the HEAD arm on purpose; the verdict must go RED.
    burnServerMs: Number(get('--inject-server-burn') ?? 0),
    burnClientMs: Number(get('--inject-client-burn') ?? 0),
    // Add this run's reps to an existing ledger file and re-judge all of them
    // (lets a long A/B run as short foreground chunks).
    append: get('--append'),
    device: get('--device') === 'phone-proxy' ? 'phone-proxy' : 'desktop',
    cpuRate: Number(get('--cpu-rate') ?? PHONE_PROXY.cpuRate),
    baseParams: get('--base-params') ?? '',
    headParams: get('--head-params') ?? '',
    // Server env per arm, same `k=v&k=v` form (a process-wide switch on one
    // arm of a same-commit A/B, e.g. EQX_NAVAL_RANGE=real).
    baseEnv: get('--base-env') ?? '',
    headEnv: get('--head-env') ?? '',
    // undefined = decide from the arms (on for an A/A run).
    noiseCheck: argv.includes('--noise-check') ? true : argv.includes('--no-noise-check') ? false : undefined,
    ignorePorts: (get('--ignore-ports') ?? '').split(',').filter(Boolean).map(Number),
    loadGate: !argv.includes('--no-load-gate'),
    limits: { ...DEFAULT_LIMITS, ...(get('--max-cpu-pct') ? { maxCpuPct: Number(get('--max-cpu-pct')) } : {}) },
  };
}

const ROOT = process.cwd();
/** A rep measured on a busy host is repeated at most this many more times. */
const MAX_LOAD_RETRIES = 2;
const LOAD_RETRY_WAIT_MS = 15_000;

function prepareBase(ref: string): string {
  const dir = path.join(ROOT, '.claude', 'worktrees', 'perf-base');
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: ROOT, stdio: 'inherit' });
  // Resolve the ref HERE: `HEAD` checked out inside the perf-base worktree is
  // that worktree's own (stale) HEAD, not this checkout's.
  ref = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT }).toString().trim();
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

type ArmName = 'base' | 'head' | 'aa';
interface Arm { name: ArmName; dir: string; ports: ServerPorts; servers: CaptureServers; sha: string; clientParams: Record<string, string>; serverEnv: Record<string, string> }

async function devPerf(serverUrl: string): Promise<{ rooms: Array<Record<string, any>> }> {
  return fetch(`${serverUrl}/dev/perf`).then((r) => r.json() as Promise<{ rooms: Array<Record<string, any>> }>);
}

/** Phone-class proxy: a mid phone's CPU (Chrome throttle) and screen. */
const PHONE_PROXY = { viewport: { width: 915, height: 412 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, cpuRate: 4 };

/** Client URL flags every arm gets; an arm's own params override them. */
const BASE_CLIENT_PARAMS: Record<string, string> = { shipKind: 'fighter', initialHull: '1000000', art: 'machined', fx: 'new', diag: '0', perfprobe: '1' };

async function runOnce(browser: Browser, arm: Arm, scene: PerfScene, log: (m: string) => void, device: Args['device'] = 'desktop', cpuRate = PHONE_PROXY.cpuRate): Promise<RunMetrics> {
  const phone = device === 'phone-proxy';
  const ctx = await browser.newContext(phone
    ? { viewport: PHONE_PROXY.viewport, deviceScaleFactor: PHONE_PROXY.deviceScaleFactor, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  if (phone) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
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
      ...BASE_CLIENT_PARAMS,
      ...(scene.pilotKind ? { shipKind: scene.pilotKind } : {}),
      ...arm.clientParams,
    });
    await page.goto(`${arm.servers.baseUrl}/?${p}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => !!(globalThis as { __eqxPerf?: unknown }).__eqxPerf, null, { timeout: 120_000 });
    // The loading curtain holds while art bakes; measure only after it lifts.
    await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 180_000 });
    await page.evaluate((c) => (globalThis as unknown as { __eqxCinema?: { play(c: unknown[]): void } }).__eqxCinema?.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: c.x, y: c.y, zoom: c.zoom * (c.vw / 1920) } }]), { ...scene.camera, vw: phone ? PHONE_PROXY.viewport.width : 1280 });
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
        // Server CPU time (WS3, print-only): process CPU per tick (includes the
        // tick loop's setImmediate spin + workers), sampled update() CPU, worker ELU.
        ...(s['work']?.cpuMsPerTick != null ? { serverCpuMsPerTick: s['work'].cpuMsPerTick } : {}),
        ...(s['work']?.updateCpuMsPerTick != null ? { serverUpdateCpuMsPerTick: s['work'].updateCpuMsPerTick } : {}),
        ...(s['work']?.workerElu != null ? { workerElu: s['work'].workerElu } : {}),
      },
      counts: {
        rxKBps: rxBytes / 1024 / (client.elapsedMs / 1000),
        displayObjects: client.render?.displayObjects ?? 0,
        sprites: client.render?.sprites ?? 0,
        swarmAtEnd: s['swarm'],
        heapMb: client.heapMb ?? 0,
        // Server work per tick (WS3; gated per PR by perfSceneCounts.test.ts).
        ...(s['work'] ? {
          serverBodiesPerTick: s['work'].bodiesPerTick, serverContactsPerTick: s['work'].contactsPerTick,
          serverAiAgentsPerTick: s['work'].aiAgentsPerTick, serverSwarmRecordsPerTick: s['work'].swarmRecordsPerTick,
          serverSwarmBytesPerTick: s['work'].swarmBytesPerTick, serverEntitiesPerSnapshot: s['work'].entitiesPerSnapshot,
        } : {}),
      },
      raw: { client, server: s },
    };
    log(`  ${arm.name.padEnd(4)} ${scene.id}: tick p95 ${m.timing.serverTickP95} ms · frame p95 ${m.timing.clientFrameP95} / p99 ${m.timing.clientFrameP99} ms · render p95 ${m.timing.renderP95} ms · hitches ${(m.timing.clientHitchesPerMin ?? 0).toFixed(1)}/min · rx ${(m.counts.rxKBps ?? 0).toFixed(0)} KB/s${s['simTime'] ? ` · sim behind ${s['simTime'].latenessTicks}/${s['simTime'].wallTicks} ticks (dropped ${s['simTime'].droppedTicks})` : ''}${valid ? '' : ' · INVALID: ' + m.invalidReason}`);
    return m;
  } finally {
    await ctx.close();
  }
}

/** The GPU the browser really renders with (UNMASKED_RENDERER_WEBGL). */
async function gpuRenderer(browser: Browser): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'no webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
  } catch (e) { return `unknown (${(e as Error).message})`; } finally { await page.close(); }
}

/** What machine this ran on (the ledger must say; numbers from two hosts never compare). */
function hostProfile(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, node: process.version,
    cpuModel: cpus[0]?.model.trim() ?? 'unknown', threads: cpus.length,
    totalMemMb: Math.round(os.totalmem() / 2 ** 20), freeMemMbAtStart: Math.round(os.freemem() / 2 ** 20),
  };
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
  // A per-run dir: a killed run's servers can hold the old one's DB open
  // (Windows EPERM), which must not block the next run.
  const runRoot = path.join(ROOT, 'perf', '.run');
  try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* files of a killed run still open */ }
  const runDir = path.join(runRoot, String(process.pid));
  const log = (m: string): void => { console.log(m); };

  const reps = args.headOnly ? Math.max(1, Math.floor(args.reps)) : evenReps(args.reps);
  if (reps !== args.reps) log(`--reps ${args.reps} rounded up to ${reps}: an even count runs each arm second equally often`);
  if (!args.headOnly && reps < MIN_DECISIVE_REPS) log(`note: ${reps} reps per arm can never reach p < 0.05; the verdict will be INCONCLUSIVE at best`);

  const arms: Arm[] = [];
  const mk = (name: ArmName, dir: string, ports: ServerPorts): Arm => {
    const rd = path.join(runDir, name); mkdirSync(rd, { recursive: true });
    const head = name === 'head';
    const serverEnv: Record<string, string> = head && args.burnServerMs > 0 ? { EQX_PERF_BURN_MS: String(args.burnServerMs) } : {};
    const clientParams: Record<string, string> = head && args.burnClientMs > 0 ? { perfburn: String(args.burnClientMs) } : {};
    for (const [k, v] of new URLSearchParams(head ? args.headParams : args.baseParams)) clientParams[k] = v;
    for (const [k, v] of new URLSearchParams(head ? args.headEnv : args.baseEnv)) serverEnv[k] = v;
    return { name, dir, ports, servers: new CaptureServers(dir, rd, ports, serverEnv), sha: gitSha(dir), clientParams, serverEnv };
  };
  const basePorts: ServerPorts = defaultPorts();
  const headPorts: ServerPorts = { server: basePorts.server + 1, vite: basePorts.vite + 1 };
  let baseDir: string | null = null;
  if (!args.headOnly) { baseDir = prepareBase(args.base); arms.push(mk('base', baseDir, basePorts)); }
  arms.push(mk('head', ROOT, headPorts));
  const same = (a: Arm, b: Arm): boolean => a.sha === b.sha
    && JSON.stringify(a.clientParams) === JSON.stringify(b.clientParams) && JSON.stringify(a.serverEnv) === JSON.stringify(b.serverEnv);
  const noiseCheck = !args.headOnly && (args.noiseCheck ?? same(arms[0]!, arms[1]!));
  // The A/A arm: base again, its own fresh servers on the base ports (one
  // arm's servers run at a time, so they never clash).
  if (noiseCheck) arms.push(mk('aa', baseDir!, basePorts));

  // --append: earlier chunks of this A/B (their reps join the verdict).
  type ArmRecord = { name: string; sha: string; clientParams?: Record<string, string>; serverEnv?: Record<string, string> };
  type Ledger = { when: string; device: string; reps: number; arms: ArmRecord[]; scenes: Record<string, { title: string; injected: unknown; verdict: ArmVerdict | null; base: RunMetrics[]; head: RunMetrics[]; aa?: RunMetrics[] }> };
  const prior: Ledger | null = args.append && existsSync(args.append) ? (JSON.parse(readFileSync(args.append, 'utf8')) as Ledger) : null;
  if (prior) {
    const shas = arms.map((a) => `${a.name}@${a.sha}`).join(' ');
    const priorShas = prior.arms.map((a) => `${a.name}@${a.sha}`).join(' ');
    if (shas !== priorShas) throw new Error(`--append: arms differ (${priorShas} vs ${shas})`);
  }
  const priorReps = prior ? prior.reps : 0;

  const loadOpts = { ignorePorts: args.ignorePorts, portOffsets: [portOffset()] };
  if (args.ignorePorts.length) log(`load gate: ignoring listeners on ${args.ignorePorts.join(', ')} (acknowledged)`);
  const startLoad = await sampleHostLoad(loadOpts);
  log(`host load: CPU ${startLoad.cpuPct}% of ${startLoad.threads} threads · free RAM ${startLoad.freeMemMb} MB · other node ${startLoad.foreignProcs.node} / chrome ${startLoad.foreignProcs.chrome}${startLoad.foreignListeners.length ? ` · foreign listeners ${startLoad.foreignListeners.map((l) => `:${l.port} pid ${l.pid}`).join(', ')}` : ''}`);

  const browser = await chromium.launch({ headless: !args.headed, args: GPU_ARGS });
  const results: Record<string, Record<ArmName, RunMetrics[]>> = {};
  let gpu = 'unknown';
  try {
    gpu = await gpuRenderer(browser);
    log(`perf scenes: ${scenes.map((s) => s.id).join(', ')} · reps ${reps} · arms ${arms.map((a) => `${a.name}@${a.sha}`).join(' vs ')}${noiseCheck ? ' (aa = A/A noise check)' : ''} · GPU ${gpu}`);
    // One arm's servers at a time (an 8 GB laptop can't hold two pairs plus a
    // GPU browser). Each rep boots one arm, plays every scene, then swaps.
    // Order rotates per rep (armOrder): the arm that runs second in a round
    // runs on a warmer machine, and a fixed order showed up as head-only extra
    // hitches in the first self-test.
    for (const scene of scenes) results[scene.id] = { base: [], head: [], aa: [] };
    for (let rep = 0; rep < reps; rep++) {
      for (const a of armOrder(arms, priorReps + rep)) {
        for (const o of arms) if (o !== a) o.servers.stop();
        log(`rep ${rep + 1}/${reps}: ${a.name} servers…`);
        await a.servers.ensure('lean');
        for (const scene of scenes) {
          // Host-load gate: a rep measured on a loaded host is INVALID and is
          // repeated (at most MAX_LOAD_RETRIES more times). Every attempt
          // stays in the ledger; the verdict only counts valid ones.
          for (let attempt = 0; attempt <= MAX_LOAD_RETRIES; attempt++) {
            const before = await sampleHostLoad(loadOpts);
            const pre = judgeLoad(before, { gateCpu: true, limits: args.limits });
            let m: RunMetrics;
            if (args.loadGate && pre.length) {
              // Don't spend a scene on a host already known to be busy.
              m = { valid: false, invalidReason: `host busy: ${pre.join('; ')}`, timing: {}, counts: {}, raw: null };
            } else {
              try { m = await runOnce(browser, a, scene, log, args.device, args.cpuRate); } catch (e) {
                log(`  ${a.name} ${scene.id}: FAILED ${(e as Error).message}`);
                m = { valid: false, invalidReason: (e as Error).message, timing: {}, counts: {}, raw: null };
              }
            }
            const after = await sampleHostLoad(loadOpts);
            const post = judgeLoad(after, { gateCpu: false, limits: args.limits });
            m.load = { before, after };
            const busy = args.loadGate && (pre.length > 0 || post.length > 0);
            if (busy && m.valid) { m.valid = false; m.invalidReason = `host busy: ${[...pre, ...post].join('; ')}`; }
            results[scene.id]![a.name].push(m);
            if (!busy) break;
            const left = MAX_LOAD_RETRIES - attempt;
            log(`  ${a.name} ${scene.id}: INVALID (${m.invalidReason})${left > 0 ? ` — repeating (${attempt + 1}/${MAX_LOAD_RETRIES}) in ${LOAD_RETRY_WAIT_MS / 1000} s` : ' — no retries left'}`);
            if (left > 0) await new Promise((r) => setTimeout(r, LOAD_RETRY_WAIT_MS));
          }
        }
      }
    }
  } finally {
    await browser.close();
    for (const a of arms) a.servers.stop();
  }

  if (prior) {
    for (const scene of scenes) {
      const old = prior.scenes[scene.id];
      if (!old) continue;
      results[scene.id]!.base.unshift(...old.base);
      results[scene.id]!.head.unshift(...old.head);
      results[scene.id]!.aa.unshift(...(old.aa ?? []));
    }
  }
  const verdicts: Record<string, ArmVerdict | null> = {};
  for (const scene of scenes) {
    const r = results[scene.id]!;
    verdicts[scene.id] = args.headOnly ? null : compareArms(r.base, r.head, noiseCheck ? { noise: r.aa } : {});
  }
  mkdirSync(args.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const head = arms.find((a) => a.name === 'head')!;
  const file = args.append ?? path.join(args.out, `${stamp}-${head.sha}-${args.device}.json`);
  const strip = (runs: RunMetrics[]): RunMetrics[] => runs.map(({ raw: _raw, ...rest }) => ({ ...rest, raw: null }));
  writeFileSync(file, JSON.stringify({
    // Rounds played (every attempt, valid or not, is in the arm lists).
    when: new Date().toISOString(), device: args.device, reps: priorReps + reps,
    cpuRate: args.device === 'phone-proxy' ? args.cpuRate : undefined,
    noiseCheck,
    host: { ...hostProfile(), gpuRenderer: gpu, browserArgs: GPU_ARGS, headed: args.headed },
    load: { gate: args.loadGate, limits: args.limits, ignorePorts: args.ignorePorts, portOffset: portOffset(), atStart: startLoad },
    arms: arms.map((a) => ({ name: a.name, sha: a.sha, clientParams: { ...BASE_CLIENT_PARAMS, ...a.clientParams }, serverEnv: a.serverEnv })),
    scenes: Object.fromEntries(scenes.map((s) => [s.id, {
      title: s.title,
      injected: { serverBurnMs: args.burnServerMs, clientBurnMs: args.burnClientMs },
      verdict: verdicts[s.id],
      base: strip(results[s.id]!.base),
      head: strip(results[s.id]!.head),
      ...(noiseCheck ? { aa: strip(results[s.id]!.aa) } : {}),
    }])),
  }, null, 2));
  log(`\nledger: ${path.relative(ROOT, file)}`);
  let worst: ArmVerdict['status'] | 'NONE' = 'NONE';
  const severity = { NONE: 0, GREEN: 1, INCONCLUSIVE: 2, RED: 3, INVALID: 3 } as const;
  for (const scene of scenes) {
    const v = verdicts[scene.id];
    if (!v) continue;
    log(`\n${scene.id}: ${v.status}${v.reason ? ` (${v.reason})` : ''}`);
    for (const row of v.rows) {
      const extra = `${row.noise !== undefined ? ` · A/A ×${row.noise}` : ''}${row.note ? ` · ${row.note}` : ''}`;
      log(`  ${row.status.padEnd(12)} ${row.metric.padEnd(20)} base ${row.base} · head ${row.head} · ×${row.ratio} · p=${row.p}${extra}`);
    }
    if (severity[v.status] > severity[worst]) worst = v.status;
  }
  try { rmSync(runDir, { recursive: true, force: true }); } catch { /* removed by the next run */ }
  process.exit(worst === 'RED' || worst === 'INVALID' ? 1 : worst === 'INCONCLUSIVE' ? 3 : 0);
}

void main().catch((e) => { console.error(e); process.exit(2); });
