/**
 * Fire Control HUD (exp/fire-control, `?ui=d`): weapon groups + target locks.
 * Catalogue-only takes (`pnpm showcase:fc` → showcase-out/fc/<id>.mp4):
 *
 *  - fc-phone-landscape (20 s): a gunship (Fore + Aft groups) in a pack of
 *    hostile drones. Fore is AUTO and locks on its own; the pilot switches to
 *    Aft, drags a lock line onto another drone, flips Aft to MAN and holds its
 *    chip to fire, then locks a selected drone with the inspector's Target
 *    button.
 *  - fc-desktop (20 s): the same on desktop — LMB drag to lock, 1/2 to pick a
 *    group, Shift+2 for AUTO/MAN, T to lock the selection.
 *  - fc-failsafe-phone (12 s): the drones are NEUTRAL. A lock on one runs the
 *    yellow failsafe ring; the pilot aborts it (no harm done), then locks again
 *    and lets it finish — a hostile act, after which the red lock runs.
 *
 * Gestures target live drones read from the client mirror (never hard-coded
 * screen points); HUD controls are found by `data-testid`.
 */
import type { Shot, ShotContext } from '../types.js';
import { mouse, touch, type Finger, type Mouse } from '../touch.js';
import { polar, type Pt } from '../touchPath.js';
import { mkdirSync } from 'node:fs';

/** Stills for the write-up: showcase-out/fc/stills/<name>.png. */
const STILLS = 'showcase-out/fc/stills';
async function snap(ctx: ShotContext, name: string): Promise<void> {
  try {
    mkdirSync(STILLS, { recursive: true });
    await ctx.page.screenshot({ path: `${STILLS}/${name}.png` });
  } catch (e) {
    ctx.log(`  ⚠ [fc] still ${name} failed: ${(e as Error).message}`);
  }
}

type Rect = { x: number; y: number; width: number; height: number };
const MAX_KBPS = 4000;

/** Every graphics option on: Machined art, new effects + backdrop, GPU lighting
 *  (high preset), speed effects. Automation otherwise defaults to classic art. */
const GFX = { art: 'machined', fx: 'new', shiplight: 'gpu', speedfx: 1 } as const;

const PARAMS = (hostile: boolean): Record<string, string | number> => ({
  ...GFX,
  ...(hostile ? { startHostile: 1 } : {}),
  shipKind: 'gunship',
  initialHull: 100_000,
  worker: 0,
  touchviz: 1,
  fakeCredits: 1,
  ui: 'd',
});

async function rectOf(ctx: ShotContext, sel: string, nth = 0): Promise<Rect | null> {
  const loc = ctx.page.locator(sel);
  if ((await loc.count().catch(() => 0)) <= nth) return null;
  return loc.nth(nth).boundingBox({ timeout: 300 }).catch(() => null);
}
const centre = (r: Rect): Pt => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

interface Pick {
  /** Screen angle (0 = right, −π/2 = up) from the ship to the drone. */
  angle: number;
  /** Game-space drone position (for the selection hook). */
  x: number;
  y: number;
}

/** Nearest live drone that no weapon group has locked yet (else the nearest). */
async function pickDrone(ctx: ShotContext): Promise<Pick | null> {
  return ctx.page
    .evaluate(() => {
      const c = (window as unknown as {
        __eqxClient?: {
          mirror?: {
            localPlayerId?: string | null;
            ships?: Map<string, { x: number; y: number }>;
            swarm?: Map<number, { kind: number; x: number; y: number }>;
            localGroups?: Array<{ l: Array<{ t: string }> }>;
          };
        };
      }).__eqxClient;
      const m = c?.mirror;
      const me = m?.localPlayerId ? m.ships?.get(m.localPlayerId) : undefined;
      if (!me || !m?.swarm) return null;
      const locked = new Set<string>();
      for (const g of m.localGroups ?? []) for (const l of g.l) locked.add(l.t);
      let free: { x: number; y: number } | null = null;
      let any: { x: number; y: number } | null = null;
      let bf = Infinity;
      let ba = Infinity;
      for (const [id, e] of m.swarm) {
        if (e.kind !== 1) continue;
        const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
        if (d < ba) { ba = d; any = e; }
        if (!locked.has(`s:${id}`) && d < bf) { bf = d; free = e; }
      }
      const t = free ?? any;
      return t ? { angle: Math.atan2(-(t.y - me.y), t.x - me.x), x: t.x, y: t.y } : null;
    })
    .catch(() => null);
}

