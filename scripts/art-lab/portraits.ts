/**
 * Join flow stage 3 — bake the Hangar's ship pictures.
 *
 *   pnpm ships:portraits [--only fighter,battleship]
 *
 * Boots an isolated Vite (port 5378, never the dev 5173), opens the art lab's
 * `portrait` scene in headless Chromium for each flyable hull (machined art),
 * screenshots a centred square, and writes `public/ships/<kind>.webp` (320 px,
 * via ffmpeg). A blank frame fails the run.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { PORTRAIT_KINDS, portraitFraming } from '../../src/client/render/art/shipPortraits.js';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = flag('--only')?.split(',');
const PORT = 5378;
const OUT = path.resolve('public/ships');
const SIZE = 320;
/** The sheet is 1600×900; the ship sits in the centred 900 square. */
const CLIP = { x: 350, y: 0, width: 900, height: 900 };
const FFMPEG = process.env['FFMPEG'] ?? 'ffmpeg';

async function waitHttp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`vite did not come up at ${url}`);
}

function bootVite(): ChildProcess {
  const p = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EQX_SERVER_PORT: '2767' },
  });
  p.stdout?.on('data', () => { /* drain */ });
  p.stderr?.on('data', (d: Buffer) => { const s = d.toString(); if (/error/i.test(s)) process.stderr.write(`[vite] ${s}`); });
  return p;
}

async function open(page: Page, q: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${PORT}/__art-lab__/index.html?${q}`);
  await page.waitForFunction(() => {
    const w = window as unknown as { __artlab?: { ready: boolean }; __artlabError?: string };
    return w.__artlab?.ready === true || !!w.__artlabError;
  }, undefined, { timeout: 180_000 });
  const err = await page.evaluate(() => (window as unknown as { __artlabError?: string }).__artlabError);
  if (err) throw new Error(`lab failed (${q}): ${err}`);
}

async function litPixels(page: Page): Promise<number> {
  return page.evaluate((c) => {
    const src = document.querySelector('canvas')!;
    const tmp = document.createElement('canvas');
    tmp.width = 64; tmp.height = 64;
    const x = tmp.getContext('2d')!;
    x.drawImage(src, c.x, c.y, c.width, c.height, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! > 150) n++;
    return n;
  }, CLIP);
}

async function main(): Promise<void> {
  const kinds = PORTRAIT_KINDS.filter((k) => !ONLY || ONLY.includes(k));
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'eqx-portraits-'));
  const vite = bootVite();
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/__art-lab__/index.html`, 120_000);
    console.log(`vite up on ${PORT}`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    let bytes = 0;
    for (const kind of kinds) {
      const { zm, th } = portraitFraming(kind);
      await open(page, `style=machined&scene=portrait&kind=${kind}&zm=${zm}&th=${th}`);
      await page.evaluate((m) => (window as unknown as { __artlab: { seek(ms: number): void } }).__artlab.seek(m), 2000);
      await page.waitForTimeout(300);
      if ((await litPixels(page)) < 3) throw new Error(`blank portrait: ${kind}`);
      const png = path.join(tmp, `${kind}.png`);
      await page.screenshot({ path: png, clip: CLIP });
      const webp = path.join(OUT, `${kind}.webp`);
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', png, '-vf', `scale=${SIZE}:${SIZE}:flags=lanczos`, '-c:v', 'libwebp', '-quality', '82', webp]);
      const b = statSync(webp).size;
      bytes += b;
      console.log(`${kind.padEnd(22)} ${(b / 1024).toFixed(1)} KB`);
    }
    await browser.close();
    console.log(`${kinds.length} pictures, ${(bytes / 1024).toFixed(0)} KB total -> ${OUT}`);
  } finally {
    vite.kill();
    if (process.platform === 'win32' && vite.pid) {
      try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
