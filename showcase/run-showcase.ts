/**
 * Showcase video pipeline — CLI (docs/architecture/showcase-pipeline.md).
 *
 *   pnpm showcase                       record + compose the reel from this checkout
 *   pnpm showcase --ref origin/main     film a snapshot (worktree at that ref)
 *   pnpm showcase --shot flight,scrap   re-take specific shots (others reused)
 *   pnpm showcase --catalogue           record every shot, not just the reel
 *   pnpm showcase --compose-only        rebuild the reel from existing clips
 *   pnpm showcase --fps 60              output frame rate (default 30)
 *   pnpm showcase --shot 'hud-*'        a shot id may use * wildcards
 *   pnpm showcase --export <dir>        also copy each new clip to <dir>/<id>.mp4
 *   pnpm showcase --no-assemble         with --shot: skip cutting them together
 *
 * Output (gitignored): showcase-out/{clips/<id>/clip.mp4, contact-sheets/,
 * reel-1080p.mp4, reel-720p.mp4, manifest.json}.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, devices } from '@playwright/test';
import { SHOTS, SECTION_CARDS, TITLE_SUB, END_CARD_POINTS } from './registry.js';
import type { ClipRecord, Shot, ShotViewport, TakeHostLoad } from './types.js';
import { PROFILE_ORDER } from './types.js';
import { CaptureServers, portOffset } from './servers.js';
import { judgeLoad, sampleHostLoad } from './hostLoad.js';
import { PHONE_LANDSCAPE, Recorder, type RecordResult } from './recorder.js';
import { expandShotPatterns } from './shotFilter.js';
import { SMOOTH, smoothnessProblems, smoothScore, type TakeStats } from './smoothness.js';
import { cadenceProblem, stallProblem, worldStalls } from './cadence.js';
import { measureWobble, wobbleProblem, wobbleSummary, netProblem, netSummary, poseHealth, poseProblem, poseSummary } from './wobble.js';
import { encodeClip, encodeCard, assemble, qaClip, deviceLayout, encodedUniqueFps, clipFramePsnr } from './compositor.js';
import { captionOverlay, deviceFrame, endCard, sectionCard, titleCard } from './cards.js';
import { browserPid, clearTracked, gitSha, reapStale, resolveFfmpeg, trackPid } from './tools.js';

interface Args {
  shots: string[] | null;
  catalogue: boolean;
  composeOnly: boolean;
  ref: string | null;
  fps: number;
  headed: boolean;
  out: string;
  /** Also copy each newly encoded clip to `<export>/<id>.mp4`. */
  exportDir: string | null;
  /** With --shot: don't cut the shots together into one review file. */
  assemble: boolean;
  /** Browser render size for desktop takes (see Recorder `capture`). */
  capture: { width: number; height: number };
}

