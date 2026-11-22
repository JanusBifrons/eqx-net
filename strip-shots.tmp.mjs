// node rail-shots.mjs <outDir> <offset>   (run from a worktree root)
import { chromium, devices } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [out, off] = process.argv.slice(2); const OFFSET = Number(off);
const SERVER = 2567 + OFFSET, CLIENT = 5173 + OFFSET, HMR = 24678 + OFFSET;
mkdirSync(out, { recursive: true });
const kids = [];
const boot = (cmd, env) => { const c = spawn(cmd, { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', () => {}); c.stderr.on('data', () => {}); kids.push(c); };
const stopAll = () => { for (const c of kids) spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { windowsHide: true }); };
async function waitFor(url, ms) { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error('timed out ' + url); }
try {
  boot('pnpm dev:server:nowatch', { PORT: String(SERVER), EQX_ALLOW_DEV_OVERRIDES: '1' });
  boot(`pnpm dev:client --port ${CLIENT} --strictPort`, { EQX_SERVER_PORT: String(SERVER), VITE_HMR_PORT: String(HMR) });
  await waitFor(`http://localhost:${SERVER}/healthz`, 240_000); await waitFor(`http://localhost:${CLIENT}/`, 300_000);
  const tok = await (await fetch(`http://localhost:${SERVER}/auth/dev/test-token`, { method: 'POST' })).json();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const ctx = await browser.newContext({ ...devices['Pixel 7 landscape'] });
  await ctx.addInitScript((t) => { localStorage.setItem('eqxAuthToken', t); }, tok.token);
  const page = await ctx.newPage();
  const q = new URLSearchParams({ room: process.argv[4] ?? 'trade-test', testId: randomUUID(), worker: '0', diag: '0', art: 'machined', fx: 'new' });
  await page.goto(`http://localhost:${CLIENT}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0, undefined, { timeout: 240_000 });
  await page.waitForTimeout(6000);
  const shot = async (n) => { await page.waitForTimeout(900); await page.screenshot({ path: `${out}/${n}.png` }); console.log('shot', n); };
  const tap = async (sel) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible()) { await l.click({ force: true }); return true; } console.log('missing', sel); return false; };
  const hasRail = await page.locator('[data-testid="right-rail"]').count() > 0;
  const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(900); };
  const vp = page.viewportSize();
  const tp = async (sel) => { const l = page.locator(sel).first(); if (await l.count() && await l.isVisible()) { await l.tap({ force: true }); return true; } console.log('missing', sel); return false; };
  await shot('1-fly'); if (process.env.ONLY_DETAILS) { await tp('[data-testid="spectator-toggle"]'); await page.waitForTimeout(1500); }
  if (!process.env.ONLY_DETAILS) {
  await tp('[data-testid="spectator-toggle"]'); await page.waitForTimeout(800);
  await page.touchscreen.tap(vp.width / 2, vp.height / 2); await page.waitForTimeout(1200); await shot('2-command-selected');
  if (await tp('[data-testid="left-strip-order"]')) { await page.waitForTimeout(600); await shot('2b-flyout'); await esc(); }
  if (await tp('[data-testid="right-rail-fleet"]')) { await page.waitForTimeout(150); await page.screenshot({ path: out + '/3a-fleet-sliding.png' }); await page.waitForTimeout(1500); await shot('3-fleet-open'); }
  await esc(); await page.waitForTimeout(800); await shot('4-strip-back');
  if (await tp('[data-testid="right-rail-galaxy"]')) { await page.waitForTimeout(120); await page.screenshot({ path: out + '/5a-galaxy-sliding.png' }); await page.waitForTimeout(2500); await shot('5-galaxy'); }
  await esc(); if (await tp('[data-testid="right-rail-faction"]')) { await page.waitForTimeout(1500); await shot('5b-faction'); }
  if (await tp('[data-testid="right-rail-cog"]')) { await page.waitForTimeout(1500); await shot('5c-cog'); }
  if (await tp('[data-testid="right-rail-trade"]')) { await page.waitForTimeout(1500); await shot('5d-trade'); }
  await esc(); await tp('[data-testid="build-toggle"]'); await page.waitForTimeout(1500); await shot('6-build');
  await tp('[data-testid="build-toggle"]'); await page.waitForTimeout(1200); await esc();
  }
  const pick = await page.evaluate(() => { const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail'); if (!raw) return null; const d = JSON.parse(raw); const e = Object.entries(d).sort((a, b) => a[1].kind - b[1].kind)[0]; if (!e) return null; const k = window.__eqxSelectAtWorld?.(e[1].x, e[1].y); return { key: e[0], kind: e[1].kind, k }; });
  console.log('pick', JSON.stringify(pick)); await page.waitForTimeout(1500); await shot('7-other-selected');
  if (await tp('[data-testid="left-strip-cog"]').catch(() => false)) { await page.waitForTimeout(1500); await shot('8-details'); }
  await browser.close();
} finally { stopAll(); }
