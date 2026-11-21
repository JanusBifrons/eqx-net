/**
 * Join flow stage 3 — bake the Hangar's ship pictures.
 *
 *   pnpm ships:portraits [--only fighter,battleship]
 *
 * Also bakes every buildable structure (the build menu) into
 * `public/structures/<kind>.webp` from the same scene (`?struct=`); `--only`
 * takes ship and structure kinds alike. A structure is framed by what it
 * actually draws: render it wide, diff against the same camera with no
 * structure (`bare`) for the drawn bounding box, reframe centred on the box
 * with an even pad, measure once more at that zoom, then shoot.
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
import { PORTRAIT_KINDS, STRUCTURE_PORTRAIT_KINDS, portraitQuery, reframeStructure, structurePortraitQuery, type StructureFrame } from '../../src/client/render/art/shipPortraits.js';

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const ONLY = flag('--only')?.split(',');
/** `--debug`: print each structure's measured boxes and frames. */
const DEBUG = args.includes('--debug');
const PORT = 5378;
const OUT = path.resolve('public/ships');
const OUT_STRUCT = path.resolve('public/structures');
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

const VIEW = { w: 1600, h: 900 };
/** Measurement grid: the canvas downsampled by this factor. */
const DS = 2;

/** Seek the open scene to the shot time. */
async function settle(page: Page): Promise<void> {
  await page.evaluate((m) => (window as unknown as { __artlab: { seek(ms: number): void } }).__artlab.seek(m), 2000);
  await page.waitForTimeout(300);
}

/** The whole canvas, downsampled, as RGB bytes. */
async function grab(page: Page, q: string): Promise<Buffer> {
  await open(page, q);
  await settle(page);
  const b64 = await page.evaluate(([w, h]) => {
    const src = document.querySelector('canvas')!;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const x = tmp.getContext('2d')!;
    x.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let s = '';
    for (let i = 0; i < d.length; i += 4) s += String.fromCharCode(d[i]!, d[i + 1]!, d[i + 2]!);
    return btoa(s);
  }, [VIEW.w / DS, VIEW.h / DS] as const);
  return Buffer.from(b64, 'base64');
}

/** Bounding box (canvas px) of where the structure render differs from the bare one, or null. */
function drawnBox(a: Buffer, b: Buffer): { x0: number; y0: number; x1: number; y1: number } | null {
  const w = VIEW.w / DS, h = VIEW.h / DS;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) <= 30) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0: x0 * DS, y0: y0 * DS, x1: (x1 + 1) * DS, y1: (y1 + 1) * DS };
}

/** Measure structure `kind`'s drawn bounds and return the frame that centres and fills the picture. */
async function frameStructure(page: Page, kind: string): Promise<StructureFrame> {
  let frame: StructureFrame = { zm: 0.4, cx: 0, cy: 0 };
  for (let pass = 0; pass < 2; pass++) {
    for (let tries = 0; ; tries++) {
      const box = drawnBox(await grab(page, structurePortraitQuery(kind, frame)), await grab(page, structurePortraitQuery(kind, frame, true)));
      if (!box) throw new Error(`blank portrait: ${kind}`);
      const edge = box.x0 <= DS || box.y0 <= DS || box.x1 >= VIEW.w - DS || box.y1 >= VIEW.h - DS;
      if (DEBUG) console.log(kind, pass, JSON.stringify(box), JSON.stringify(frame), edge ? 'edge' : '');
      if (edge && tries < 4) { frame = { ...frame, zm: frame.zm * 0.6 }; continue; }
      frame = reframeStructure(frame, box, VIEW, CLIP.height);
      break;
    }
  }
  return frame;
}

async function main(): Promise<void> {
  const want = (k: string): boolean => !ONLY || ONLY.includes(k);
  const jobs = [
    ...PORTRAIT_KINDS.filter(want).map((kind) => ({ kind, q: async (): Promise<string> => portraitQuery(kind), dir: OUT })),
    ...STRUCTURE_PORTRAIT_KINDS.filter(want).map((kind) => ({
      kind, q: async (page: Page): Promise<string> => structurePortraitQuery(kind, await frameStructure(page, kind)), dir: OUT_STRUCT,
    })),
  ];
  mkdirSync(OUT, { recursive: true });
  mkdirSync(OUT_STRUCT, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'eqx-portraits-'));
  const vite = bootVite();
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/__art-lab__/index.html`, 120_000);
    console.log(`vite up on ${PORT}`);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: VIEW.w, height: VIEW.h } });
    let bytes = 0;
    for (const { kind, q, dir } of jobs) {
      await open(page, await q(page));
      await settle(page);
      if ((await litPixels(page)) < 3) throw new Error(`blank portrait: ${kind}`);
      const png = path.join(tmp, `${kind}.png`);
      await page.screenshot({ path: png, clip: CLIP });
      const webp = path.join(dir, `${kind}.webp`);
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', png, '-vf', `scale=${SIZE}:${SIZE}:flags=lanczos`, '-c:v', 'libwebp', '-quality', '82', webp]);
      const b = statSync(webp).size;
      bytes += b;
      console.log(`${kind.padEnd(22)} ${(b / 1024).toFixed(1)} KB`);
    }
    await browser.close();
    console.log(`${jobs.length} pictures, ${(bytes / 1024).toFixed(0)} KB total -> ${OUT}, ${OUT_STRUCT}`);
  } finally {
    // Windows: kill the whole tree FIRST. Killing the shell first orphans
    // vite (taskkill /T then finds no tree), which keeps the port and, via its
    // inherited pipes, keeps this script from exiting.
    if (process.platform === 'win32' && vite.pid) {
      try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    vite.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