function startClock(ctx: ShotContext, durationMs: number) {
  const t0 = Date.now();
  const end = t0 + durationMs - 450;
  return {
    left: () => end - Date.now(),
    at: async (ms: number) => {
      const wait = t0 + ms - Date.now();
      if (wait > 0) await ctx.sleep(wait);
    },
    fit: (ms: number) => Math.max(0, Math.min(ms, end - Date.now())),
  };
}
type Clock = ReturnType<typeof startClock>;

/** Left thumb: gentle arcs on the move stick for the whole take. */
async function steer(ctx: ShotContext, finger: Finger, clock: Clock): Promise<void> {
  const zone = await rectOf(ctx, '[data-testid="hud-move-zone"]');
  const anchor = zone
    ? { x: zone.x + Math.min(120, zone.width * 0.3), y: zone.y + zone.height * 0.62 }
    : { x: 120, y: ctx.viewport.height - 110 };
  const R = 44;
  await finger.down(anchor.x, anchor.y);
  let a = -Math.PI / 2;
  await finger.dragTo(anchor.x, anchor.y - R * 0.7, { ms: 300 });
  let side = 1;
  while (clock.left() > 900) {
    const to = -Math.PI / 2 + side * 1.1;
    const ms = clock.fit(2600);
    if (ms < 300) break;
    await finger.circle({ center: anchor, r: R * 0.7, from: a, to, ms });
    a = to;
    side = -side;
  }
  await finger.dragTo(anchor.x, anchor.y, { ms: 180 });
  await finger.up();
}

/** Right thumb: drag a lock line toward a drone, hold so the guide shows, release. */
async function thumbLock(ctx: ShotContext, finger: Finger, clock: Clock, still?: string): Promise<void> {
  const { width: w, height: h } = ctx.viewport;
  const origin = { x: w - 250, y: h - 105 };
  let pick = await pickDrone(ctx);
  if (!pick) return;
  await finger.down(origin.x, origin.y);
  await finger.dragTo(polar(origin, 18, pick.angle).x, polar(origin, 18, pick.angle).y, { ms: 160 });
  const end = Date.now() + clock.fit(1100);
  let shot = false;
  while (Date.now() < end - 80) {
    pick = (await pickDrone(ctx)) ?? pick;
    const p = polar(origin, 40, pick.angle);
    await finger.dragTo(p.x, p.y, { ms: 200 });
    if (still && !shot) { shot = true; await snap(ctx, still); }
  }
  await finger.up();
}

async function tapSel(ctx: ShotContext, finger: Finger, sel: string, nth = 0): Promise<boolean> {
  const r = await rectOf(ctx, sel, nth);
  if (!r) {
    ctx.log(`  ⚠ [fc] ${sel} not visible`);
    return false;
  }
  const c = centre(r);
  await finger.tap(c.x, c.y, 90);
  return true;
}

/** Select the next unlocked drone through the dev hook (the inspector opens). */
async function selectDrone(ctx: ShotContext): Promise<boolean> {
  const pick = await pickDrone(ctx);
  if (!pick) return false;
  const id = await ctx.page
    .evaluate(([x, y]) => (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null }).__eqxSelectAtWorld?.(x!, y!) ?? null, [pick.x, pick.y])
    .catch(() => null);
  return id !== null;
}

const CHIP = '[data-testid^="fc-chip-"]';
const MODE = '[data-testid^="fc-mode-"]';
const TARGET = '[data-testid="fc-target"]';

async function waitForStrip(ctx: ShotContext): Promise<void> {
  const ok = await ctx.page.locator(CHIP).first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (!ok) ctx.log('  ⚠ [fc] weapon strip never appeared — is fireControl wired?');
  await ctx.sleep(500);
}

// ---------------------------------------------------------------------------

