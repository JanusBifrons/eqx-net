/**
 * Engine exhaust lab capture (rnd/engine-fx).
 *
 *   pnpm tsx scripts/art-lab/capture-engines.ts [--only stills|clips|bench] [--out diag/art-lab/engines-r1]
 *
 * Boots an isolated Vite (5374), opens /__art-lab__/engines.html in headless
 * Chromium on the real GPU and records each look (today / flame / ribbon /
 * both): frame-exact stills at the key moments, 30 fps clips with a 2×2
 * comparison, and a 24-ship bench (plain and 4× CPU throttle).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? 'diag/art-lab/engines-r1';
const ONLY = flag('--only');
const PORT = 5374;
const FPS = 30;
const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';
const ARMS = ['today', 'flame', 'ribbon', 'both'] as const;

/** Stills: [id, scene, t]. The flight: coast 0-2 s, thrust 2-5, boost 5-9, boosted turn 9-11, cut 11+. */
const STILLS: Array<[string, string, number]> = [
  ['coast', 'flight', 1.5], ['thrust', 'flight', 4.2], ['boost', 'flight', 8.0], ['turn', 'flight', 10.4], ['cut', 'flight', 11.6],
  ['close-thrust', 'close', 4.2], ['close-boost', 'close', 8.0],
];
const CLIPS: Array<[string, string, number]> = [['flight', 'flight', 14], ['close', 'close', 12]];

async function waitHttp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`vite did not come up at ${url}`);
}

function bootVite(): ChildProcess {
  const p = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
    shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EQX_SERVER_PORT: '2767' },
  });
  p.stderr?.on('data', (d: Buffer) => { const s = d.toString(); if (/error/i.test(s)) process.stderr.write(`[vite] ${s}`); });
  return p;
}

async function open(page: Page, q: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/__art-lab__/engines.html?${q}`);
  await page.waitForFunction(() => {
    const w = window as unknown as { __artlab?: { ready: boolean }; __artlabError?: string };
    return w.__artlab?.ready === true || !!w.__artlabError;
  }, undefined, { timeout: 240_000 });
  const err = await page.evaluate(() => (window as unknown as { __artlabError?: string }).__artlabError);
  if (err) throw new Error(`lab failed (${q}): ${err}`);
  if (errors.length) console.warn(`console errors on ${q}:\n  ${errors.join('\n  ')}`);
}

const seek = (page: Page, ms: number): Promise<void> =>
  page.evaluate((m) => (window as unknown as { __artlab: { seek(ms: number): void } }).__artlab.seek(m), ms);
const stats = (page: Page): Promise<unknown> =>
  page.evaluate(() => (window as unknown as { __artlab: { stats(): unknown } }).__artlab.stats());

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const vite = bootVite();
  const report: Record<string, unknown> = { when: new Date().toISOString(), stills: [], clips: [], bench: {} };
  const W = 1280, H = 720;
  try {
    await waitHttp(`http://localhost:${PORT}/__art-lab__/engines.html`, 90_000);
    const browser = await chromium.launch({
      args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });

    if (!ONLY || ONLY === 'stills') {
      mkdirSync(`${OUT}/stills`, { recursive: true });
      for (const arm of ARMS) {
        for (const scene of ['flight', 'close']) {
          const page = await browser.newPage({ viewport: { width: W, height: H } });
          await open(page, `arm=${arm}&scene=${scene}&w=${W}&h=${H}`);
          for (const [id, sc, t] of STILLS) {
            if (sc !== scene) continue;
            await seek(page, t * 1000);
            const file = `${OUT}/stills/${id}-${arm}.png`;
            await page.screenshot({ path: file });
            (report['stills'] as unknown[]).push({ id, arm, file, stats: await stats(page) });
          }
          await page.close();
          console.log(`stills ${scene} ${arm}`);
        }
      }
    }

    if (!ONLY || ONLY === 'clips') {
      mkdirSync(`${OUT}/clips`, { recursive: true });
      for (const [id, scene, seconds] of CLIPS) {
        const parts: string[] = [];
        for (const arm of ARMS) {
          const dir = `${OUT}/frames/${id}-${arm}`;
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          const page = await browser.newPage({ viewport: { width: W, height: H } });
          await open(page, `arm=${arm}&scene=${scene}&w=${W}&h=${H}`);
          const n = Math.round(seconds * FPS);
          for (let f = 0; f < n; f++) {
            await seek(page, (f / FPS) * 1000);
            await page.screenshot({ path: `${dir}/${String(f).padStart(4, '0')}.png` });
          }
          await page.close();
          const mp4 = `${OUT}/clips/${id}-${arm}.mp4`;
          execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/%04d.png`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
          parts.push(mp4);
          (report['clips'] as unknown[]).push({ id, arm, file: mp4 });
          console.log(`clip ${id} ${arm}`);
        }
        // 2×2 grid: today | flame / ribbon | both, labelled.
        const tw = 960, th = 540;
        const lab = (i: number): string => `[${i}:v]scale=${tw}:${th}:flags=lanczos,drawtext=text='${ARMS[i]}':x=14:y=12:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=6[v${i}]`;
        const filt = `${[0, 1, 2, 3].map(lab).join(';')};[v0][v1]hstack[t];[v2][v3]hstack[b];[t][b]vstack[o]`;
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', filt, '-map', '[o]',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'slow', '-movflags', '+faststart', `${OUT}/clips/${id}-compare.mp4`]);
        rmSync(`${OUT}/frames`, { recursive: true, force: true });
      }
    }

    if (!ONLY || ONLY === 'bench') {
      const bench: Record<string, unknown> = {};
      for (const throttle of [1, 4]) {
        for (const arm of ARMS) {
          const page = await browser.newPage({ viewport: { width: W, height: H } });
          await open(page, `arm=${arm}&scene=swarm&w=${W}&h=${H}`);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          const r = await page.evaluate(() => (window as unknown as { __artlab: { bench(ms: number): Promise<unknown> } }).__artlab.bench(6000));
          bench[`${arm}@cpu${throttle}x`] = { ...(r as object), stats: await stats(page) };
          console.log(`bench ${arm} cpu${throttle}x`, JSON.stringify(r));
          await page.close();
        }
      }
      report['bench'] = bench;
    }
    await browser.close();
  } finally {
    vite.kill();
    if (process.platform === 'win32' && vite.pid) {
      try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
  }
  const rp = path.join(OUT, `report${ONLY ? `-${ONLY}` : ''}.json`);
  writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`done -> ${rp}`);
  process.exit(0);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
