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
//   node scripts/showcase/wreck-field-stills.mjs [outDir] [--sector <key> ...]
// --sector (wreck fields 11): shoot a real galaxy sector's field instead of the
// dev room (which sits in a dense rock field), joined as a player would
// (`?room=galaxy-<key>`: the room `resolveSectorConfig` gives its
// `wreckField`), laid out here the same way. Per sector:
//   <key>-arrival.png — the normal play zoom on the battle pocket's rim, where
//                       a warp from the home pocket drops you;
//   <key>-dense.png   — the normal play zoom on the densest phone view;
//   <key>-far.png     — the gameplay zoom-out floor, centred on the core;
//   <key>-capital.png — a capital's sections up close (from the live pieces).
// The server log's 'wreck field laid out' lines are echoed at the end, so the
// joined room's real hull count can be checked against the planned one.
// Boots its own capture server + Vite (showcase/servers.ts) on the
// EQX_SHOWCASE_PORT_OFFSET lane and stops them at the end.
import { chromium, devices } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';

const args = process.argv.slice(2);
const sectors = [];
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--sector') sectors.push(args[++i]);
  else pos.push(args[i]);
}
const out = path.resolve(pos[0] ?? 'diag/showcase/wreck-fields');
mkdirSync(out, { recursive: true });
const here = import.meta.url;
const { CaptureServers, defaultPorts } = await tsImport('../../showcase/servers.ts', here);
const { PLAYER_LOOK, FILM_HUD } = await tsImport('../../showcase/recorder.ts', here);
const { wreckField, wreckFieldKinds, rockFieldBlocker } = await tsImport('../../src/core/terrain/wreckFieldLayout.ts', here);
const { cutFieldOpts } = await tsImport('../../src/core/terrain/chunkStreamer.ts', here);
const { sectorWreckField, sectorCutField, sectorSites, warpDropPoint } = await tsImport('../../src/core/galaxy/sectorSites.ts', here);
const { SOLAR_SECTORS } = await tsImport('../../src/shared-types/sectorBounds.ts', here);

const capitalKinds = new Set(wreckFieldKinds(true, true).capitals);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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

/** A field's targets: the capital nearest the core, the busiest cluster and
 *  the densest normal-zoom view (the ship parks at its nearest clear point). */
function planShots(FIELD, label) {
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
  // pieces' hulls touching it.
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
  if (!capital && !cluster) throw new Error(`${label}: field has no hulls (${FIELD.hulls.length})`);
  if (!capital) console.log(`${label}: field has no capital: the capital shot is skipped`);
  const kinds = {};
  for (const h of FIELD.hulls) kinds[h.kindId] = (kinds[h.kindId] ?? 0) + 1;
  console.log(`${label}: densest view: ${dense.n} hulls round (${dense.x | 0}, ${dense.y | 0}), ship at (${denseSpawn.x | 0}, ${denseSpawn.y | 0})`);
  console.log(`${label}: field at (${FIELD.x | 0}, ${FIELD.y | 0}): ${FIELD.hulls.length} hulls ${JSON.stringify(kinds)}, ${FIELD.dropped} dropped; capital ${capital?.kindId} at (${capital?.x | 0}, ${capital?.y | 0}) r ${capital?.footprint | 0}; cluster of ${best} round ${cluster?.kindId}`);
  return { capital, cluster, denseSpawn };
}

/** The shot list: the dev room's looks, or each --sector's real field. */
const RUNS = [];
if (sectors.length === 0) {
  // The dev rooms' field (src/server/index.ts `wreck-field-test`), laid out as the
  // room does (SectorRoom.buildWreckFieldSource): around the 'look' cut field's rocks.
  const FIELD = wreckField({
    seed: 'look', x: 60_000, y: 0, sides: ['ashen-league', 'vel-concord'],
    blocked: rockFieldBlocker(cutFieldOpts('look', undefined)),
  });
  const { capital, cluster, denseSpawn } = planShots(FIELD, 'wreck-field-test');
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
  for (const { look, room } of LOOKS) for (const s of SHOTS) RUNS.push({ prefix: look, room, ...s });
} else {
  for (const key of sectors) {
    // As the galaxy room is configured (resolveSectorConfig) and lays it out
    // (SectorRoom.buildWreckFieldSource: round the rock field, if any).
    const wf = sectorWreckField(key, SOLAR_SECTORS);
    if (!wf) throw new Error(`sector '${key}' has no wreck field (solar sectors ${SOLAR_SECTORS})`);
    const cut = sectorCutField(key, SOLAR_SECTORS);
    const FIELD = wreckField({ ...wf, ...(cut ? { blocked: rockFieldBlocker(cutFieldOpts(cut.seed, cut.clearings)) } : {}) });
    const { capital, denseSpawn } = planShots(FIELD, key);
    const sites = sectorSites(key);
    const pocket = sites.find((s) => s.kind === 'combat') ?? sites.find((s) => s.kind === 'base');
    const home = sites.find((s) => s.kind === 'home') ?? { x: 0, y: 0 };
    const arrive = warpDropPoint(pocket, home.x, home.y);
    console.log(`${key}: rock field ${cut ? 'yes' : 'none'}; battle pocket ${pocket.id} at (${pocket.x | 0}, ${pocket.y | 0}) r ${pocket.r}; arrival (warp from home) at (${arrive.x}, ${arrive.y})`);
    const room = `galaxy-${key}`;
    RUNS.push({ prefix: key, room, name: 'arrival', spawnX: arrive.x, spawnY: arrive.y });
    RUNS.push({ prefix: key, room, name: 'dense', spawnX: denseSpawn.x, spawnY: denseSpawn.y });
    RUNS.push({ prefix: key, room, name: 'far', spawnX: FIELD.x, spawnY: FIELD.y, zoom: '0.15' });
    if (capital) RUNS.push({ prefix: key, room, name: 'capital', spawnX: capital.x, spawnY: capital.y - capital.footprint - 120, zoom: fit(capital.footprint) });
  }
}

