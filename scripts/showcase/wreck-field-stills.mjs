// In-game stills of an old battlefield's wreckage for the owner's look question
// (wreck fields slice 9, owner Q4): AGED (what ships: field hulls load cool, no
// glowing cut edges) vs FRESH (the dev room `wreck-field-test-fresh`: the same
// hulls load with a death tick, so they draw as if just killed and then cool on
// the normal schedule). Per look, each shot centred on the wreck it names:
//   <look>-capital.png — the capital hull nearest the field centre, its broken
//                        sections, at the zoom-out floor (the only gameplay
//                        zoom a ~4 000 u long cruiser mostly fits at);
//   <look>-subcap.png  — the biggest sub-capital hull, up close;
//   <look>-group.png   — the densest group of small hulls that fits one screen
//                        at the zoom-out floor (logs if it has fewer than 3);
//   <look>-wide.png    — the hull nearest the field centre at the normal play zoom (no ?zoom);
//   <look>-far.png     — the same hull at the gameplay zoom-out floor.
//   fresh-capital-first-sight.png — the fresh capital before its art settles (hot edges).
// Shots wait for the ship art to settle (`__eqxArtStats`), as `showcase/shots/capitals.ts` does.
// The real game as a phone player sees it: Pixel 7 held sideways (touch,
// isMobile), the player's look (PLAYER_LOOK) and the full HUD (FILM_HUD). Each
// shot joins its own room (fresh testId), so the fresh look is shot straight
// after the hulls load (the glow is a clock from the death tick); the log
// gives each fresh shot's wreck age so a cooled glow is reported, not hidden.
//
// Wreck fields 9 fix (first run, 2026-11-18): the capital shot parked the ship
// a footprint (1.5 hull radii, ~3 000 u) off the cruiser's centre while the
// floor zoom shows only ~1 370 u above and below the ship, so the hull sat off
// screen; and its "wrecks on screen" was the mirror's whole wreck list. Now a
// probe join reads the live pieces, parks the ship beside the hull's long side
// and every shot counts only the pieces inside the viewport.
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
const { GAMEPLAY_MIN_ZOOM, GAMEPLAY_MAX_ZOOM, startZoomForScale } = await tsImport('../../src/shared-types/shipScale/tuning.ts', here);

// The dev rooms' field (src/server/index.ts `wreck-field-test`), laid out as the
// room does (SectorRoom.buildWreckFieldSource): around the 'look' cut field's rocks.
const FIELD = wreckField({
  seed: 'look', x: 60_000, y: 0, sides: ['ashen-league', 'vel-concord'],
  blocked: rockFieldBlocker(cutFieldOpts('look', undefined)),
});
const capitalKinds = new Set(wreckFieldKinds(true, true).capitals);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centre = { x: FIELD.x, y: FIELD.y };
const byCentre = (a, b) => dist(a, centre) - dist(b, centre);
const capital = FIELD.hulls.filter((h) => capitalKinds.has(h.kindId)).sort(byCentre)[0];
const small = FIELD.hulls.filter((h) => !capitalKinds.has(h.kindId));
if (!capital || small.length === 0) throw new Error(`field has no capital/small hull (hulls ${FIELD.hulls.length})`);
const subcap = [...small].sort((a, b) => b.footprint - a.footprint || byCentre(a, b))[0];
const nearest = [...FIELD.hulls].sort(byCentre)[0];

// Pixel 7 held sideways (phones play landscape only).
const P7 = devices['Pixel 7'];
const PHONE = {
  ...P7,
  viewport: { width: P7.viewport.height, height: P7.viewport.width },
  screen: { width: P7.screen.height, height: P7.screen.width },
  isMobile: true,
  hasTouch: true,
};
const VIEW_W = PHONE.viewport.width, VIEW_H = PHONE.viewport.height;
const FLOOR = GAMEPLAY_MIN_ZOOM; // every kind's zoom-out floor is at or below it
const DEFAULT_ZOOM = startZoomForScale(0.5); // PixiRenderer DEFAULT_GAMEPLAY_ZOOM at the ship scale
const clampZoom = (z) => Math.max(FLOOR, Math.min(GAMEPLAY_MAX_ZOOM, z));

// The densest group of small hulls that fits one screen at the floor zoom (20 % margin).
const winW = 0.8 * VIEW_W / FLOOR, winH = 0.8 * VIEW_H / FLOOR;
let group = [small[0]];
for (const a of small) for (const b of small) {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const g = small.filter((o) => Math.abs(o.x - cx) < winW / 2 && Math.abs(o.y - cy) < winH / 2);
  if (g.length > group.length) group = g;
}
const gx0 = Math.min(...group.map((h) => h.x)), gx1 = Math.max(...group.map((h) => h.x));
const gy0 = Math.min(...group.map((h) => h.y)), gy1 = Math.max(...group.map((h) => h.y));
const groupMid = { x: (gx0 + gx1) / 2, y: (gy0 + gy1) / 2 };
// The group inside the middle 60 % of the view (clear of the corner HUD).
const groupZoom = clampZoom(Math.min(0.6 * VIEW_W / (gx1 - gx0 + 1), 0.6 * VIEW_H / (gy1 - gy0 + 1)));

