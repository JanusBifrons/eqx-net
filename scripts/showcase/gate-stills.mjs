// In-game stills of Shield Gates (plan soft-leaping-truffle v2, phase V gates).
// Joins the `gate-test` room south of the open (west) gate and captures:
//   closed.png   — both gates closed, the ship waiting south of them;
//   opening.png  — the ship flying north: the west gate opens, the east stays shut;
//   through.png  — the ship past the open gate;
//   fence.png    — the scale lattice's rectangular fence with a gate on each side.
//
//   node scripts/showcase/gate-stills.mjs [outDir]
// Requires warm dev servers (pnpm dev:server:nowatch + pnpm dev:client).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const out = process.argv[2] ?? 'diag/showcase/gates';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});

async function join(params) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const q = new URLSearchParams({ testId: randomUUID(), worker: '0', diag: '0', effects: '0', nofilters: '1', ...params });
  await page.goto(`http://localhost:5173/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    undefined,
    { timeout: 240000 },
  );
  await page.waitForTimeout(7000); // past the warp curtain + a grid pulse
  return page;
}

const gates = await join({ room: 'gate-test', zoom: '0.55', spawnX: '-400', spawnY: '-1300' });
await gates.screenshot({ path: `${out}/closed.png` });
console.log('shot closed');
await gates.locator('[data-testid="game-surface"]').click();
await gates.keyboard.down('w');
await gates.waitForTimeout(900);
await gates.screenshot({ path: `${out}/opening.png` });
console.log('shot opening');
await gates.waitForTimeout(900);
await gates.keyboard.up('w');
await gates.screenshot({ path: `${out}/through.png` });
console.log('shot through');
await gates.close();

const fence = await join({ room: 'structure-scale-test', zoom: '0.12', spawnX: '200', spawnY: '200' });
await fence.screenshot({ path: `${out}/fence.png` });
console.log('shot fence');
await fence.close();
await browser.close();
