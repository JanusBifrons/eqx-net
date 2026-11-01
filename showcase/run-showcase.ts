/**
 * Showcase video pipeline — CLI (docs/architecture/showcase-pipeline.md).
 *
 *   pnpm showcase                       record + compose the reel from this checkout
 *   pnpm showcase --ref origin/main     film a snapshot (worktree at that ref)
 *   pnpm showcase --shot flight,scrap   re-take specific shots (others reused)
 *   pnpm showcase --catalogue           record every shot, not just the reel
 *   pnpm showcase --compose-only        rebuild the reel from existing clips
 *   pnpm showcase --fps 60              output frame rate (default 30)
 *
 * Output (gitignored): showcase-out/{clips/<id>/clip.mp4, contact-sheets/,
 * reel-1080p.mp4, reel-720p.mp4, manifest.json}.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { SHOTS, SECTION_CARDS, TITLE_SUB, END_CARD_POINTS } from './registry.js';
import type { ClipRecord, ServerProfile, Shot } from './types.js';
import { CaptureServers } from './servers.js';
import { Recorder, type RecordResult } from './recorder.js';
import { smoothnessProblems, smoothScore, type TakeStats } from './smoothness.js';
import { encodeClip, encodeCard, assemble, qaClip } from './compositor.js';
import { captionOverlay, endCard, sectionCard, titleCard } from './cards.js';
import { gitSha, resolveFfmpeg } from './tools.js';

interface Args {
  shots: string[] | null;
  catalogue: boolean;
  composeOnly: boolean;
  ref: string | null;
  fps: number;
  headed: boolean;
  out: string;
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

const PROFILE_ORDER: ServerProfile[] = ['lean', 'living', 'wave'];

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
  const manifestFile = path.join(out, 'manifest.json');
  const manifest = loadManifest(manifestFile);

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
          manifest[shot.id] = await takeWithRetry(shot, recorder, servers, capBrowser, out, sha, args.fps);
          writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
        }
      }
    } finally {
      await recorder.close();
      await capBrowser.close();
      servers.stop();
    }
  }

  if (args.shots && !args.composeOnly) {
    // Re-takes / test clips: cut just these shots together (no cards) so they
    // can be reviewed without touching the full reel.
    const parts = SHOTS.filter((s) => args.shots!.includes(s.id)).map((s) => path.join(out, 'clips', s.id, 'clip.mp4'));
    const { master } = await assemble(parts, out, 'shots');
    log(`wrote ${master}`);
  } else {
    await compose(args, out, manifest, args.catalogue);
  }
  printSummary(manifest, wanted);
}

const MAX_TAKES = 3;

const takeStats = (rec: RecordResult): TakeStats => ({
  frames: rec.index.frames.length,
  deliveredFps: rec.deliveredFps,
  gapMaxMs: rec.gapMaxMs,
});

/**
 * Best-of-N takes: record until a take passes the smoothness gate (at most
 * `MAX_TAKES`), keep the smoothest, and encode only that one. A take that
 * crashes restarts the server first (a broken room is the usual cause).
 */
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
  let best: { rec: RecordResult; dir: string; problems: string[] } | null = null;
  let lastError: Error | null = null;
  for (let take = 1; take <= MAX_TAKES; take++) {
    const dir = `${clipDir}.take${take}`;
    try {
      log(`▶ ${shot.id} (take ${take})`);
      const rec = await recorder.record(shot, dir);
      const problems = smoothnessProblems(takeStats(rec), fps);
      const verdict = problems.length ? ` — ${problems.join('; ')}` : '';
      log(`  ${problems.length ? '·' : '✓'} ${rec.deliveredFps} fps, worst gap ${rec.gapMaxMs} ms${verdict}`);
      if (!best || smoothScore(takeStats(rec)) > smoothScore(takeStats(best.rec))) {
        if (best) rmSync(best.dir, { recursive: true, force: true });
        best = { rec, dir, problems };
      } else {
        rmSync(dir, { recursive: true, force: true });
      }
      if (problems.length === 0) break;
    } catch (e) {
      lastError = e as Error;
      log(`  ✗ ${shot.id}: ${lastError.message.split('\n')[0]}`);
      rmSync(dir, { recursive: true, force: true });
      await servers.restartServer().catch(() => {});
    }
  }
  if (!best) throw lastError ?? new Error(`no usable take for ${shot.id}`);

  rmSync(clipDir, { recursive: true, force: true });
  renameSync(best.dir, clipDir);
  const caption = path.join(clipDir, 'caption.png');
  await captionOverlay(capBrowser, caption, shot.title, shot.caption, shot.viewport === 'phone' ? 'side' : 'lower-third');
  const mp4 = await encodeClip(clipDir, best.rec.index, shot.durationMs, caption, { fps, cuts: shot.cuts });
  const qa = await qaClip(mp4, path.join(out, 'contact-sheets', `${shot.id}.png`));
  const problems = [...best.problems];
  if (qa.blankSeconds >= 1) problems.push(`${qa.blankSeconds}s of blank frames`);
  return {
    id: shot.id,
    sha,
    recordedAt: new Date().toISOString(),
    frames: best.rec.index.frames.length,
    durationMs: qa.durationMs,
    deliveredFps: best.rec.deliveredFps,
    gapP95Ms: best.rec.gapP95Ms,
    gapMaxMs: best.rec.gapMaxMs,
    qa: { ok: problems.length === 0, problems },
  };
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
