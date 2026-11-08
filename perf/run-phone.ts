/* eslint-disable no-console -- a CLI: it reports on the console. */
/**
 * Phone lane (plan machine-independent-perf WS5.1): the perf-scenes A/B on a
 * REAL Android phone over adb.
 *
 *   pnpm perf:phone [--scenes fleet-fight,wide-view] [--reps 8]
 *                   [--base origin/main] [--base-params k=v&k=v] [--head-params k=v&k=v]
 *                   [--noise-check | --no-noise-check] [--head-only]
 *                   [--serial <adb serial>] [--lan] [--max-thermal 2]
 *                   [--append <ledger>] [--ignore-ports ..] [--max-cpu-pct N] [--no-load-gate]
 *
 * Same arms, order, verdict and ledger as `pnpm perf:scenes` (perf/order.ts,
 * perf/verdict.ts); the browser is Chrome on the phone, driven through
 * Playwright's `_android` (the path tests/mobile-perf/helpers/androidConnect.ts
 * proved). The servers run on this machine; the phone reaches Vite through
 * `adb reverse` (USB or wireless adb) or, with `--lan`, the LAN IP.
 *
 * Per rep the phone's thermal status is read (`dumpsys thermalservice`): a
 * phone at or above `--max-thermal` (default 2 = MODERATE) is throttling its
 * own clocks, so the rep is INVALID and repeated after a cool-down, the same
 * way a busy laptop is (showcase/hostLoad.ts gate, which still applies: the
 * server arm runs here).
 *
 * Exit: 0 GREEN, 1 RED or INVALID, 3 INCONCLUSIVE, 2 crashed, 4 no usable
 * phone (adb missing, nothing attached, unauthorized, several without --serial).
 *
 * Prerequisites on the phone: USB debugging on, the screen unlocked and kept
 * awake, Chrome installed, and chrome://flags/#enable-command-line-on-non-rooted-devices
 * Enabled (Playwright's `_android` needs it; see androidConnect.ts).
 */
import { _android, type AndroidDevice, type BrowserContext } from 'playwright';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureServers, defaultPorts, portOffset, type ServerPorts } from '../showcase/servers.js';
import { judgeLoad, sampleHostLoad } from '../showcase/hostLoad.js';
import { PERF_SCENES, type PerfScene } from '../src/shared-types/perf/perfScenes.js';
import { pickLanIp } from '../tests/mobile-perf/helpers/lanIp.js';
import { compareArms, MIN_DECISIVE_REPS, type RunMetrics, type ArmVerdict } from './verdict.js';
import {
  deviceLabel, judgePhone, paramWarnings, parseAwake, parsePhoneArgs, parseThermalStatus, PhoneLaneError,
  phoneProps, phoneReps, planArms, planRounds, requirePhone, type AdbExec, type ArmName, type PhoneProps,
} from './phoneLane.js';

const ROOT = process.cwd();
const MAX_RETRIES = 2;
const RETRY_WAIT_MS = 30_000;

/** Same client URL flags as perf:scenes' arms (an arm's own params override them). */
const BASE_CLIENT_PARAMS: Record<string, string> = { shipKind: 'fighter', initialHull: '1000000', art: 'machined', fx: 'new', diag: '0', perfprobe: '1' };

const adb: AdbExec = (args) => execFileSync('adb', args as string[], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });

function prepareBase(ref: string): string {
  // Same worktree + node_modules junction as perf:scenes (see run-perf.ts).
  const dir = path.join(ROOT, '.claude', 'worktrees', 'perf-base');
  execFileSync('git', ['fetch', '-q', 'origin'], { cwd: ROOT, stdio: 'inherit' });
  // Resolve here: `HEAD` inside the perf-base worktree would be its own HEAD.
  ref = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ROOT }).toString().trim();
  if (!existsSync(dir)) execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { cwd: ROOT, stdio: 'inherit' });
  else execFileSync('git', ['checkout', '-q', '--detach', ref], { cwd: dir, stdio: 'inherit' });
  const nm = path.join(dir, 'node_modules');
  if (!existsSync(nm)) {
    if (process.platform === 'win32') spawnSync('cmd', ['/c', 'mklink', '/J', nm, path.join(ROOT, 'node_modules')], { stdio: 'ignore' });
    else spawnSync('ln', ['-s', path.join(ROOT, 'node_modules'), nm]);
  }
  return dir;
}