async function runPhone(ctx: ShotContext, durationMs: number): Promise<void> {
  const clock = startClock(ctx, durationMs);
  const pad = await touch(ctx.page, ctx.log);
  try {
    const left = pad.finger();
    const right = pad.finger();
    const actions = async (): Promise<void> => {
      // 0–4.5 s: Fore (AUTO) locks a hostile on its own and opens fire.
      await clock.at(3800);
      await snap(ctx, '1-auto-lock-phone');
      await clock.at(4500);
      await tapSel(ctx, right, CHIP, 1); // Aft becomes the active group
      await clock.at(5600);
      await thumbLock(ctx, right, clock, '2-lock-line-phone'); // drag a lock line onto another drone
      await clock.at(8600);
      await snap(ctx, '3-two-groups-phone');
      await clock.at(9200);
      await tapSel(ctx, right, MODE, 1); // Aft → MAN
      await clock.at(10200);
      const chip = await rectOf(ctx, CHIP, 1);
      if (chip) {
        const c = centre(chip);
        await right.down(c.x, c.y); // hold the chip: Aft fires at its lock
        await right.hold(clock.fit(1200));
        await snap(ctx, '4-manual-fire-phone');
        await right.hold(clock.fit(1000));
        await right.up();
      }
      await clock.at(13200);
      if (await selectDrone(ctx)) {
        await ctx.sleep(700);
        await snap(ctx, '5-target-button-phone');
        await tapSel(ctx, right, TARGET); // inspector Target → locks the selection
      }
      await clock.at(16200);
      await tapSel(ctx, right, MODE, 1); // Aft back to AUTO
      await clock.at(17200);
      const boost = await rectOf(ctx, '[data-testid="hud-boost"]');
      if (boost && clock.left() > 900) {
        const b = centre(boost);
        await right.down(b.x, b.y);
        await right.hold(clock.fit(900));
        await right.up();
      }
    };
    await ctx.sleep(300);
    await Promise.all([steer(ctx, left, clock), actions()]);
  } finally {
    await pad.dispose();
  }
}

async function runFailsafe(ctx: ShotContext, durationMs: number): Promise<void> {
  const clock = startClock(ctx, durationMs);
  const pad = await touch(ctx.page, ctx.log);
  try {
    const right = pad.finger();
    await clock.at(1000);
    await thumbLock(ctx, right, clock); // yellow failsafe ring starts
    await clock.at(2300);
    await snap(ctx, '6-failsafe-ring');
    await clock.at(3000);
    await tapSel(ctx, right, '[data-testid^="fc-clear-"]'); // abort: no harm done
    await clock.at(5000);
    await thumbLock(ctx, right, clock); // again — and let it finish
    // Failsafe completes (hostile act), then the red lock runs → brackets.
    await clock.at(9000);
    await snap(ctx, '7-failsafe-finished-hostile');
  } finally {
    await pad.dispose();
  }
}

