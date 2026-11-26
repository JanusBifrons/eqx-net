// Base-platforms deck room stills. Copy into the worktree root as zz-deck-stills.mjs, run:
//   node zz-deck-stills.mjs <outDir> [--offset N] [--zooms 0.12,0.3]
import { chromium, devices } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const oi = args.indexOf('--offset');
const OFFSET = oi >= 0 ? Number(args[oi + 1]) : 53;
const zi = args.indexOf('--zooms');
const ZOOMS = (zi >= 0 ? args[zi + 1] : '0.12,0.3').split(',');
const out = args[0];
const SERVER = 2567 + OFFSET, CLIENT = 5173 + OFFSET, HMR = 24678 + OFFSET;
mkdirSync(out, { recursive: true });
const log = [];
const note = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };
const kids = [];
const boot = (cmd, env) => { const c = spawn(cmd, { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', () => {}); c.stderr.on('data', (d) => { const t = String(d).trim(); if (/lease|refus|error/i.test(t)) note('stderr', t.slice(0, 300)); }); kids.push(c); };
const stopAll = () => { for (const c of kids) spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { windowsHide: true }); };
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('timed out ' + url);
}
const shipsUp = (page) => page.waitForFunction(() => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0, undefined, { timeout: 240_000 });

let browser;
try {
  boot('pnpm dev:server:nowatch', { PORT: String(SERVER), EQX_ALLOW_DEV_OVERRIDES: '1', EQX_ENABLE_TEST_ROOMS: '1' });
  boot(`pnpm dev:client --port ${CLIENT} --strictPort`, { EQX_SERVER_PORT: String(SERVER), VITE_HMR_PORT: String(HMR) });
  await waitFor(`http://localhost:${SERVER}/healthz`, 300_000);
  await waitFor(`http://localhost:${CLIENT}/`, 300_000);
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const profiles = [['phone', { ...devices['Pixel 7 landscape'] }], ['desktop', { viewport: { width: 1600, height: 900 } }]];
  const PTS = { deckA: [0.62, 0.38], deckB: [0.72, 0.62], space: [0.16, 0.45], nearGate: [0.42, 0.5] };
  for (const [name, opts] of profiles) {
    const zoom = ZOOMS[0];
    const ctx = await browser.newContext(opts);
    const pid = randomUUID();
    await ctx.addInitScript((p) => { localStorage.setItem('eqxPlayerId', p); }, pid);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => note(name, 'pageerror', String(e).slice(0, 200)));
    const q = new URLSearchParams({ room: process.env.ROOM ?? 'deck', worker: '0', testId: randomUUID(), art: 'machined', fx: 'new', zoom, ...Object.fromEntries(new URLSearchParams(process.env.EXTRA ?? '')), ...(process.env.SPAWN ? { spawnX: process.env.SPAWN.split(',')[0], spawnY: process.env.SPAWN.split(',')[1] } : {}) });
    await page.goto(`http://localhost:${CLIENT}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await shipsUp(page);
    await page.waitForFunction(() => !document.body.innerText.includes('Calibrating warp ballast') && !document.body.innerText.includes('Parallel-parking in orbit'), undefined, { timeout: 240_000 });
    await page.waitForTimeout(6000);
    const vp = page.viewportSize();
    const at = (k) => [Math.round(PTS[k][0] * vp.width), Math.round(PTS[k][1] * vp.height)];
    let n = 0;
    const shot = async (label) => {
      await page.waitForTimeout(900);
      const st = await page.evaluate(() => {
        const d = document.querySelector('[data-testid="game-surface"]')?.dataset ?? {};
        const c = document.querySelector('[data-testid="placement-confirm"]');
        const m = document.body.innerText.match(/(off deck|no road|overlap|too close|need |blocked|can.t|not enough)[^\n]{0,60}/i);
        return { wx: d.placementWorldX, wy: d.placementWorldY, stuck: d.placementStuck, conns: d.placementPreviewConnCount,
          confirm: c ? (c.disabled || c.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'enabled') : 'none',
          kind: document.querySelector('[data-testid="placement-kind"]')?.getAttribute('data-state') ?? null, swarm: d.swarmSize, text: m ? m[0] : null };
      });
      const f = `${name}-${String(++n).padStart(2, '0')}-${label}.png`;
      await page.screenshot({ path: `${out}/${f}` });
      note('shot', f, JSON.stringify(st));
    };
    const tap = async (id) => { try { await page.locator('[data-testid="'+id+'"]').first().click({ timeout: 5000, force: true }); return true; } catch (e) { note(name, 'no', id, String(e).slice(0, 120)); return false; } };
    const panelOpen = () => page.locator('[data-testid^="build-cat-"]').first().isVisible().catch(() => false);
    const pick = async (cat, kind) => {
      if (!(await panelOpen())) { await tap('right-rail-build'); await page.waitForTimeout(600); }
      await tap('build-cat-' + cat); await page.waitForTimeout(300);
      try { await page.locator('[data-testid="build-' + kind + '"] button').first().click({ timeout: 5000, force: true }); } catch (e) { note(name, 'no kind', kind, String(e).slice(0, 120)); }
      await page.waitForTimeout(500);
    };
    const probe = async (x, y) => { await page.mouse.move(x, y, { steps: 3 }); await page.waitForTimeout(250); return page.evaluate(() => { const d = document.querySelector('[data-testid="game-surface"]')?.dataset ?? {}; return [Number(d.placementWorldX), Number(d.placementWorldY)]; }); };
    let cal = null;
    const calibrate = async () => {
      const cx = Math.round(vp.width / 2), cy = Math.round(vp.height / 2);
      const a = await probe(cx - 150, cy - 80), b = await probe(cx + 150, cy + 80);
      cal = { sx: (b[0] - a[0]) / 300, sy: (b[1] - a[1]) / 160, ax: a[0], ay: a[1], px: cx - 150, py: cy - 80 };
      note(name, 'cal', JSON.stringify(cal));
    };
    const goto = async (wx, wy) => { const x = cal.px + (wx - cal.ax) / cal.sx, y = cal.py + (wy - cal.ay) / cal.sy; await page.mouse.move(x - 20, y - 10); await page.mouse.move(Math.round(x), Math.round(y), { steps: 4 }); };
    const count = () => page.evaluate(() => globalThis.__eqxClient?.mirror?.structures?.size ?? null);
    const T = JSON.parse(process.env.TARGETS);
    try {
      await tap('build-toggle'); await page.waitForTimeout(800);
      await pick('economy', 'reactor'); await calibrate();
      await goto(...T.hexA); await shot('reactor-ghost');
      await goto(...T.space); await shot('reactor-ghost-off-deck');
      await tap('placement-cancel'); await page.waitForTimeout(600);
      await pick('economy', 'cargo_bay'); await calibrate();
      await goto(...T.hexA); await shot('cargo-ghost');
    } catch (e) { note(name, 'ERR', String(e).slice(0, 300)); }
    await ctx.close();
  }
  await browser.close();
} catch (e) { note('ERROR', String(e)); }
finally { try { await browser?.close(); } catch {} writeFileSync(out + '/log.txt', log.join('\n')); stopAll(); }