const CAPTURE_SIZES: Record<string, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '900p': { width: 1600, height: 900 },
  '1080p': { width: 1920, height: 1080 },
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    shots: null,
    catalogue: false,
    composeOnly: false,
    ref: null,
    fps: 60,
    headed: false,
    out: 'showcase-out',
    exportDir: null,
    assemble: true,
    capture: CAPTURE_SIZES['720p']!,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${k} needs a value`);
      return next;
    };
    if (k === '--shot') a.shots = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--catalogue') a.catalogue = true;
    else if (k === '--compose-only') a.composeOnly = true;
    else if (k === '--ref') a.ref = v();
    else if (k === '--fps') a.fps = Number(v());
    else if (k === '--headed') a.headed = true;
    else if (k === '--out') a.out = v();
    else if (k === '--export') a.exportDir = v();
    else if (k === '--no-assemble') a.assemble = false;
    else if (k === '--capture') {
      const size = CAPTURE_SIZES[v()];
      if (!size) throw new Error('--capture must be 720p, 900p or 1080p');
      a.capture = size;
    }
    else throw new Error(`unknown arg ${k}`);
  }
  if (a.fps !== 30 && a.fps !== 60) throw new Error('--fps must be 30 or 60');
  return a;
}

const log = (m: string): void => console.log(`[showcase] ${m}`);

/** Detached worktree at `ref` with its own node_modules (incremental). */
function ensureSnapshotWorktree(repo: string, ref: string): string {
  const dir = path.join(repo, '.claude', 'worktrees', 'showcase-snapshot');
  const git = (args: string[], cwd = repo): void => {
    const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  git(['fetch', 'origin', '--quiet']);
  if (!existsSync(dir)) git(['worktree', 'add', '--detach', dir, ref]);
  else git(['checkout', '--detach', '--force', ref], dir);
  log(`snapshot worktree at ${ref} → ${gitSha(dir)}; installing deps…`);
  const r = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error('pnpm install failed in snapshot worktree');
  return dir;
}


function loadManifest(file: string): Record<string, ClipRecord> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, ClipRecord>) : {};
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  resolveFfmpeg(); // fail fast with an install hint
  const repo = process.cwd();
  const appDir = args.ref ? ensureSnapshotWorktree(repo, args.ref) : repo;
  const sha = gitSha(appDir);
  const out = path.resolve(repo, args.out);
  const runDir = path.join(out, 'run');
  mkdirSync(path.join(out, 'clips'), { recursive: true });
  mkdirSync(path.join(out, 'contact-sheets'), { recursive: true });
  mkdirSync(path.join(out, 'cards'), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  // A killed run (e.g. stopped for low memory) runs no cleanup: reap the
  // browsers and servers it left behind before starting new ones.
  const reaped = reapStale();
  if (reaped > 0) log(`reaped ${reaped} process(es) left by a killed run`);
  const manifestFile = path.join(out, 'manifest.json');
  const manifest = loadManifest(manifestFile);
  const failed: string[] = [];

  if (args.shots) args.shots = expandShotPatterns(args.shots, SHOTS.map((s) => s.id));
  const exportDir = args.exportDir ? path.resolve(repo, args.exportDir) : null;
  if (exportDir) mkdirSync(exportDir, { recursive: true });
  const wanted = SHOTS.filter((s) =>
    args.shots ? args.shots.includes(s.id) : args.catalogue || s.reel,
  );
  if (args.shots) {
    const unknown = args.shots.filter((id) => !SHOTS.some((s) => s.id === id));
    if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(', ')}`);
  }

  if (!args.composeOnly && wanted.length > 0) {
    // Fresh world every run: a previous run's razed base / lingering hulls must
    // not leak into this one's footage.
    for (const f of ['eqx.db', 'eqx.db-wal', 'eqx.db-shm']) rmSync(path.join(runDir, f), { force: true });
    const servers = new CaptureServers(appDir, runDir);
    const recorder = new Recorder(
      servers.baseUrl,
      servers.serverUrl,
      log,
      () => servers.restartServer(),
      args.headed,
      args.capture,
    );
    const capBrowser = await chromium.launch();
    trackPid(await browserPid(capBrowser));
    try {
      await recorder.open();
      log(`GPU: ${await recorder.gpuName()}`);
      for (const profile of PROFILE_ORDER) {
        const group = wanted.filter((s) => s.server === profile);
        if (group.length === 0) continue;
        log(`server profile '${profile}' (${group.length} shot(s))…`);
        await servers.ensure(profile);
        await recorder.warmUp(profile === 'lean' ? 4000 : 12_000);
        for (const shot of group) {
          // One shot with no usable take must not lose the rest of the run.
          try {
            manifest[shot.id] = await takeWithRetry(shot, recorder, servers, capBrowser, out, sha, args.fps);
            if (exportDir) {
              const dest = path.join(exportDir, `${shot.id}.mp4`);
              copyFileSync(path.join(out, 'clips', shot.id, 'clip.mp4'), dest);
              log(`  exported ${dest}`);
            }
          } catch (e) {
            failed.push(shot.id);
            log(`✗ ${shot.id}: no usable take (${(e as Error).message.split('\n')[0]}) — skipped`);
            continue;
          }
          writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        }
      }
    } finally {
      await recorder.close();
      await capBrowser.close();
      servers.stop();
      clearTracked();
    }
  }

  if (args.shots && !args.composeOnly) {
    // Re-takes / test clips: cut just these shots together (no cards) so they
    // can be reviewed without touching the full reel. --no-assemble (e.g.
    // `showcase:hud`) wants the separate clips only.
    const parts = SHOTS.filter((s) => args.shots!.includes(s.id) && !failed.includes(s.id)).map((s) => path.join(out, 'clips', s.id, 'clip.mp4'));
    if (args.assemble && parts.length > 0) {
      const { master } = await assemble(parts, out, 'shots');
      log(`wrote ${master}`);
    }
  } else {
    await compose(args, out, manifest, args.catalogue);
  }
  printSummary(manifest, wanted);
  if (failed.length) {
    log(`no usable take for: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

/** Best-of takes per shot (`EQX_SHOWCASE_TAKES` overrides, e.g. 1 for a long shot
 *  on a memory-tight machine). */
const MAX_TAKES = Math.max(1, Math.min(3, Number(process.env['EQX_SHOWCASE_TAKES']) || 3));

/** Move a take into place. Windows briefly locks folders (indexer, AV), so retry. */
async function replaceDir(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(to, { recursive: true, force: true });
      renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

const takeStats = (rec: RecordResult): TakeStats => ({
  frames: rec.index.frames.length,
  deliveredFps: rec.deliveredFps,
  gapMaxMs: rec.gapMaxMs,
  uniqueFps: rec.uniqueFps,
});

/**
 * Best-of-N takes: record until a take passes the smoothness gate (at most
 * `MAX_TAKES`), keep the smoothest, and encode only that one. A take that
 * crashes restarts the server first (a broken room is the usual cause).
 */
/** Delete a take that lost, or keep it for diagnosis (`EQX_KEEP_TAKES=1`) when QA flagged it. */
function dropTake(dir: string, problems: string[]): void {
  if (process.env['EQX_KEEP_TAKES'] === '1' && problems.length > 0) {
    const kept = dir.replace(/\.take(\d+)$/, '.rejected-take$1');
    rmSync(kept, { recursive: true, force: true });
    renameSync(dir, kept);
    log(`  kept rejected take for diagnosis: ${kept}`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

async function takeWithRetry(
  shot: Shot,
  recorder: Recorder,
  servers: CaptureServers,
  capBrowser: Awaited<ReturnType<typeof chromium.launch>>,
  out: string,
  sha: string,
  fps: number,
): Promise<ClipRecord> {
  const clipDir = path.join(out, 'clips', shot.id);
  let best: { rec: RecordResult; dir: string; problems: string[]; hostLoad: TakeHostLoad } | null = null;
  let lastError: Error | null = null;
  for (let take = 1; take <= MAX_TAKES; take++) {
    const dir = `${clipDir}.take${take}`;
    try {
      log(`▶ ${shot.id} (take ${take})`);
      // Host load around the take: recorded in the manifest, never fails it
      // (plan machine-independent-perf WS2). A hitchy take filmed while
      // another session's server ran says so.
      const before = await sampleHostLoad({ portOffsets: [portOffset()] });
      const rec = await recorder.record(shot, dir);
      const after = await sampleHostLoad({ portOffsets: [portOffset()] });
      const hostLoad: TakeHostLoad = { before, after, flags: [...judgeLoad(before, { gateCpu: true }), ...judgeLoad(after, { gateCpu: false })] };
      if (hostLoad.flags.length) log(`  host busy during take: ${hostLoad.flags.join('; ')}`);
      const problems = smoothnessProblems(takeStats(rec), fps);
      // Ship jitter (prediction corrections) — invisible to the frame-rate
      // gate, so every take is measured too (review 2026-11-07).
      const wobble = await measureWobble(dir).catch(() => null);
      const wp = wobble ? wobbleProblem(wobble) : null;
      if (wp) problems.push(wp);
      const np = netProblem(rec.net);
      if (np) problems.push(np);
      // What the game itself drew, frame by frame (corrections move the world).
      const tracePath = path.join(dir, 'pose-trace.json');
      const pose = existsSync(tracePath) ? poseHealth(JSON.parse(readFileSync(tracePath, 'utf8')) as number[][]) : null;
      const pp = poseProblem(pose);
      if (pp) problems.push(pp);
      const verdict = problems.length ? ` — ${problems.join('; ')}` : '';
      log(`  ${problems.length ? '·' : '✓'} ${rec.deliveredFps} fps (${rec.uniqueFps} different, longest repeat ${rec.longestRepeat}), worst gap ${rec.gapMaxMs} ms, ${wobble ? wobbleSummary(wobble) : 'ship wobble: not measured'}, ${netSummary(rec.net)}, ${poseSummary(pose)}${verdict}`);
      // What ran in the take's longest frames, so a hitch says where it came from.
      for (const f of rec.longFrames.slice(0, 3)) log(`    long frame ${f.ms} ms at ${(f.atMs / 1000).toFixed(1)} s: ${f.scripts}`);
      // Fewer QA problems first (a jittery take never beats a clean one), then the smoother.
      if (!best || problems.length < best.problems.length || (problems.length === best.problems.length && smoothScore(takeStats(rec)) > smoothScore(takeStats(best.rec)))) {
        if (best) dropTake(best.dir, best.problems);
        best = { rec, dir, problems, hostLoad };
      } else {
        dropTake(dir, problems);
      }
      if (problems.length === 0) break;
    } catch (e) {
      lastError = e as Error;
      log(`  ✗ ${shot.id}: ${lastError.message.split('\n')[0]}`);
      rmSync(dir, { recursive: true, force: true });
      await servers.restartServer().catch(() => {});
      // The first take after a fresh server boot is the unstable one; warm up.
      await recorder.warmUp(4000).catch(() => {});
    }
  }
  if (!best) throw lastError ?? new Error(`no usable take for ${shot.id}`);

  await replaceDir(best.dir, clipDir);
  const viewport = shot.viewport ?? 'desktop';
  const layout = shot.captionLayout ?? defaultCaptionLayout(viewport);
  let caption: string | null = null;
  if (layout !== 'none') {
    caption = path.join(clipDir, 'caption.png');
    await captionOverlay(capBrowser, caption, shot.title, shot.caption, layout);
  }
  const dl = deviceLayout(viewport, viewportAspect(shot));
  let device: { layout: NonNullable<typeof dl>; framePng: string } | null = null;
  if (dl) {
    const framePng = path.join(clipDir, 'device-frame.png');
    await deviceFrame(capBrowser, framePng, dl);
    device = { layout: dl, framePng };
  }
  const mp4 = await encodeClip(clipDir, best.rec.index, best.rec.takeMs, caption, {
    fps,
    cuts: shot.cuts,
    device,
    ...(shot.maxBitrateKbps ? { maxBitrateKbps: shot.maxBitrateKbps } : {}),
  });
  const qa = await qaClip(mp4, path.join(out, 'contact-sheets', `${shot.id}.png`));
  const problems = [...best.problems];
  if (qa.blankSeconds >= 1) problems.push(`${qa.blankSeconds}s of blank frames`);
  // What reached the encode, not what the capture delivered (bug 2026-11-10:
  // QA said 60 fps while the clip showed ~25 different frames a second).
  const encUnique = await encodedUniqueFps(clipDir, fps, qa.durationMs).catch(() => NaN);
  const ep = Number.isFinite(encUnique) ? cadenceProblem('encoded', encUnique, SMOOTH[fps]!.minFps) : 'encoded cadence not measured (ffprobe failed)';
  if (ep) problems.push(ep);
  log(`  encoded: ${encUnique} different frames/s (captured ${best.rec.uniqueFps})`);
  // Where the WORLD froze mid-motion (2026-11-12): byte-level cadence misses
  // it when HUD text changes on a frozen frame (the long-guns zoom chug).
  const psnr = await clipFramePsnr(mp4).catch(() => null);
  const stalls = psnr ? worldStalls(psnr) : null;
  const sp = stalls ? stallProblem(stalls, fps) : 'world stalls not measured (ffmpeg psnr failed)';
  if (sp) problems.push(sp);
  if (stalls) log(`  world: ${stalls.stalls} stalls mid-motion, longest ${stalls.longest} frames (${stalls.motionPairs} moving frame pairs)`);
  return {
    id: shot.id,
    sha,
    recordedAt: new Date().toISOString(),
    frames: best.rec.index.frames.length,
    durationMs: qa.durationMs,
    deliveredFps: best.rec.deliveredFps,
    uniqueFps: best.rec.uniqueFps,
    longestRepeat: best.rec.longestRepeat,
    encodedUniqueFps: encUnique,
    ...(stalls ? { worldStalls: stalls } : {}),
    gapP95Ms: best.rec.gapP95Ms,
    gapMaxMs: best.rec.gapMaxMs,
    qa: { ok: problems.length === 0, problems },
    hostLoad: best.hostLoad,
  };
}

function defaultCaptionLayout(viewport: ShotViewport): 'lower-third' | 'side' | 'top' {
  return viewport === 'phone' ? 'side' : viewport === 'phone-landscape' ? 'top' : 'lower-third';
}

/** CSS aspect of a phone take (what its frames' aspect is too). */
function viewportAspect(shot: Shot): number {
  if (shot.viewport === 'phone-landscape') return PHONE_LANDSCAPE.width / PHONE_LANDSCAPE.height;
  const vp = devices['Pixel 5'].viewport;
  return vp.width / vp.height;
}

async function compose(args: Args, out: string, manifest: Record<string, ClipRecord>, catalogue: boolean): Promise<void> {
  const reelShots = SHOTS.filter((s) => (catalogue ? true : s.reel)).filter((s) => manifest[s.id]);
  if (reelShots.length === 0) {
    log('nothing to compose yet');
    return;
  }
  const shas = new Set(reelShots.map((s) => manifest[s.id]!.sha));
  if (shas.size > 1) {
    throw new Error(`clips come from different snapshots (${[...shas].join(', ')}) — re-take or use one --ref`);
  }
  const sha = [...shas][0]!;
  const browser = await chromium.launch();
  const cards = path.join(out, 'cards');
  const parts: string[] = [];
  try {
    const opt = { fps: args.fps };
    await titleCard(browser, path.join(cards, 'title.png'), TITLE_SUB);
    parts.push(await encodeCard(path.join(cards, 'title.png'), path.join(cards, 'title.mp4'), 3.5, opt));
    let section: Shot['section'] | null = null;
    for (const s of reelShots) {
      if (s.section !== section) {
        section = s.section;
        const card = SECTION_CARDS[section];
        if (card) {
          const png = path.join(cards, `section-${section}.png`);
          await sectionCard(browser, png, card.title, card.sub);
          parts.push(await encodeCard(png, path.join(cards, `section-${section}.mp4`), 2.8, opt));
        }
      }
      parts.push(path.join(out, 'clips', s.id, 'clip.mp4'));
    }
    const date = new Date().toISOString().slice(0, 10);
    await endCard(browser, path.join(cards, 'end.png'), [...END_CARD_POINTS], sha, date);
    parts.push(await encodeCard(path.join(cards, 'end.png'), path.join(cards, 'end.mp4'), 6, opt));
  } finally {
    await browser.close();
  }
  const name = catalogue ? 'catalogue' : 'reel';
  const { master, preview } = await assemble(parts, out, name);
  log(`wrote ${master}`);
  log(`wrote ${preview}`);
}

function printSummary(manifest: Record<string, ClipRecord>, wanted: readonly Shot[]): void {
  const flagged = wanted.map((s) => manifest[s.id]).filter((r): r is ClipRecord => !!r && !r.qa.ok);
  if (flagged.length === 0) {
    log('all clips passed QA');
    return;
  }
  log(`${flagged.length} clip(s) flagged for a re-take (pnpm showcase --shot <id>):`);
  for (const r of flagged) log(`  - ${r.id}: ${r.qa.problems.join('; ')}`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