console.log(`field: ${FIELD.hulls.length} hulls (${small.length} sub-cap/fighter)`);
console.log(`  capital ${capital.kindId} at (${capital.x | 0}, ${capital.y | 0}) footprint ${capital.footprint | 0}`);
console.log(`  biggest sub-cap ${subcap.kindId} at (${subcap.x | 0}, ${subcap.y | 0})`);
console.log(`  nearest the centre: ${nearest.kindId} at (${nearest.x | 0}, ${nearest.y | 0})`);
console.log(group.length >= 3
  ? `  densest group: ${group.length} hulls in one floor-zoom screen`
  : `  NO group of 3+ sub-cap/fighter hulls fits one screen even at the zoom-out floor (${(winW | 0)} x ${(winH | 0)} u); densest is ${group.length}: ${group.map((h) => `${h.kindId} (${h.x | 0}, ${h.y | 0})`).join(', ')}`);

const LOOKS = [
  { look: 'aged', room: 'wreck-field-test' },
  { look: 'fresh', room: 'wreck-field-test-fresh' },
];

const runDir = mkdtempSync(path.join(os.tmpdir(), 'eqx-wreck-stills-'));
const servers = new CaptureServers(process.cwd(), runDir, defaultPorts());
let browser;

/** Join `room` with the ship parked at `spawn`, wait until in game and wreck pieces arrive. */
async function join(room, spawn, zoom) {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  const q = new URLSearchParams({
    room, testId: randomUUID(), worker: '0', diag: '0', hud: FILM_HUD, ...PLAYER_LOOK,
    spawnX: String(Math.round(spawn.x)), spawnY: String(Math.round(spawn.y)),
    ...(zoom !== undefined ? { zoom: zoom.toFixed(3) } : {}),
  });
  await page.goto(`${servers.baseUrl}/?${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  // In game (the recorder's join gate), then the field's pieces in the mirror.
  await page.waitForFunction(() => {
    const st = window.__eqxStore?.getState();
    return !!st && st.phase === 'game' && !!st.firstSnapshotApplied && !!st.rendererFirstFrameRendered && !!st.joinMinimumElapsed;
  }, undefined, { timeout: 240000 });
  await page.waitForFunction(() => {
    for (const e of window.__eqxClient?.mirror?.swarm?.values() ?? []) if (e.kind === 4) return true;
    return false;
  }, undefined, { timeout: 60000 }).catch(() => console.log(`  ${room}: no wreck pieces in the mirror after 60 s`));
  return { ctx, page };
}

/** The live wreck pieces (kind 4) within `r` of `c`, plus the local ship and wreck clock. */
function readMirror(page, c, r, halfW, halfH) {
  return page.evaluate(({ c, r, halfW, halfH }) => {
    const m = window.__eqxClient?.mirror;
    const me = m?.localPlayerId != null ? m.ships?.get(m.localPlayerId) : undefined;
    const cam = me ? { x: me.x, y: me.y } : null;
    const near = [];
    let onScreen = 0, maxTick = 0;
    for (const e of m?.swarm?.values() ?? []) {
      for (const p of e.poseRing ?? []) if (!p.empty && p.serverTick > maxTick) maxTick = p.serverTick;
      if (e.kind !== 4) continue;
      if (Math.hypot(e.x - c.x, e.y - c.y) < r) near.push({ x: e.x, y: e.y, r: e.radius });
      if (cam && Math.abs(e.x - cam.x) < halfW && Math.abs(e.y - cam.y) < halfH) onScreen++;
    }
    let hot = 0, minAgeMs = Infinity;
    for (const d of m?.wrecks?.values() ?? []) if (d.deathTick !== undefined) {
      hot++;
      minAgeMs = Math.min(minAgeMs, Math.max(0, maxTick - d.deathTick) * (1000 / 60));
    }
    return { cam, near, onScreen, wrecks: m?.wrecks?.size ?? 0, hot, minAgeMs };
  }, { c, r, halfW, halfH });
}

try {
  await servers.ensure('lean');
  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });

  // Probe: the capital's live pieces, read from a ship parked clear of the
  // whole hull circle (radius = footprint / 1.5). Their spread gives the hull's
  // long axis; the shot parks the ship just off its long side so the broken
  // sections fill the floor-zoom view. It also checks the live room laid the
  // hull where this script's layout says.
  const hullR = capital.footprint / 1.5;
  let capSpawn = { x: capital.x - (hullR + 250), y: capital.y };
  {
    const { ctx, page } = await join(LOOKS[0].room, { x: capital.x, y: capital.y + hullR + 400 }, FLOOR);
    await page.waitForTimeout(1500);
    const { near, cam } = await readMirror(page, capital, hullR + 300, 0, 0);
    console.log(`probe: ship at (${cam?.x | 0}, ${cam?.y | 0}); ${near.length} live wreck pieces within ${hullR + 300 | 0} u of the layout's ${capital.kindId} centre`);
    if (near.length >= 2) {
      let mx = 0, my = 0;
      for (const p of near) { mx += p.x; my += p.y; }
      mx /= near.length; my /= near.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of near) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy); // the long axis
      const px = -Math.sin(a), py = Math.cos(a); // across it
      let side = 0;
      for (const p of near) side = Math.max(side, Math.abs((p.x - mx) * px + (p.y - my) * py) + p.r);
      side = Math.min(side, 0.6 * VIEW_H / 2 / FLOOR); // keep the hull's middle on screen
      capSpawn = { x: mx + px * (side + 200), y: my + py * (side + 200) };
      console.log(`  pieces' centre (${mx | 0}, ${my | 0}) (layout said (${capital.x | 0}, ${capital.y | 0})), long axis ${(a * 180 / Math.PI).toFixed(0)} deg, half-width ${side | 0} u -> park at (${capSpawn.x | 0}, ${capSpawn.y | 0})`);
    } else {
      console.log(`  too few live pieces: the live hull is NOT where the layout says; falling back to a side park`);
    }
    await ctx.close();
  }

  const beside = (h, zoom) => ({ x: h.x - Math.min(h.footprint + 120, 0.45 * VIEW_W / 2 / zoom), y: h.y });
  const SHOTS = [
    { name: 'capital', target: capital, spawn: capSpawn, zoom: FLOOR },
    { name: 'subcap', target: subcap, spawn: beside(subcap, 1.5), zoom: 1.5 },
    { name: 'group', target: groupMid, spawn: { x: groupMid.x, y: groupMid.y - 150 }, zoom: groupZoom },
    { name: 'wide', target: nearest, spawn: beside(nearest, DEFAULT_ZOOM), zoom: undefined },
    { name: 'far', target: nearest, spawn: beside(nearest, FLOOR), zoom: FLOOR },
  ];
  // Art first: a wreck piece draws as a plain polygon until its dead ship's
  // art has baked (capitals take seconds on a phone), so every look is shot
  // once the art has settled, as a player sees it after the first moments.
  // The fresh glow is a clock from the death tick (seconds), so it has cooled
  // by then; FRESH_FIRST shoots the fresh capital at first sight as well, the
  // glow over whatever art is ready, so the look question sees both.
  const FRESH_FIRST = 'capital';
  const plan = [];
  for (const l of LOOKS) for (const s of SHOTS) {
    plan.push({ ...l, s, settle: true, file: `${l.look}-${s.name}.png` });
    if (l.look === 'fresh' && s.name === FRESH_FIRST) plan.push({ ...l, s, settle: false, file: `${l.look}-${s.name}-first-sight.png` });
  }
  // One shot's failed join (2026-11-18: the 11th join never left the join
  // screen in 240 s) is logged and skipped, not fatal to the rest.
  for (const { room, s, settle, file: name } of plan) {
    let ctx;
    try {
      const joined = await join(room, s.spawn, s.zoom);
      ctx = joined.ctx;
      const page = joined.page;
      let art = 'not waited';
      if (settle) {
        const t0 = Date.now();
        art = await page.waitForFunction(() => {
          const st = globalThis.__eqxArtStats?.();
          return !!st && (st.ready ?? 0) > 0 && (st.pending ?? 1) === 0;
        }, null, { timeout: 120_000, polling: 500 }).then(() => `settled in ${((Date.now() - t0) / 1000).toFixed(1)} s`, () => 'NOT settled after 120 s');
      }
      await page.waitForTimeout(1200); // the arrival flash
      const z = s.zoom ?? DEFAULT_ZOOM;
      const info = await readMirror(page, s.target, 1e9, VIEW_W / 2 / z, VIEW_H / 2 / z);
      const file = path.join(out, name);
      await page.screenshot({ path: file });
      const tgt = info.cam ? `target ${dist(info.cam, s.target) | 0} u from the ship` : 'no local ship';
      const age = info.hot > 0 ? `, youngest wreck ${(info.minAgeMs / 1000).toFixed(1)} s old by the newest swarm tick seen (low when every piece sleeps)` : '';
      console.log(`shot ${file}: zoom ${z.toFixed(3)}${s.zoom === undefined ? ' (default)' : ''}, ship (${info.cam?.x | 0}, ${info.cam?.y | 0}), ${tgt}; art ${art}; pieces in view ${info.onScreen}; wrecks known ${info.wrecks} (with deathTick ${info.hot}${age})`);
    } catch (e) {
      console.log(`FAILED ${name}: ${e?.message?.split(String.fromCharCode(10))[0] ?? e}`);
    } finally {
      await ctx?.close();
    }
  }
} finally {
  await browser?.close();
  servers.stop();
}