const runDir = mkdtempSync(path.join(os.tmpdir(), 'eqx-wreck-stills-'));
const servers = new CaptureServers(process.cwd(), runDir, defaultPorts());
let browser;
try {
  await servers.ensure('lean');
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  for (const s of RUNS) {
    const { prefix, room } = s;
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    const q = new URLSearchParams({
      room, testId: randomUUID(), worker: '0', diag: '0', hud: FILM_HUD, ...PLAYER_LOOK,
      spawnX: String(Math.round(s.spawnX)), spawnY: String(Math.round(s.spawnY)),
      ...(s.zoom ? { zoom: s.zoom } : {}),
      // A galaxy join lands in command view (startMode.ts); a pilot warping in,
      // or launching a ship from the map, flies: shoot from the helm.
      ...(room.startsWith('galaxy-') ? { startMode: 'fly' } : {}),
    });
    await page.goto(`${servers.baseUrl}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    // In game (the recorder's join gate), then the field's pieces drawn.
    await page.waitForFunction(() => {
      const st = window.__eqxStore?.getState();
      return !!st && st.phase === 'game' && !!st.firstSnapshotApplied && !!st.rendererFirstFrameRendered && !!st.joinMinimumElapsed;
    }, undefined, { timeout: 240000 });
    // The load curtain lags the join flags (the recorder's waitForInGame): a
    // galaxy sector still shows LOADING SECTOR here while the on-screen
    // wreck pieces bake their Machined art (slow under SwiftShader).
    const curtainT0 = Date.now();
    await page.waitForSelector('[data-testid="warp-screen"][data-warp-visible="0"], body:not(:has([data-testid="warp-screen"]))', { timeout: 300000 })
      .then(() => console.log(`  ${prefix}-${s.name}: curtain down ${((Date.now() - curtainT0) / 1000).toFixed(1)} s after the join flags`))
      .catch(async () => {
        const g = await page.evaluate(() => {
          const st = window.__eqxStore?.getState() ?? {};
          const keys = ['connectionStatus', 'localShipInstanceId', 'localPoseResolved', 'pilotMode', 'clientReadySent', 'arrivalTickFromServer', 'arrivalAcked'];
          return Object.fromEntries(keys.map((k) => [k, st[k]]));
        });
        console.log(`  ${prefix}-${s.name}: load curtain still up after 300 s ${JSON.stringify(g)}`);
      });
    await page.waitForFunction(() => (window.__eqxClient?.mirror?.wrecks?.size ?? 0) > 0, undefined, { timeout: 60000 })
      .catch(() => console.log(`  ${prefix}-${s.name}: no wreck descriptors in the mirror after 60 s`));
    // The pieces round the ship stream in after the curtain (at once when
    // nothing was on screen to bake): wait for their count to hold for 4 s.
    let last = -1, steady = 0;
    for (let t = 0; t < 90 && steady < 8; t++) {
      await page.waitForTimeout(500);
      const n = await page.evaluate(() => {
        let c = 0;
        for (const e of window.__eqxClient?.mirror?.swarm?.values() ?? []) if (e.kind === 4) c++;
        return c;
      });
      steady = n === last && n > 0 ? steady + 1 : 0;
      last = n;
    }
    await page.waitForTimeout(1200); // the arrival flash
    const info = await page.evaluate(() => {
      const m = window.__eqxClient?.mirror;
      let pieces = 0;
      for (const e of m?.swarm?.values() ?? []) if (e.kind === 4) pieces++;
      let hot = 0;
      for (const d of m?.wrecks?.values() ?? []) if (d.deathTick !== undefined) hot++;
      return { wrecks: m?.wrecks?.size ?? 0, hot, pieces };
    });
    const file = path.join(out, `${prefix}-${s.name}.png`);
    await page.screenshot({ path: file });
    console.log(`shot ${file} (wrecks ${info.wrecks}, with deathTick ${info.hot}, pieces ${info.pieces}, zoom ${s.zoom ?? 'default'})`);
    await ctx.close();
  }
} finally {
  await browser?.close();
  servers.stop();
  // The rooms' own layout (SectorRoom.buildWreckFieldSource logs it).
  const log = path.join(runDir, 'server.log');
  // eslint-disable-next-line no-control-regex -- strip the pretty log's colours
  const lines = existsSync(log) ? readFileSync(log, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n') : [];
  lines.forEach((line, i) => {
    if (line.includes('wreck field laid out')) console.log(`server: ${[line, ...lines.slice(i + 1, i + 5)].map((l) => l.trim()).join(' ')}`);
  });
}
