/**
 * FX lab capture (plan iridescent-seeking-rainbow v2).
 *
 *   pnpm tsx scripts/art-lab/capture-fx.ts [--only stills|clips|bench] [--clip id] [--still id] [--out diag/art-lab/fx-r1]
 *
 * Boots an isolated Vite (port 5374), opens /__art-lab__/fx.html in headless
 * Chromium on the real GPU and records, per arm (today's effects vs the new
 * candidates):
 *  - stills: frame-exact `__artlab.seek` + screenshot;
 *  - clips: 30 fps stepped frames → mp4, then the arms side by side;
 *  - bench: the battle scene on a real RAF loop (plain and 4× CPU throttle),
 *    with draw calls per frame.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? 'diag/art-lab/fx-r1';
const ONLY = flag('--only');
const CLIP = flag('--clip');
const STILL = flag('--still');
const PORT = 5374;
const FPS = 30;
const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';

interface Arm { id: string; q: string }
const TODAY: Arm = { id: 'today', q: 'fx=today' };
const NEW: Arm = { id: 'new', q: 'fx=new' };
const PAIR = [TODAY, NEW];

interface Shot { id: string; scene: string; t: number; w: number; h: number; arms: Arm[]; seconds: number; extra?: string }
const SHOTS: Shot[] = [
  { id: 'weapons', scene: 'weapons', t: 2.35, w: 1280, h: 720, arms: PAIR, seconds: 6 },
  { id: 'shield', scene: 'shield', t: 1.75, w: 960, h: 640, seconds: 6,
    arms: [TODAY, { id: 'sprite', q: 'fx=new&shield=sprite' }, { id: 'shader', q: 'fx=new&shield=shader' }] },
  { id: 'explosions', scene: 'explosions', t: 2.75, w: 1280, h: 720, arms: PAIR, seconds: 5.6 },
  { id: 'zoom', scene: 'zoom', t: 3.2, w: 1280, h: 720, arms: PAIR, seconds: 10 },
  { id: 'nebula', scene: 'nebula', t: 2, w: 960, h: 600, seconds: 6,
    arms: [{ id: 'emission', q: 'fx=new&neb=emission' }, { id: 'reflection', q: 'fx=new&neb=reflection' }, { id: 'dark', q: 'fx=new&neb=dark' }] },
  { id: 'environment', scene: 'environment', t: 3, w: 1280, h: 720, arms: PAIR, seconds: 8 },
  { id: 'battle', scene: 'battle', t: 2.4, w: 1280, h: 720, arms: [TODAY, NEW, { id: 'shader', q: 'fx=new&shield=shader' }], seconds: 10 },
];

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
  await page.goto(`http://localhost:${PORT}/__art-lab__/fx.html?${q}`);
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
  try {
    await waitHttp(`http://localhost:${PORT}/__art-lab__/fx.html`, 90_000);
    const browser = await chromium.launch({
      args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });
    const base = (s: Shot, a: Arm): string => `${a.q}&scene=${s.scene}&w=${s.w}&h=${s.h}${s.extra ?? ''}`;

    if (!ONLY || ONLY === 'stills') {
      mkdirSync(`${OUT}/stills`, { recursive: true });
      for (const s of SHOTS.filter((x) => !STILL || STILL.split(',').includes(x.id))) {
        for (const a of s.arms) {
          const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
          await open(page, base(s, a));
          await seek(page, s.t * 1000);
          const file = `${OUT}/stills/${s.id}-${a.id}.png`;
          await page.screenshot({ path: file });
          (report['stills'] as unknown[]).push({ id: s.id, arm: a.id, file, stats: await stats(page) });
          await page.close();
          console.log(`still ${s.id} ${a.id}`);
        }
      }
    }

    if (!ONLY || ONLY === 'clips') {
      mkdirSync(`${OUT}/clips`, { recursive: true });
      for (const s of SHOTS.filter((x) => !CLIP || CLIP.split(',').includes(x.id))) {
        const parts: string[] = [];
        for (const a of s.arms) {
          const dir = `${OUT}/frames/${s.id}-${a.id}`;
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
          await open(page, base(s, a));
          const n = Math.round(s.seconds * FPS);
          for (let f = 0; f < n; f++) {
            await seek(page, (f / FPS) * 1000);
            await page.screenshot({ path: `${dir}/${String(f).padStart(4, '0')}.png` });
          }
          await page.close();
          const mp4 = `${OUT}/clips/${s.id}-${a.id}.mp4`;
          execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/%04d.png`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', mp4]);
          parts.push(mp4);
          (report['clips'] as unknown[]).push({ id: s.id, arm: a.id, file: mp4 });
          console.log(`clip ${s.id} ${a.id}`);
        }
        // The arms side by side on identical frames (stacked when there are 2 wide ones).
        const k = parts.length;
        const tw = k === 2 ? 960 : 640, th = Math.round((s.h / s.w) * tw / 2) * 2;
        const filt = parts.map((_, i) => `[${i}:v]scale=${tw}:${th}:flags=lanczos[v${i}]`).join(';')
          + `;${parts.map((_, i) => `[v${i}]`).join('')}${k === 2 ? 'vstack' : 'hstack'}=inputs=${k}[o]`;
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', filt, '-map', '[o]',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '21', '-preset', 'slow', '-movflags', '+faststart', `${OUT}/clips/${s.id}-compare.mp4`]);
        rmSync(`${OUT}/frames`, { recursive: true, force: true });
      }
    }

    if (!ONLY || ONLY === 'bench') {
      const bench: Record<string, unknown> = {};
      for (const n of [12, 24]) {
        for (const throttle of [1, 4]) {
          for (const a of [TODAY, NEW, { id: 'shader', q: 'fx=new&shield=shader' }]) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
            await open(page, `${a.q}&scene=battle&w=1280&h=720&n=${n}`);
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
            const r = await page.evaluate(() => (window as unknown as { __artlab: { bench(ms: number): Promise<unknown> } }).__artlab.bench(6000));
            bench[`${a.id}@n${n}@cpu${throttle}x`] = { ...(r as object), stats: await stats(page) };
            console.log(`bench ${a.id} n${n} cpu${throttle}x`, JSON.stringify(r));
            await page.close();
          }
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
  const rp = path.join(OUT, `report${ONLY ? `-${ONLY}` : ''}${CLIP ? `-${CLIP}` : ''}${STILL ? `-${STILL}` : ''}.json`);
  writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`done -> ${rp}`);
  process.exit(0);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