const gitSha = (dir: string): string => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir }).toString().trim();

interface Arm { name: ArmName; dir: string; ports: ServerPorts; servers: CaptureServers; sha: string; clientParams: Record<string, string> }

async function devPerf(serverUrl: string): Promise<{ rooms: Array<Record<string, any>> }> {
  return fetch(`${serverUrl}/dev/perf`).then((r) => r.json() as Promise<{ rooms: Array<Record<string, any>> }>);
}

function phoneState(serial: string): { thermal: number; awake: boolean; locked: boolean } {
  const sh = (...a: string[]): string => { try { return adb(['-s', serial, 'shell', ...a]); } catch { return ''; } };
  return { thermal: parseThermalStatus(sh('dumpsys', 'thermalservice')), ...parseAwake(sh('dumpsys', 'power'), sh('dumpsys', 'window')) };
}

/** One scene on the phone: the same probe reads and metrics as run-perf.ts runOnce. */
async function runOnce(ctx: BrowserContext, arm: Arm, origin: string, scene: PerfScene, log: (m: string) => void): Promise<RunMetrics> {
  const page = await ctx.newPage();
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
      ...BASE_CLIENT_PARAMS, ...arm.clientParams,
    });
    await page.goto(`${origin}/?${p}`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForFunction(() => !!(globalThis as { __eqxPerf?: unknown }).__eqxPerf, null, { timeout: 120_000 });
    await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"]', { state: 'attached', timeout: 240_000 });
    // Frame the scene by the phone's own CSS width, as perf:scenes does by its viewport.
    await page.evaluate((c) => {
      const g = globalThis as unknown as { innerWidth: number; __eqxCinema?: { play(c: unknown[]): void } };
      g.__eqxCinema?.play([{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: c.x, y: c.y, zoom: c.zoom * (g.innerWidth / 1920) } }]);
    }, scene.camera);
    await page.evaluate(() => (globalThis as unknown as { __eqxPerf: { reset(): Promise<void> } }).__eqxPerf.reset());
    rxBytes = 0;
    const deadline = Date.now() + scene.durationMs + 90_000;
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
    await page.close().catch(() => undefined);
  }
}

async function gpuRenderer(ctx: BrowserContext): Promise<string> {
  const page = await ctx.newPage();
  try {
    return await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'no webgl';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    });
  } catch (e) { return `unknown (${(e as Error).message})`; } finally { await page.close().catch(() => undefined); }
}

