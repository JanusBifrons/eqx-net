/**
 * Art lab capture (plan soft-leaping-truffle v5, round 1).
 *
 *   pnpm tsx scripts/art-lab/capture.ts [--only stills|clips|bench] [--out diag/art-lab/round1]
 *
 * Boots an isolated Vite (port 5374, never the dev 5173), opens the lab page in
 * headless Chromium on the real GPU, and for each style records:
 *  - stills: frame-exact `__artlab.seek` + screenshot;
 *  - clips: 30 fps stepped frames → mp4, then a side-by-side triptych per clip
 *    (current | machined | pixel) so the arms compare on identical frames;
 *  - bench: the 40-ship / 150-structure scene on a real RAF loop, plain and
 *    with 4× CPU throttling.
 * Every still/clip asserts the frame is not blank.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? 'diag/art-lab/round1';
const ONLY = flag('--only');
const CLIP = flag('--clip');
const PORT = 5374;
const ALL_STYLES = ['current', 'machined', 'pixel'] as const;
const STYLES = (flag('--styles')?.split(',') ?? [...ALL_STYLES]) as Array<(typeof ALL_STYLES)[number]>;

const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';

interface Still { id: string; scene: string; t: number; zoom?: number; w: number; h: number; extra?: string }
const STILL_ONLY = flag('--still');
const STILLS: Still[] = [
  { id: 'ships-close', scene: 'ships', t: 1.2, w: 1280, h: 420 },
  { id: 'ships-gameplay', scene: 'ships', t: 1.2, zoom: 0.9, w: 640, h: 200 },
  { id: 'factions', scene: 'factions', t: 1, w: 1280, h: 320 },
  { id: 'structures', scene: 'structures', t: 0.5, w: 1280, h: 720 },
  { id: 'base-gameplay', scene: 'base', t: 5.5, w: 1280, h: 720 },
  { id: 'explosion', scene: 'explosion', t: 1.18, w: 1280, h: 720 },
  { id: 'fleet', scene: 'fleet', t: 1.5, w: 1600, h: 900 },
  { id: 'capitals', scene: 'capitals', t: 1.5, w: 1600, h: 900 },
  { id: 'industry', scene: 'industry', t: 0.5, w: 1600, h: 900 },
  { id: 'mega', scene: 'mega', t: 0.5, w: 1600, h: 900 },
  { id: 'combat', scene: 'combat', t: 1.47, w: 1280, h: 720 },
];

interface Clip { id: string; scene: string; seconds: number; w: number; h: number }
const CLIPS: Clip[] = [
  { id: 'turning', scene: 'ships', seconds: 6, w: 1280, h: 420 },
  { id: 'fleet-pass', scene: 'base', seconds: 8, w: 1280, h: 720 },
  { id: 'explosion', scene: 'explosion', seconds: 4.5, w: 1280, h: 720 },
  { id: 'zoom-sweep', scene: 'sweep', seconds: 7, w: 1280, h: 720 },
  { id: 'combat', scene: 'combat', seconds: 6, w: 1280, h: 720 },
];
const FPS = 30;

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
  await page.goto(`http://localhost:${PORT}/__art-lab__/index.html?${q}`);
  await page.waitForFunction(() => {
    const w = window as unknown as { __artlab?: { ready: boolean }; __artlabError?: string };
    return w.__artlab?.ready === true || !!w.__artlabError;
  }, undefined, { timeout: 180_000 });
  const err = await page.evaluate(() => (window as unknown as { __artlabError?: string }).__artlabError);
  if (err) throw new Error(`lab failed (${q}): ${err}`);
  if (errors.length) console.warn(`console errors on ${q}:\n  ${errors.join('\n  ')}`);
}

async function assertNotBlank(page: Page, what: string): Promise<void> {
  const lit = await page.evaluate(() => {
    const c = document.querySelector('canvas')!;
    const tmp = document.createElement('canvas');
    tmp.width = 96; tmp.height = 54;
    const x = tmp.getContext('2d')!;
    x.drawImage(c, 0, 0, 96, 54);
    const d = x.getImageData(0, 0, 96, 54).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 90) n++;
    return n;
  });
  if (lit < 3) throw new Error(`blank frame: ${what}`);
}

const seek = (page: Page, ms: number): Promise<void> =>
  page.evaluate((m) => (window as unknown as { __artlab: { seek(ms: number): void } }).__artlab.seek(m), ms);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const vite = bootVite();
  const report: Record<string, unknown> = { when: new Date().toISOString(), stills: [], clips: [], bench: {} };
  try {
    await waitHttp(`http://localhost:${PORT}/__art-lab__/index.html`, 90_000);
    const browser = await chromium.launch({
      args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    });

    if (!ONLY || ONLY === 'stills') {
      mkdirSync(`${OUT}/stills`, { recursive: true });
      for (const s of STILLS.filter((x) => !STILL_ONLY || STILL_ONLY.split(',').includes(x.id))) {
        for (const style of STYLES) {
          const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
          await open(page, `style=${style}&scene=${s.scene}&w=${s.w}&h=${s.h}${s.zoom ? `&zoom=${s.zoom}` : ''}${s.extra ?? ''}`);
          await seek(page, s.t * 1000);
          await assertNotBlank(page, `${s.id}/${style}`);
          const file = `${OUT}/stills/${s.id}-${style}.png`;
          await page.screenshot({ path: file });
          const stats = await page.evaluate(() => (window as unknown as { __artlab: { stats(): unknown } }).__artlab.stats());
          (report['stills'] as unknown[]).push({ id: s.id, style, file, stats });
          await page.close();
          console.log(`still ${s.id} ${style}`);
        }
      }
    }

    if (!ONLY || ONLY === 'clips') {
      mkdirSync(`${OUT}/clips`, { recursive: true });
      for (const c of CLIPS.filter((x) => !CLIP || x.id === CLIP)) {
        const parts: string[] = [];
        for (const style of STYLES) {
          const dir = `${OUT}/frames/${c.id}-${style}`;
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          const page = await browser.newPage({ viewport: { width: c.w, height: c.h } });
          await open(page, `style=${style}&scene=${c.scene}&w=${c.w}&h=${c.h}`);
          const n = Math.round(c.seconds * FPS);
          for (let f = 0; f < n; f++) {
            await seek(page, (f / FPS) * 1000);
            if (f === Math.floor(n / 2)) await assertNotBlank(page, `${c.id}/${style}@${f}`);
            await page.screenshot({ path: `${dir}/${String(f).padStart(4, '0')}.png` });
          }
          await page.close();
          const mp4 = `${OUT}/clips/${c.id}-${style}.mp4`;
          execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/%04d.png`,
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', style === 'pixel' ? '18' : '22', '-preset', 'slow', '-movflags', '+faststart', mp4]);
          parts.push(mp4);
          (report['clips'] as unknown[]).push({ id: c.id, style, file: mp4 });
          console.log(`clip ${c.id} ${style}`);
        }
        // Triptych: the three arms side by side on identical frames.
        if (parts.length === 3) {
        const tw = 640, th = Math.round((c.h / c.w) * tw / 2) * 2;
        const filt = parts.map((_, i) => `[${i}:v]scale=${tw}:${th}:flags=${i === 2 ? 'neighbor' : 'lanczos'}[v${i}]`).join(';')
          + `;[v0][v1][v2]hstack=inputs=3[o]`;
        execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...parts.flatMap((p) => ['-i', p]), '-filter_complex', filt, '-map', '[o]',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-preset', 'slow', '-movflags', '+faststart', `${OUT}/clips/${c.id}-triptych.mp4`]);
        }
        // A small GIF of the machined + pixel arms for quick sharing.
        for (let i = 0; i < parts.length; i++) {
          const style = STYLES[i]!;
          if (style === 'current') continue;
          execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', parts[i]!, '-vf',
            `fps=15,scale=480:-2:flags=${style === 'pixel' ? 'neighbor' : 'lanczos'},split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
            `${OUT}/clips/${c.id}-${style}.gif`]);
        }
      }
      rmSync(`${OUT}/frames`, { recursive: true, force: true });
    }

    if (!ONLY || ONLY === 'bench') {
      const bench: Record<string, unknown> = {};
      for (const throttle of [1, 4]) {
        for (const style of STYLES) {
          const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
          await open(page, `style=${style}&scene=bench&w=1280&h=720&n=40`);
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          const r = await page.evaluate(() => (window as unknown as { __artlab: { bench(ms: number): Promise<unknown> } }).__artlab.bench(6000));
          const stats = await page.evaluate(() => (window as unknown as { __artlab: { stats(): unknown } }).__artlab.stats());
          bench[`${style}@cpu${throttle}x`] = { ...(r as object), stats };
          console.log(`bench ${style} cpu${throttle}x`, JSON.stringify(r));
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
  const rp = path.join(OUT, `report${ONLY ? `-${ONLY}` : ''}${CLIP ? `-${CLIP}` : ''}.json`);
  writeFileSync(rp, JSON.stringify(report, null, 2));
  console.log(`done -> ${rp}${existsSync(rp) ? '' : ' (missing!)'}`);
  process.exit(0);
}

void main().catch((e: unknown) => { console.error(e); process.exit(1); });