async function runDesktop(ctx: ShotContext, durationMs: number): Promise<void> {
  const { page } = ctx;
  const clock = startClock(ctx, durationMs);
  const { width: w, height: h } = ctx.viewport;
  const c = { x: w / 2, y: h / 2 };
  const m: Mouse = await mouse(page, { x: c.x + 160, y: c.y + 80 });

  const keys = async (): Promise<void> => {
    await page.keyboard.down('w');
    let side: 'a' | 'd' = 'a';
    while (clock.left() > 700) {
      await page.keyboard.down(side);
      await ctx.sleep(clock.fit(600));
      await page.keyboard.up(side);
      await ctx.sleep(clock.fit(900));
      side = side === 'a' ? 'd' : 'a';
    }
    await page.keyboard.up('w');
  };

  const dragLock = async (): Promise<void> => {
    let pick = await pickDrone(ctx);
    if (!pick) return;
    const R = Math.min(w, h) * 0.24;
    const p0 = polar(c, 40, pick.angle);
    await m.glideTo(p0.x, p0.y, { ms: 300 });
    await m.down('left');
    const end = Date.now() + clock.fit(1300);
    let shot = false;
    while (Date.now() < end - 100) {
      pick = (await pickDrone(ctx)) ?? pick;
      const p = polar(c, R, pick.angle);
      await m.glideTo(p.x, p.y, { ms: 260 });
      if (!shot) { shot = true; await snap(ctx, '8-lock-drag-desktop'); }
    }
    await m.up('left');
  };

  const actions = async (): Promise<void> => {
    await clock.at(4200);
    await page.keyboard.press('2'); // Aft
    await clock.at(5000);
    await dragLock();
    await clock.at(8200);
    await snap(ctx, '9-two-groups-desktop');
    await clock.at(8800);
    await page.keyboard.press('Shift+Digit2'); // Aft → MAN
    await clock.at(9800);
    const chip = await rectOf(ctx, CHIP, 1);
    if (chip) {
      const p = centre(chip);
      await m.glideTo(p.x, p.y, { ms: 400 });
      await m.down('left'); // hold the chip to fire
      await ctx.sleep(clock.fit(2000));
      await m.up('left');
      await m.glideTo(c.x + 160, c.y + 80, { ms: 400 });
    }
    await clock.at(13200);
    if (await selectDrone(ctx)) {
      await ctx.sleep(600);
      await page.keyboard.press('t'); // lock the selection
    }
    await clock.at(16000);
    await page.keyboard.press('Shift+Digit2'); // Aft → AUTO
    await clock.at(16800);
    await m.down('right'); // boost
    await ctx.sleep(clock.fit(900));
    await m.up('right');
  };

  try {
    await Promise.all([keys(), actions()]);
  } finally {
    await m.releaseAll();
    for (const k of ['w', 'a', 'd']) await page.keyboard.up(k).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

// Warp-to (solar-system sector): Speed dial → Warp ▸ → the picker (a list on
// touch, the system map on desktop) → pick a destination → the spool runs with
// a status chip + Cancel.
async function runWarp(ctx: ShotContext, durationMs: number, phone: boolean): Promise<void> {
  const clock = startClock(ctx, durationMs);
  const tag = phone ? 'phone' : 'desktop';
  const click = async (sel: string): Promise<void> => {
    const loc = ctx.page.locator(sel).first();
    if (!(await loc.count())) { ctx.log(`  ⚠ [fc] ${sel} missing`); return; }
    await loc.click({ timeout: 2000 }).catch((e) => ctx.log(`  ⚠ [fc] click ${sel}: ${(e as Error).message}`));
  };
  await clock.at(1500);
  await click('[data-testid="speed-dial-fab"]');
  await clock.at(2500);
  await snap(ctx, `10-speed-dial-${tag}`);
  await click('[data-testid="speed-dial-warp"]');
  await clock.at(4200);
  await snap(ctx, `11-warp-picker-${tag}`);
  // The farthest enabled destination (so the spool and the turn show).
  const dest = ctx.page.locator('[data-testid^="warp-dest-"]:not([disabled])');
  const n = await dest.count();
  if (n > 0) await dest.nth(n - 1).click({ timeout: 2000 }).catch(() => {});
  else ctx.log('  ⚠ [fc] no warp destinations listed');
  await clock.at(7000);
  await snap(ctx, `12-warp-spooling-${tag}`);
  await clock.at(durationMs - 2500);
  await click('[data-testid="warp-cancel"]');
  await ctx.sleep(clock.fit(1200));
}

function warpShot(id: string, viewport: Shot['viewport'], phone: boolean): Shot {
  return {
    id,
    section: 'tech',
    title: 'HUD D · Warp to',
    caption: phone
      ? 'Warp ▸ opens a nearest-first list; pick one and the spool runs with a status chip and Cancel.'
      : 'On desktop Warp ▸ opens the system map; pick a pocket and the spool runs with Cancel.',
    features: ['P4'],
    docs: ['hud-variants'],
    reel: false,
    server: 'solar',
    viewport,
    ...(viewport === 'desktop' ? { captionLayout: 'none' as const } : {}),
    maxBitrateKbps: MAX_KBPS,
    target: { galaxy: 'sol-prime', params: { ...GFX, solar: '1', spawnX: 0, spawnY: 0, ui: 'd', worker: 0, touchviz: 1, fakeCredits: 1 } },
    hud: 'full',
    durationMs: 14_000,
    prepare: (ctx) => ctx.sleep(1500),
    run: (ctx) => runWarp(ctx, 14_000, phone),
  };
}

function fcShot(id: string, viewport: Shot['viewport'], durationMs: number, hostile: boolean, title: string, caption: string, run: (ctx: ShotContext) => Promise<void>): Shot {
  return {
    id,
    section: 'tech',
    title,
    caption,
    features: ['U8'],
    docs: ['hud-variants'],
    reel: false,
    server: 'lean',
    viewport,
    ...(viewport === 'desktop' ? { captionLayout: 'none' as const } : {}),
    maxBitrateKbps: MAX_KBPS,
    target: { room: 'feel-test', params: PARAMS(hostile) },
    hud: 'full',
    durationMs,
    prepare: waitForStrip,
    run,
  };
}

export const fireControlShots: readonly Shot[] = [
  fcShot('fc-phone-landscape', 'phone-landscape', 20_000, true, 'HUD D · Fire Control',
    'Weapon groups lock their own targets — drag a lock line, switch groups, hold to fire in MAN.',
    (ctx) => runPhone(ctx, 20_000)),
  fcShot('fc-desktop', 'desktop', 20_000, true, 'HUD D · Fire Control (desktop)',
    'Drag to lock, 1–9 to pick a group, Shift+n for AUTO/MAN, T to lock the selection.',
    (ctx) => runDesktop(ctx, 20_000)),
  fcShot('fc-failsafe-phone', 'phone-landscape', 12_000, false, 'HUD D · Failsafe lock',
    'Locking a neutral runs a yellow failsafe first — stop and nothing happens; finish and it is a hostile act.',
    (ctx) => runFailsafe(ctx, 12_000)),
  warpShot('fc-warp-phone', 'phone-landscape', true),
  warpShot('fc-warp-desktop', 'desktop', false),
];
