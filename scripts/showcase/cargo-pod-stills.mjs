// In-game stills of the cargo pod look (plan cargo-pods, slice 9 look gate):
// the red box at its four sizes beside the player's ship, each with a
// different beacon (grey, blue, gold, magenta). Boots its own server + Vite on
// an offset lane, mints a dev token, joins `sector` as a Pixel 7 with the
// machined art, sends `test_drop_pods` and screenshots two zooms.
//
// --window (slice 17): also select the huge pod, open its loot window and
// shoot it searching, all found, and after one tile is tapped aboard.
//
//   node scripts/showcase/cargo-pod-stills.mjs [outDir] [--offset N] [--window] [--room R]
// --room: the room to join (default sector; trade-test is a quiet galaxy room
// with no AI, so nothing kills the ship while the window is open).
// Run through the heavy queue: pnpm heavy run --kind film -- node scripts/showcase/cargo-pod-stills.mjs
import { chromium, devices } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const oi = args.indexOf('--offset');
const OFFSET = oi >= 0 ? Number(args[oi + 1]) : 37;
const ri = args.indexOf('--room');
const ROOM = ri >= 0 ? args[ri + 1] : 'sector';
const out = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--offset' && args[i - 1] !== '--room') ?? 'diag/showcase/cargo-pods';
const WINDOW = args.includes('--window');
const SERVER = 2567 + OFFSET, CLIENT = 5173 + OFFSET, HMR = 24678 + OFFSET;
mkdirSync(out, { recursive: true });

const kids = [];
function boot(cmd, env) {
  const c = spawn(cmd, { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', () => {}); c.stderr.on('data', () => {});
  kids.push(c);
}
function stopAll() {
  for (const c of kids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(c.pid)], { windowsHide: true });
    else c.kill('SIGKILL');
  }
}
async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('timed out waiting for ' + url);
}

try {
  boot('pnpm dev:server:nowatch', { PORT: String(SERVER), EQX_ALLOW_DEV_OVERRIDES: '1' });
  boot(`pnpm dev:client --port ${CLIENT} --strictPort`, { EQX_SERVER_PORT: String(SERVER), VITE_HMR_PORT: String(HMR) });
  await waitFor(`http://localhost:${SERVER}/healthz`, 90_000);
  await waitFor(`http://localhost:${CLIENT}/`, 90_000);
  const tok = await (await fetch(`http://localhost:${SERVER}/auth/dev/test-token`, { method: 'POST' })).json();

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  for (const [name, zoom] of WINDOW ? [['close', '1.1']] : [['wide', '0.45'], ['close', '1.1']]) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    await ctx.addInitScript((t) => { localStorage.setItem('eqxAuthToken', t); }, tok.token);
    const page = await ctx.newPage();
    const q = new URLSearchParams({ room: ROOM, testId: randomUUID(), worker: '0', diag: '0', art: 'machined', fx: 'new', zoom });
    await page.goto(`http://localhost:${CLIENT}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(
      () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
      undefined,
      { timeout: 240_000 },
    );
    await page.waitForTimeout(6000); // past the warp curtain
    await page.evaluate(() => globalThis.__eqxClient.getRoom().send('test_drop_pods', { type: 'test_drop_pods' }));
    await page.waitForTimeout(3000); // pods spawn + art warms
    await page.screenshot({ path: `${out}/pods-${name}.png` });
    console.log('shot', name);
    if (WINDOW) {
      // The huge pod nearest the ship (size 3: componentIndex = size*4 + tier).
      // The room keeps pods from earlier runs, so never "the rightmost".
      const at = await page.evaluate(() => {
        const c = globalThis.__eqxClient.mirror;
        const me = c.ships.get(c.localPlayerId);
        let best = null, bestD = Infinity;
        for (const [, s] of c.swarm) {
          if (s.kind !== 3 || s.shipKind !== 'cargo-pod' || Math.floor((s.componentIndex ?? 0) / 4) !== 3) continue;
          const d = Math.hypot(s.x - me.x, s.y - me.y);
          if (d < bestD) { bestD = d; best = { x: s.x, y: s.y }; }
        }
        return best;
      });
      if (at === null) throw new Error('no pod in the mirror');
      await page.evaluate(([x, y]) => globalThis.__eqxSelectAtWorld(x, y), [at.x, at.y]);
      await page.getByTestId('pod-open').waitFor({ timeout: 5_000 });
      console.log('pod in reach:', await page.getByTestId('pod-open').getAttribute('data-in-reach'));
      await page.getByTestId('pod-open').click();
      await page.getByTestId('cargo-panel').waitFor({ timeout: 5_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/window-searching.png` });
      await page.getByTestId('cargo-unknown-tile').first().waitFor({ state: 'detached', timeout: 15_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/window-found.png` });
      await page.getByTestId('cargo-here-row').first().click(); // one stack aboard; the pod stays
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/window-taken.png` });
      // Slice 19: close it, then "your hold" from the HUD cargo chip.
      await page.getByTestId('loot-window-close').click();
      await page.getByTestId('loot-window').waitFor({ state: 'detached', timeout: 5_000 });
      await page.getByTestId('cargo-chip').click();
      await page.getByTestId('cargo-selected').waitFor({ timeout: 5_000 });
      await page.getByTestId('cargo-here-row').first().click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/window-own.png` });
      console.log('shot window');
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  stopAll();
}
