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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { SHOTS, SECTION_CARDS, TITLE_SUB, END_CARD_POINTS } from './registry.js';
import type { ClipRecord, ServerProfile, Shot } from './types.js';
import { CaptureServers } from './servers.js';
import { Recorder } from './recorder.js';
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
}

function parseArgs(argv: string[]): Args {
  const a: Args = { shots: null, catalogue: false, composeOnly: false, ref: null, fps: 30, headed: false, out: 'showcase-out' };
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
    const servers = new CaptureServers(appDir, runDir);
    const recorder = new Recorder(servers.baseUrl, servers.serverUrl, log, () => servers.restartServer(), args.headed);
    const capBrowser = await chromium.launch();
    try {
      await recorder.open();
      log(`GPU: ${await recorder.gpuName()}`);
      for (const profile of PROFILE_ORDER) {
        const group = wanted.filter((s) => s.server === profile);
        if (group.length === 0) continue;
        log(`server profile '${profile}' (${group.length} shot(s))…`);
        await servers.ensure(profile);
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

  await compose(args, out, manifest, args.catalogue);
  printSummary(manifest, wanted);
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
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log(`▶ ${shot.id} (take ${attempt})`);
      const clipDir = path.join(out, 'clips', shot.id);
      const rec = await recorder.record(shot, clipDir);
      const caption = path.join(clipDir, 'caption.png');
      await captionOverlay(capBrowser, caption, shot.title, shot.caption, shot.viewport === 'phone' ? 'side' : 'lower-third');
      const mp4 = await encodeClip(clipDir, rec.index, shot.durationMs, caption, { fps, cuts: shot.cuts });
      const qa = await qaClip(mp4, path.join(out, 'contact-sheets', `${shot.id}.png`));
      const problems: string[] = [];
      if (rec.index.frames.length < 30) problems.push(`only ${rec.index.frames.length} frames captured`);
      if (rec.deliveredFps < 20) problems.push(`delivered ${rec.deliveredFps} fps (< 20) — host under load?`);
      if (rec.gapMaxMs > 1500) problems.push(`a ${rec.gapMaxMs} ms freeze`);
      if (qa.blankSeconds >= 1) problems.push(`${qa.blankSeconds}s of blank frames`);
      const record: ClipRecord = {
        id: shot.id,
        sha,
        recordedAt: new Date().toISOString(),
        frames: rec.index.frames.length,
        durationMs: qa.durationMs,
        deliveredFps: rec.deliveredFps,
        gapP95Ms: rec.gapP95Ms,
        gapMaxMs: rec.gapMaxMs,
        qa: { ok: problems.length === 0, problems },
      };
      log(`  ${record.qa.ok ? '✓' : '⚠'} ${rec.deliveredFps} fps, p95 gap ${rec.gapP95Ms} ms${problems.length ? ' — ' + problems.join('; ') : ''}`);
      return record;
    } catch (e) {
      log(`  ✗ ${shot.id}: ${(e as Error).message.split('\n')[0]}`);
      if (attempt === 2) throw e;
      // A broken room/server state is the usual cause — restart before the retry.
      await servers.restartServer().catch(() => {});
    }
  }
  throw new Error('unreachable');
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
