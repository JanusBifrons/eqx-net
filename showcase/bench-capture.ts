/**
 * Capture benchmark — "can this machine film smoothly right now, and how?"
 *
 *   pnpm exec tsx showcase/bench-capture.ts <outDir> [modes]
 *
 * One combat scene (feel-test, hostile, ship thrusting). For each mode it
 * reports the GAME's own frame cadence (RAF) while capturing, and how many
 * frames the capture actually delivered. A mode is only good if BOTH are ~60.
 *
 * Modes: `none@WxH`, `cdp@WxH@q` (CDP screencast JPEG quality q),
 *        `mr@WxH@codec` (MediaRecorder on the canvas, codec vp8|vp9).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { CaptureServers } from './servers.js';
import { resolveFfmpeg } from './tools.js';

const OUT = process.argv[2] ?? 'showcase-out/bench';
const MODES = (process.argv[3] ?? 'none@1280x720,cdp@1280x720@80,mr@1280x720@vp8,none@1600x900,cdp@1600x900@80,mr@1600x900@vp8').split(',');
const SECONDS = 8;
mkdirSync(path.join(OUT, 'run'), { recursive: true });

interface Raf {
  fps: number;
  p50: number;
  p95: number;
  max: number;
}
// String-evaluated: tsx/esbuild injects a `__name` helper into named functions,
// which does not exist in the browser.
const RAF_PROBE = `(dur) => new Promise((res) => {
  const g = []; let last = performance.now(); const end = last + dur;
  const f = (t) => { g.push(t - last); last = t; if (t < end) { requestAnimationFrame(f); return; }
    g.sort((a, b) => a - b); const q = (x) => +g[Math.floor(x * (g.length - 1))].toFixed(1);
    res({ fps: +(g.length / (dur / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), max: Math.round(g[g.length - 1]) }); };
  requestAnimationFrame(f);
})`;
const measureRaf = (page: Page, ms: number): Promise<Raf> => page.evaluate(`(${RAF_PROBE})(${ms})`) as Promise<Raf>;

const MR_START = `(mime) => {
  const c = [...document.querySelectorAll('canvas')].sort((x, y) => y.width * y.height - x.width * x.height)[0];
  const rec = new MediaRecorder(c.captureStream(60), { mimeType: mime, videoBitsPerSecond: 20000000 });
  const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
  window.__rec = rec; window.__chunks = chunks; rec.start(1000);
}`;
const MR_STOP = `(async () => {
  const rec = window.__rec; await new Promise((r) => { rec.onstop = r; rec.stop(); });
  const buf = new Uint8Array(await new Blob(window.__chunks).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
})()`;

const servers = new CaptureServers(process.cwd(), path.join(OUT, 'run'));
await servers.ensure('lean');
const browser = await chromium.launch({
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});

async function openScene(w: number, h: number): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const tok = (await (await fetch(`${servers.serverUrl}/auth/dev/test-token`, { method: 'POST' })).json()) as { token: string };
  await ctx.addInitScript((t) => localStorage.setItem('eqxAuthToken', t), tok.token);
  const page = await ctx.newPage();
  await page.goto(
    `${servers.baseUrl}/?room=feel-test&worker=0&diag=0&hud=minimal&cleanworld=1&noselfdmg=1&startHostile=1&initialHull=1000000&shipKind=interceptor&testId=bench-${Date.now()}`,
    { waitUntil: 'domcontentloaded', timeout: 180_000 },
  );
  await page.waitForFunction(
    `(() => { const s = window.__eqxStore?.getState(); return s?.phase === 'game' && s.firstSnapshotApplied && s.rendererFirstFrameRendered && s.joinMinimumElapsed; })()`,
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(2500);
  await page.keyboard.down('w');
  return { ctx, page };
}

const rows: string[] = [];
for (const mode of MODES) {
  const [kind, res, opt] = mode.split('@') as [string, string, string | undefined];
  const [w, h] = res.split('x').map(Number) as [number, number];
  const { ctx, page } = await openScene(w, h);
  let delivered = '';
  if (kind === 'none') {
    const r = await measureRaf(page, SECONDS * 1000);
    rows.push(`${mode.padEnd(22)} game ${JSON.stringify(r)}`);
  } else if (kind === 'cdp') {
    const cdp = await ctx.newCDPSession(page);
    let n = 0;
    cdp.on('Page.screencastFrame', (f: { sessionId: number }) => {
      n++;
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: Number(opt ?? 92), everyNthFrame: 1, maxWidth: w, maxHeight: h });
    const r = await measureRaf(page, SECONDS * 1000);
    await cdp.send('Page.stopScreencast');
    delivered = `captured ${(n / SECONDS).toFixed(1)} fps`;
    rows.push(`${mode.padEnd(22)} game ${JSON.stringify(r)}  ${delivered}`);
  } else {
    await page.evaluate(`(${MR_START})('video/webm;codecs=${opt ?? 'vp8'}')`);
    const r = await measureRaf(page, SECONDS * 1000);
    const b64 = (await page.evaluate(MR_STOP)) as string;
    const file = path.join(OUT, `${mode.replace(/[@]/g, '_')}.webm`);
    writeFileSync(file, Buffer.from(b64, 'base64'));
    const probe = spawnSync(resolveFfmpeg('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    delivered = `captured ${(Number(probe.stdout.trim()) / SECONDS).toFixed(1)} fps`;
    rows.push(`${mode.padEnd(22)} game ${JSON.stringify(r)}  ${delivered}`);
  }
  console.log(rows[rows.length - 1]);
  await page.keyboard.up('w');
  await ctx.close();
}
await browser.close();
servers.stop();
writeFileSync(path.join(OUT, 'bench.txt'), rows.join('\n'));
