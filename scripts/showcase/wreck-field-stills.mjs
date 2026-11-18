// In-game stills of an old battlefield's wreckage for the owner's look question
// (wreck fields slice 9, owner Q4): AGED (what ships: field hulls load cool, no
// glowing cut edges) vs FRESH (the dev room `wreck-field-test-fresh`: the same
// hulls load with a death tick, so they draw as if just killed and then cool on
// the normal schedule). Per look:
//   <look>-capital.png — a capital hull's pieces up close (2-3 big sections);
//   <look>-cluster.png — a sub-capital / fighter cluster;
//   <look>-wide.png    — the field at the normal play zoom (no ?zoom);
//   <look>-far.png     — the gameplay zoom-out floor, centred on the core;
//   <look>-dense.png   — the normal play zoom on the densest phone view
//                        (wreck fields 11: the "tighter AND more wrecks" check).
// Wreck fields 11: aged only (owner chose the cold look); the fresh arm is
// still in LOOKS, commented out.
// The real game as a phone player sees it: Pixel 7 held sideways (touch,
// isMobile), the player's look (PLAYER_LOOK) and the full HUD (FILM_HUD). Each
// shot joins its own room (fresh testId), so the fresh look is shot straight
// after the hulls load (the glow is a clock from the death tick).
//
//   node scripts/showcase/wreck-field-stills.mjs [outDir]
// Boots its own capture server + Vite (showcase/servers.ts) on the
// EQX_SHOWCASE_PORT_OFFSET lane and stops them at the end.
import { chromium, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const out = path.resolve(process.argv[2] ?? 'diag/showcase/wreck-fields');
mkdirSync(out, { recursive: true });
const here = import.meta.url;
const { CaptureServers, defaultPorts } = await tsImport('../../showcase/servers.ts', here);
const { PLAYER_LOOK, FILM_HUD } = await tsImport('../../showcase/recorder.ts', here);
const { wreckField, wreckFieldKinds, rockFieldBlocker } = await tsImport('../../src/core/terrain/wreckFieldLayout.ts', here);
const { cutFieldOpts } = await tsImport('../../src/core/terrain/chunkStreamer.ts', here);

// The dev rooms' field (src/server/index.ts `wreck-field-test`), laid out as the
// room does (SectorRoom.buildWreckFieldSource): around the 'look' cut field's rocks.
const FIELD = wreckField({
  seed: 'look', x: 60_000, y: 0, sides: ['ashen-league', 'vel-concord'],
  blocked: rockFieldBlocker(cutFieldOpts('look', undefined)),
});
const capitalKinds = new Set(wreckFieldKinds(true, true).capitals);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = { x: FIELD.x, y: FIELD.y };
const capital = FIELD.hulls.filter((h) => capitalKinds.has(h.kindId)).sort((a, b) => dist(a, centre) - dist(b, centre))[0];
const small = FIELD.hulls.filter((h) => !capitalKinds.has(h.kindId));
let cluster = small[0];
let best = -1;
for (const h of small) {
  const n = small.filter((o) => dist(o, h) < 900).length;
  if (n > best) { best = n; cluster = h; }
}
// The densest sideways-phone view at the normal zoom (~2,600 x 1,160 u): most
// pieces' hulls touching it. The ship parks at its nearest clear point.
let dense = { x: FIELD.x, y: FIELD.y, n: -1 };
for (let dx = -9000; dx <= 9000; dx += 200) for (let dy = -9000; dy <= 9000; dy += 200) {
  const vx = FIELD.x + dx, vy = FIELD.y + dy;
  let n = 0;
  for (const h of FIELD.hulls) {
    const ex = Math.max(0, Math.abs(h.x - vx) - 1300), ey = Math.max(0, Math.abs(h.y - vy) - 580);
    if (ex * ex + ey * ey < h.footprint * h.footprint) n++;
  }
  if (n > dense.n) dense = { x: vx, y: vy, n };
}
const clearOf = (p) => !FIELD.hulls.some((h) => dist(h, p) < h.footprint + 80);
let denseSpawn = { x: dense.x, y: dense.y };
for (let k = 0; k < 400 && !clearOf(denseSpawn); k++) denseSpawn = { x: dense.x + ((k % 20) - 10) * 60, y: dense.y + (Math.floor(k / 20) - 10) * 60 };
if (!capital && !cluster) throw new Error(`field has no hulls (${FIELD.hulls.length})`);
if (!capital) console.log('field has no capital: the capital shot is skipped');
console.log(`densest view: ${dense.n} hulls round (${dense.x | 0}, ${dense.y | 0}), ship at (${denseSpawn.x | 0}, ${denseSpawn.y | 0})`);
console.log(`field: ${FIELD.hulls.length} hulls, ${FIELD.dropped} dropped; capital ${capital?.kindId} at (${capital?.x | 0}, ${capital?.y | 0}) r ${capital?.footprint | 0}; cluster of ${best} round ${cluster.kindId} at (${cluster.x | 0}, ${cluster.y | 0})`);

// Pixel 7 held sideways (phones play landscape only).
const P7 = devices['Pixel 7'];
const PHONE = {
  ...P7,
  viewport: { width: P7.viewport.height, height: P7.viewport.width },
  screen: { width: P7.screen.height, height: P7.screen.width },
  isMobile: true,
  hasTouch: true,
};
const VIEW_H = PHONE.viewport.height;
// Ship parked just off the hull (outside its footprint), zoomed so the hull fits the short side.
const fit = (r) => Math.max(0.15, Math.min(1, VIEW_H / (2 * r + 500))).toFixed(3);
const SHOTS = [
  ...(capital ? [{ name: 'capital', spawnX: capital.x, spawnY: capital.y - capital.footprint - 120, zoom: fit(capital.footprint) }] : []),
  { name: 'cluster', spawnX: cluster.x, spawnY: cluster.y - cluster.footprint - 120, zoom: fit(700) },
  { name: 'wide', spawnX: FIELD.x, spawnY: FIELD.y },
  { name: 'far', spawnX: FIELD.x, spawnY: FIELD.y, zoom: '0.15' },
  { name: 'dense', spawnX: denseSpawn.x, spawnY: denseSpawn.y },
];
const LOOKS = [
  { look: 'aged', room: 'wreck-field-test' },
  // { look: 'fresh', room: 'wreck-field-test-fresh' },
];

const runDir = mkdtempSync(path.join(os.tmpdir(), 'eqx-wreck-stills-'));
const servers = new CaptureServers(process.cwd(), runDir, defaultPorts());
let browser;
try {
  await servers.ensure('lean');
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  for (const { look, room } of LOOKS) {
    for (const s of SHOTS) {
      const ctx = await browser.newContext(PHONE);
      const page = await ctx.newPage();
      const q = new URLSearchParams({
        room, testId: randomUUID(), worker: '0', diag: '0', hud: FILM_HUD, ...PLAYER_LOOK,
        spawnX: String(Math.round(s.spawnX)), spawnY: String(Math.round(s.spawnY)),
        ...(s.zoom ? { zoom: s.zoom } : {}),
      });
      await page.goto(`${servers.baseUrl}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      // In game (the recorder's join gate), then the field's pieces drawn.
      await page.waitForFunction(() => {
        const st = window.__eqxStore?.getState();
        return !!st && st.phase === 'game' && !!st.firstSnapshotApplied && !!st.rendererFirstFrameRendered && !!st.joinMinimumElapsed;
      }, undefined, { timeout: 240000 });
      await page.waitForFunction(() => (window.__eqxClient?.mirror?.wrecks?.size ?? 0) > 0, undefined, { timeout: 60000 })
        .catch(() => console.log(`  ${look}-${s.name}: no wreck descriptors in the mirror after 60 s`));
      await page.waitForTimeout(1200); // the arrival flash
      const info = await page.evaluate(() => {
        const m = window.__eqxClient?.mirror;
        let pieces = 0;
        for (const e of m?.swarm?.values() ?? []) if (e.kind === 4) pieces++;
        let hot = 0;
        for (const d of m?.wrecks?.values() ?? []) if (d.deathTick !== undefined) hot++;
        return { wrecks: m?.wrecks?.size ?? 0, hot, pieces };
      });
      const file = path.join(out, `${look}-${s.name}.png`);
      await page.screenshot({ path: file });
      console.log(`shot ${file} (wrecks ${info.wrecks}, with deathTick ${info.hot}, pieces ${info.pieces}, zoom ${s.zoom ?? 'default'})`);
      await ctx.close();
    }
  }
} finally {
  await browser?.close();
  servers.stop();
}