async function launchChrome(device: AndroidDevice): Promise<BrowserContext> {
  try {
    return await device.launchBrowser();
  } catch (e) {
    throw new PhoneLaneError(
      'Chrome on the phone failed to launch. The usual cause: chrome://flags/#enable-command-line-on-non-rooted-devices is off '
      + '(enable it, tap Relaunch). Also check the phone is unlocked and Chrome (not another browser) is installed.\n'
      + `Original: ${(e as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parsePhoneArgs(process.argv.slice(2), PERF_SCENES.map((s) => s.id));
  const log = (m: string): void => { console.log(m); };
  // Fail fast: no phone, no servers, no worktree.
  const dev = requirePhone(adb, args.serial);
  const props: PhoneProps = phoneProps(adb, dev.serial);
  log(`phone: ${props.manufacturer} ${props.model} · Android ${props.android} (SDK ${props.sdk}) · SoC ${props.soc} · serial ${dev.serial}`);
  const scenes = args.scenes.map((id) => PERF_SCENES.find((x) => x.id === id)!);

  const reps = phoneReps(args);
  if (reps !== args.reps) log(`--reps ${args.reps} rounded up to ${reps}: an even count runs each arm second equally often`);
  if (!args.headOnly && reps < MIN_DECISIVE_REPS) log(`note: ${reps} reps per arm can never reach p < 0.05; the verdict will be INCONCLUSIVE at best`);

  const runRoot = path.join(ROOT, 'perf', '.run');
  try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* a killed run's files */ }
  const runDir = path.join(runRoot, String(process.pid));
  const basePorts = defaultPorts();
  const headPorts: ServerPorts = { server: basePorts.server + 1, vite: basePorts.vite + 1 };
  const baseDir = args.headOnly ? null : prepareBase(args.base);
  const plan = planArms(args, baseDir ? gitSha(baseDir) : null, gitSha(ROOT));
  for (const w of paramWarnings(plan.arms)) log(w);
  const arms: Arm[] = plan.arms.map((spec) => {
    const dir = spec.name === 'head' ? ROOT : baseDir!;
    const ports = spec.name === 'head' ? headPorts : basePorts;
    const rd = path.join(runDir, spec.name); mkdirSync(rd, { recursive: true });
    return { name: spec.name, dir, ports, servers: new CaptureServers(dir, rd, ports, {}), sha: gitSha(dir), clientParams: spec.clientParams };
  });

  type Ledger = { reps: number; arms: Array<{ name: string; sha: string }>; scenes: Record<string, { base: RunMetrics[]; head: RunMetrics[]; aa?: RunMetrics[] }> };
  const prior: Ledger | null = args.append && existsSync(args.append) ? (JSON.parse(readFileSync(args.append, 'utf8')) as Ledger) : null;
  if (prior) {
    const shas = arms.map((a) => `${a.name}@${a.sha}`).join(' ');
    const priorShas = prior.arms.map((a) => `${a.name}@${a.sha}`).join(' ');
    if (shas !== priorShas) throw new Error(`--append: arms differ (${priorShas} vs ${shas})`);
  }
  const priorReps = prior ? prior.reps : 0;

  // How the phone reaches this machine's Vite: adb reverse maps the phone's
  // localhost:<port> to ours (works over USB and wireless adb, no Wi-Fi
  // routing, and localhost is a secure context); --lan uses the LAN IP.
  const host = args.lan ? pickLanIp() : 'localhost';
  const origin = (a: Arm): string => `http://${host}:${a.ports.vite}`;
  const reversed: number[] = [];
  if (!args.lan) {
    for (const port of new Set(arms.map((a) => a.ports.vite))) {
      adb(['-s', dev.serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
      reversed.push(port);
    }
  }

  const loadOpts = { ignorePorts: args.ignorePorts, portOffsets: [portOffset()] };
  const startLoad = await sampleHostLoad(loadOpts);
  const device = (await _android.devices()).find((d) => d.serial() === dev.serial);
  if (!device) throw new PhoneLaneError(`adb lists ${dev.serial} but Playwright's _android does not; restart adb (\`adb kill-server\`) and re-run.`);
  const results: Record<string, Record<ArmName, RunMetrics[]>> = {};
  for (const scene of scenes) results[scene.id] = { base: [], head: [], aa: [] };
  let gpu = 'unknown';
  let thermalStart = -1;
  try {
    const probe = await launchChrome(device);
    gpu = await gpuRenderer(probe);
    await probe.close();
    thermalStart = phoneState(dev.serial).thermal;
    log(`perf phone: ${deviceLabel(props, gpu)} · scenes ${scenes.map((s) => s.id).join(', ')} · reps ${reps} · arms ${arms.map((a) => `${a.name}@${a.sha}`).join(' vs ')}${plan.noiseCheck ? ' (aa = A/A noise check)' : ''} · via ${args.lan ? `LAN ${host}` : 'adb reverse'}`);
    const rounds = planRounds(arms, reps, priorReps);
    for (let rep = 0; rep < rounds.length; rep++) {
      for (const a of rounds[rep]!) {
        for (const o of arms) if (o !== a) o.servers.stop();
        log(`rep ${rep + 1}/${reps}: ${a.name} servers…`);
        await a.servers.ensure('lean');
        for (const scene of scenes) {
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const before = await sampleHostLoad(loadOpts);
            const phoneBefore = phoneState(dev.serial);
            const pre = [...judgeLoad(before, { gateCpu: true, limits: args.limits }), ...judgePhone(phoneBefore, args.maxThermal)];
            let m: RunMetrics;
            if (args.loadGate && pre.length) {
              m = { valid: false, invalidReason: `not fit to measure: ${pre.join('; ')}`, timing: {}, counts: {}, raw: null };
            } else {
              // A fresh Chrome per run, like perf:scenes' fresh context per run.
              const ctx = await launchChrome(device);
              try { m = await runOnce(ctx, a, origin(a), scene, log); } catch (e) {
                log(`  ${a.name} ${scene.id}: FAILED ${(e as Error).message}`);
                m = { valid: false, invalidReason: (e as Error).message, timing: {}, counts: {}, raw: null };
              } finally { await ctx.close().catch(() => undefined); }
            }
            const after = await sampleHostLoad(loadOpts);
            const phoneAfter = phoneState(dev.serial);
            const post = judgeLoad(after, { gateCpu: false, limits: args.limits });
            m.load = { before: { host: before, phone: phoneBefore }, after: { host: after, phone: phoneAfter } };
            const busy = args.loadGate && (pre.length > 0 || post.length > 0);
            if (busy && m.valid) { m.valid = false; m.invalidReason = `not fit to measure: ${[...pre, ...post].join('; ')}`; }
            results[scene.id]![a.name].push(m);
            if (!busy) break;
            const left = MAX_RETRIES - attempt;
            log(`  ${a.name} ${scene.id}: INVALID (${m.invalidReason})${left > 0 ? ` — repeating (${attempt + 1}/${MAX_RETRIES}) in ${RETRY_WAIT_MS / 1000} s` : ' — no retries left'}`);
            if (left > 0) await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
          }
        }
      }
    }
  } finally {
    for (const a of arms) a.servers.stop();
    for (const port of reversed) { try { adb(['-s', dev.serial, 'reverse', '--remove', `tcp:${port}`]); } catch { /* unplugged */ } }
    await device.close().catch(() => undefined);
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
    verdicts[scene.id] = args.headOnly ? null : compareArms(r.base, r.head, plan.noiseCheck ? { noise: r.aa } : {});
  }
  const out = args.out ?? path.resolve('perf/ledger');
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const head = arms.find((a) => a.name === 'head')!;
  const slug = props.model.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
  const file = args.append ?? path.join(out, `${stamp}-${head.sha}-phone-${slug}.json`);
  const strip = (runs: RunMetrics[]): RunMetrics[] => runs.map(({ raw: _raw, ...rest }) => ({ ...rest, raw: null }));
  const cpus = os.cpus();
  writeFileSync(file, JSON.stringify({
    when: new Date().toISOString(),
    // The device IS the phone here: model, Android version and the GPU it really rendered with.
    device: `phone · ${deviceLabel(props, gpu)}`,
    reps: priorReps + reps,
    noiseCheck: plan.noiseCheck,
    phone: { ...props, serial: dev.serial, gpuRenderer: gpu, via: args.lan ? `lan ${host}` : 'adb reverse', maxThermal: args.maxThermal, thermalAtStart: thermalStart },
    // The laptop still runs the servers: its profile and load matter to the server metrics.
    host: { hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, node: process.version, cpuModel: cpus[0]?.model.trim() ?? 'unknown', threads: cpus.length, totalMemMb: Math.round(os.totalmem() / 2 ** 20), freeMemMbAtStart: Math.round(os.freemem() / 2 ** 20), gpuRenderer: gpu },
    load: { gate: args.loadGate, limits: args.limits, ignorePorts: args.ignorePorts, portOffset: portOffset(), atStart: startLoad },
    arms: arms.map((a) => ({ name: a.name, sha: a.sha, clientParams: { ...BASE_CLIENT_PARAMS, ...a.clientParams }, serverEnv: {} })),
    scenes: Object.fromEntries(scenes.map((s) => [s.id, {
      title: s.title,
      injected: { serverBurnMs: 0, clientBurnMs: 0 },
      verdict: verdicts[s.id],
      base: strip(results[s.id]!.base),
      head: strip(results[s.id]!.head),
      ...(plan.noiseCheck ? { aa: strip(results[s.id]!.aa) } : {}),
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

void main().catch((e) => {
  if (e instanceof PhoneLaneError) { console.error(`perf:phone: ${e.message}`); process.exit(4); }
  console.error(e);
  process.exit(2);
});
