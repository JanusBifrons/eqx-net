// In-game stills of the structure-scale citadel lattice (plan soft-leaping-truffle
// v2, A0 showcase). Joins the `structure-scale-test` room with the ship parked in
// an open cell near the base centre and captures the real renderer at three
// zooms: the whole fenced base, the network, and close-up connectors.
//
//   node scripts/showcase/structure-scale-stills.mjs [outDir]
// Requires warm dev servers (pnpm dev:server:nowatch + pnpm dev:client).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const out = process.argv[2] ?? 'diag/showcase/structure-scale';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const shots = [
  ['overview', '0.17'],
  ['network', '0.45'],
  ['close', '1.1'],
];
for (const [name, zoom] of shots) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const params = new URLSearchParams({
    room: 'structure-scale-test', testId: randomUUID(), worker: '0', diag: '0',
    zoom, effects: '0', nofilters: '1', spawnX: '200', spawnY: '200',
  });
  await page.goto(`http://localhost:5173/?${params}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    undefined,
    { timeout: 240000 },
  );
  // Past the warp curtain + let a grid pulse or two light the connectors.
  await page.waitForTimeout(7000);
  const path = `${out}/${name}.png`;
  await page.screenshot({ path });
  console.log('shot', path);
  await page.close();
}
await browser.close();
