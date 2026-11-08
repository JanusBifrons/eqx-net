/**
 * Experimental mobile-first piloting HUDs (exp/hud-mobile-first, `?ui=a|b|c`):
 * one ~20 s phone-landscape take, one ~20 s desktop take and one ~10 s
 * phone-portrait take per variant, each exported as its own mp4
 * (`pnpm showcase:hud` → showcase-out/hud/hud-<v>-<viewport>.mp4).
 *
 * The flight is scripted like a player: the left thumb steers in arcs around
 * the drone pack, auto-fire engages, then manual aim / fire, boost bursts and
 * back to auto. HUD controls are found by `data-testid` at run time (never
 * hard-coded); a missing testid logs a warning and falls back to a thumb
 * position. `?touchviz=1` draws the finger dots (src/client/hud/TouchViz.tsx).
 */
import type { Shot, ShotContext } from '../types.js';
import { mouse, touch, type Finger, type TouchPad } from '../touch.js';
import { clampTo, polar, type Pt } from '../touchPath.js';

type Variant = 'a' | 'b' | 'c';
type Rect = { x: number; y: number; width: number; height: number };

const VARIANT_NAMES: Record<Variant, string> = {
  a: 'Corner Clusters',
  b: 'Twin-Stick',
  c: 'Smart Attack',
};

const PARAMS = (v: Variant): Record<string, string | number> => ({
  startHostile: 1,
  initialHull: 100_000,
  worker: 0,
  touchviz: 1,
  fakeCredits: 1,
  ui: v,
});

/** Shared clip size cap: 20 s at ≤ 4 Mbit/s ≈ 10 MB (+ container overhead). */
const MAX_KBPS = 4000;

// ---------------------------------------------------------------------------
// Run-time helpers

/**
 * Testids a control may render under. A fixed (non-floating) stick renders
 * `<id>-home` as its touch target, e.g. variant C's ATTACK.
 */
const ALIASES: Record<string, readonly string[]> = {
  'hud-attack': ['hud-attack', 'hud-attack-home'],
};

/** Bounding box of the first VISIBLE element with this testid (or an alias), or null. */
async function rectOf(ctx: ShotContext, testId: string): Promise<Rect | null> {
  for (const id of ALIASES[testId] ?? [testId]) {
    const loc = ctx.page.locator(`[data-testid="${id}"]`);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const box = await loc.nth(i).boundingBox({ timeout: 250 }).catch(() => null);
      if (box && box.width > 0 && box.height > 0) return box;
    }
  }
  return null;
}

const centre = (r: Rect): Pt => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Warn once per testid per take. */
function makeLocator(ctx: ShotContext) {
  const warned = new Set<string>();
  return async (testId: string, fallback: Pt): Promise<Pt> => {
    const r = await rectOf(ctx, testId);
    if (r) return centre(r);
    if (!warned.has(testId)) {
      warned.add(testId);
      ctx.log(`  ⚠ [hud] no visible [data-testid="${testId}"] — falling back to (${Math.round(fallback.x)}, ${Math.round(fallback.y)})`);
    }
    return fallback;
  };
}

/** Thumb fallbacks (viewport-relative). */
function thumbs(ctx: ShotContext): { left: Pt; right: Pt } {
  const { width: w, height: h } = ctx.viewport;
  return { left: { x: 110, y: h - 110 }, right: { x: w - 110, y: h - 110 } };
}

/**
 * Screen direction (radians: 0 = right, −π/2 = up) from the local ship to the
 * nearest live drone, read from the client mirror (game space is Y-up, so the
 * screen angle flips y). Null when there is no ship or no drone.
 */
async function droneAngle(ctx: ShotContext): Promise<number | null> {
  return ctx.page
    .evaluate(() => {
      const c = (window as unknown as {
        __eqxClient?: {
          mirror?: {
            localPlayerId?: string | null;
            ships?: Map<string, { x: number; y: number }>;
            swarm?: Map<number, { kind: number; x: number; y: number }>;
          };
        };
      }).__eqxClient;
      const m = c?.mirror;
      const me = m?.localPlayerId ? m.ships?.get(m.localPlayerId) : undefined;
      if (!me || !m?.swarm) return null;
      let best: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const e of m.swarm.values()) {
        if (e.kind !== 1) continue;
        const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      return best ? Math.atan2(-(best.y - me.y), best.x - me.x) : null;
    })
    .catch(() => null);
}

/** Wall-clock timeline for a take: `await clock.at(4000)` waits until 4 s in. */
function startClock(ctx: ShotContext, durationMs: number) {
  const t0 = Date.now();
  const end = t0 + durationMs - 450; // every finger up before the take stops
  return {
    elapsed: () => Date.now() - t0,
    left: () => end - Date.now(),
    at: async (ms: number) => {
      const wait = t0 + ms - Date.now();
      if (wait > 0) await ctx.sleep(wait);
    },
    /** Clamp a gesture length so it ends before the take does. */
    fit: (ms: number) => Math.max(0, Math.min(ms, end - Date.now())),
  };
}
type Clock = ReturnType<typeof startClock>;

// ---------------------------------------------------------------------------
// Left thumb: steering in arcs

const STICK_R = 52;

/**
 * Hold the move stick and roll it in arcs: sweep the stick direction around
 * the drone pack's bearing (±~65°, alternating), with small thumb wiggles
 * between sweeps. Works for a heading stick (the ship weaves around the
 * fight) and a turn stick (it circles) alike.
 */
async function steer(ctx: ShotContext, finger: Finger, anchor0: Pt, clock: Clock): Promise<void> {
  const up = -Math.PI / 2;
  let anchor = anchor0;
  let lifted = false;
  await finger.down(anchor.x, anchor.y);
  await finger.dragTo(anchor.x, anchor.y - STICK_R, { ms: 320 });
  let current = up;
  let side = 1;
  let leg = 0;
  while (clock.left() > 700) {
    const bearing = (await droneAngle(ctx)) ?? up;
    const target = bearing + side * (0.75 + 0.35 * ((leg * 7) % 3) / 2);
    // Shortest way round to the new angle.
    let delta = target - current;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const ms = clock.fit(1700 + Math.abs(delta) * 900);
    if (ms < 200) break;
    await finger.circle({ center: anchor, r: STICK_R, from: current, to: current + delta, ms });
    current += delta;
    if (clock.left() > 900 && leg % 2 === 1) await finger.wiggle({ amp: 7, cycles: 2, ms: clock.fit(600) });
    side = -side;
    leg++;
    // Once, mid-clip: lift the thumb so the stick visibly glides home, then
    // land somewhere else so it visibly spawns under the thumb.
    if (!lifted && leg === 3 && clock.left() > 4000) {
      lifted = true;
      await finger.up();
      await ctx.sleep(900);
      anchor = { x: anchor0.x + 46, y: anchor0.y - 30 };
      await finger.down(anchor.x, anchor.y);
      const resume = polar(anchor, STICK_R, current);
      await finger.dragTo(resume.x, resume.y, { ms: 200 });
    }
  }
  // Ease back to centre and let go.
  await finger.dragTo(anchor.x, anchor.y, { ms: 180 });
  await finger.up();
}

async function moveAnchor(ctx: ShotContext, locate: ReturnType<typeof makeLocator>): Promise<Pt> {
  const zone = await rectOf(ctx, 'hud-move-zone');
  if (zone) {
    // Left-middle of the zone, kept a stick-radius clear of its edges.
    return clampTo({ x: zone.x + zone.width * 0.32, y: zone.y + zone.height * 0.6 }, zone, STICK_R + 8);
  }
  return locate('hud-move-home', thumbs(ctx).left);
}

// ---------------------------------------------------------------------------
// Right thumb: per-variant actions

type Action =
  | { at: number; do: 'boost'; ms: number }
  | { at: number; do: 'fire'; ms: number } // a: hold FIRE
  | { at: number; do: 'toggle' } // a: tap AUTO
  | { at: number; do: 'aim'; ms: number } // b: drag in the aim zone; c: press+drag ATTACK
  | { at: number; do: 'taps'; n: number }; // c: tap ATTACK n times

async function runActions(
  ctx: ShotContext,
  v: Variant,
  finger: Finger,
  actions: readonly Action[],
  clock: Clock,
  locate: ReturnType<typeof makeLocator>,
): Promise<void> {
  const { width: w, height: h } = ctx.viewport;
  const fb = {
    fire: thumbs(ctx).right,
    boost: { x: w - 110, y: h - 220 },
    toggle: { x: w - 220, y: h - 70 },
    aim: { x: w - 150, y: h - 140 },
  };
  for (const a of actions) {
    await clock.at(a.at);
    if (clock.left() < 300) break;
    switch (a.do) {
      case 'boost': {
        const p = await locate('hud-boost', fb.boost);
        await finger.down(p.x, p.y);
        await finger.wiggle({ amp: 2, cycles: 1, ms: clock.fit(a.ms) });
        await finger.up();
        break;
      }
      case 'fire': {
        const p = await locate('hud-fire', fb.fire);
        await finger.down(p.x, p.y);
        await finger.wiggle({ amp: 3, cycles: 2, ms: clock.fit(a.ms) });
        await finger.up();
        break;
      }
      case 'toggle': {
        const p = await locate('hud-auto-toggle', fb.toggle);
        await finger.tap(p.x, p.y, 80);
        break;
      }
      case 'taps': {
        const p = await locate('hud-attack', fb.fire);
        for (let i = 0; i < a.n && clock.left() > 400; i++) {
          await finger.tap(p.x + (i % 2) * 3, p.y - (i % 3) * 2, 70);
          await ctx.sleep(380);
        }
        break;
      }
      case 'aim': {
        await aimDrag(ctx, v, finger, clock.fit(a.ms), clock, locate, fb.aim, fb.fire);
        break;
      }
    }
  }
}

/**
 * Touch + drag to aim and fire: press the aim origin (b: the aim zone / its
 * home ring; c: the ATTACK button), pull toward the nearest drone's bearing,
 * then sweep ±25° across it (re-reading the bearing as the ship moves).
 */
async function aimDrag(
  ctx: ShotContext,
  v: Variant,
  finger: Finger,
  ms: number,
  clock: Clock,
  locate: ReturnType<typeof makeLocator>,
  aimFallback: Pt,
  attackFallback: Pt,
): Promise<void> {
  if (ms < 400) return;
  let origin: Pt;
  if (v === 'b') {
    const zone = await rectOf(ctx, 'hud-aim-zone');
    origin = zone
      ? // Low and inboard: the ring that spawns under the thumb stays clear
        // of BOOST and the AUTO pill above the aim stick's home.
        clampTo({ x: zone.x + zone.width * 0.45, y: zone.y + zone.height * 0.72 }, zone, 70)
      : await locate('hud-aim-home', aimFallback);
  } else {
    origin = await locate('hud-attack', attackFallback);
  }
  // c: a short pull keeps the thumb on the attack button's ring (not over
  // BOOST beside it, nor off the screen).
  const r = v === 'b' ? 56 : 30;
  const { width: w, height: h } = ctx.viewport;
  const bounds = { x: 28, y: 28, width: w - 56, height: h - 56 };
  let a = (await droneAngle(ctx)) ?? -Math.PI / 2;
  await finger.down(origin.x, origin.y);
  const first = clampTo(polar(origin, r, a), bounds);
  await finger.dragTo(first.x, first.y, { ms: 220 });
  const deadline = Date.now() + ms - 220;
  let dir = 1;
  while (Date.now() < deadline - 150 && clock.left() > 350) {
    const seg = Math.min(900, deadline - Date.now());
    const bearing = (await droneAngle(ctx)) ?? a;
    const to = bearing + dir * 0.45;
    // Sweep the pull angle; clamp onto the screen (a thumb can't leave it).
    await finger.follow((u) => clampTo(polar(origin, r, a + (to - a) * u), bounds), { ms: seg });
    a = to;
    dir = -dir;
  }
  await finger.up();
}

/** The timeline per variant. Landscape/desktop ≈ 20 s, portrait ≈ 10 s. */
function actionsFor(v: Variant, long: boolean): Action[] {
  if (v === 'a') {
    return long
      ? [
          { at: 4200, do: 'boost', ms: 900 },
          { at: 6200, do: 'toggle' },
          { at: 6800, do: 'fire', ms: 2600 },
          { at: 9900, do: 'boost', ms: 1000 },
          { at: 11400, do: 'fire', ms: 2400 },
          { at: 14300, do: 'toggle' },
          { at: 15600, do: 'boost', ms: 800 },
        ]
      : [
          { at: 1600, do: 'boost', ms: 700 },
          { at: 2900, do: 'toggle' },
          { at: 3400, do: 'fire', ms: 2400 },
          { at: 6200, do: 'toggle' },
          { at: 7200, do: 'boost', ms: 700 },
        ];
  }
  if (v === 'b') {
    return long
      ? [
          { at: 3800, do: 'boost', ms: 900 },
          { at: 5600, do: 'aim', ms: 3000 },
          { at: 9200, do: 'boost', ms: 1000 },
          { at: 10800, do: 'aim', ms: 3200 },
          { at: 14600, do: 'boost', ms: 800 },
          { at: 16000, do: 'aim', ms: 2200 },
        ]
      : [
          { at: 1500, do: 'aim', ms: 2400 },
          { at: 4400, do: 'boost', ms: 800 },
          { at: 5800, do: 'aim', ms: 2400 },
        ];
  }
  return long
    ? [
        { at: 3200, do: 'taps', n: 3 },
        { at: 5200, do: 'boost', ms: 900 },
        { at: 6800, do: 'aim', ms: 3000 },
        { at: 10400, do: 'boost', ms: 1000 },
        { at: 12000, do: 'taps', n: 4 },
        { at: 14400, do: 'aim', ms: 2400 },
        { at: 17200, do: 'boost', ms: 800 },
      ]
    : [
        { at: 1200, do: 'taps', n: 3 },
        { at: 2900, do: 'boost', ms: 700 },
        { at: 4200, do: 'aim', ms: 2400 },
        { at: 7200, do: 'boost', ms: 700 },
      ];
}

async function runPhone(ctx: ShotContext, v: Variant, durationMs: number, long: boolean): Promise<void> {
  const locate = makeLocator(ctx);
  const clock = startClock(ctx, durationMs);
  let pad: TouchPad | null = null;
  try {
    pad = await touch(ctx.page, ctx.log);
    const left = pad.finger();
    const right = pad.finger();
    const anchor = await moveAnchor(ctx, locate);
    // Auto-fire engages first: the right thumb waits while the left steers.
    await ctx.sleep(400);
    await Promise.all([
      steer(ctx, left, anchor, clock),
      runActions(ctx, v, right, actionsFor(v, long), clock, locate),
    ]);
  } finally {
    await pad?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Desktop: WASD arcs + mouse aim / fire, right mouse / Shift boost, F auto

async function runDesktop(ctx: ShotContext, durationMs: number): Promise<void> {
  const { page } = ctx;
  const clock = startClock(ctx, durationMs);
  const { width: w, height: h } = ctx.viewport;
  const c = { x: w / 2, y: h / 2 };
  // Keep the cursor below the top HUD row (pilot toggle, status capsule).
  const R = Math.min(w, h) * 0.26;
  const m = await mouse(page, { x: c.x + R * 0.6, y: c.y - R * 0.6 });

  const keys = async (): Promise<void> => {
    await page.keyboard.down('w');
    let side: 'a' | 'd' = 'a';
    let i = 0;
    while (clock.left() > 600) {
      const turn = clock.fit(650 + ((i * 5) % 4) * 180);
      await page.keyboard.down(side);
      await ctx.sleep(turn);
      await page.keyboard.up(side);
      await ctx.sleep(clock.fit(350 + (i % 3) * 150));
      side = side === 'a' ? 'd' : 'a';
      i++;
    }
    await page.keyboard.up('w');
  };

  /** Hold left mouse and sweep the cursor ±30° across the nearest drone. */
  const sweep = async (ms: number): Promise<void> => {
    let a = (await droneAngle(ctx)) ?? -Math.PI / 2;
    const p0 = polar(c, R, a);
    await m.glideTo(p0.x, p0.y, { ms: 260 });
    await m.down('left');
    const deadline = Date.now() + clock.fit(ms);
    let dir = 1;
    while (Date.now() < deadline - 120) {
      const bearing = (await droneAngle(ctx)) ?? a;
      const to = bearing + dir * 0.5;
      const from = a;
      await m.follow((u) => polar(c, R * (0.85 + 0.15 * Math.sin(Math.PI * u)), from + (to - from) * u), {
        ms: Math.min(1000, deadline - Date.now()),
      });
      a = to;
      dir = -dir;
    }
    await m.up('left');
  };

  const actions = async (): Promise<void> => {
    // 0–5 s: auto-fire engages; the cursor idles near the ship.
    await m.glideTo(c.x + R * 0.4, c.y - R * 0.3, { ms: 1500 });
    await clock.at(5000);
    await sweep(3000);
    await clock.at(8600);
    await m.down('right');
    await ctx.sleep(clock.fit(1000));
    await m.up('right');
    await clock.at(10000);
    await sweep(3000);
    await clock.at(13600);
    await page.keyboard.down('Shift');
    await ctx.sleep(clock.fit(900));
    await page.keyboard.up('Shift');
    await clock.at(15000);
    await page.keyboard.press('f'); // auto off
    await sweep(2600);
    await clock.at(18200);
    if (clock.left() > 0) await page.keyboard.press('f'); // auto back on
  };

  try {
    await Promise.all([keys(), actions()]);
  } finally {
    await m.releaseAll();
    for (const k of ['w', 'a', 'd', 'Shift']) await page.keyboard.up(k).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shots

/**
 * Ready check before recording (unfilmed): the recorder already waited for
 * the game (phase, first snapshot, first frame, curtain down, steady
 * prediction). Phones also wait for the variant HUD to mount its move zone.
 */
async function waitForHud(ctx: ShotContext, phone: boolean): Promise<void> {
  if (phone) {
    const ok = await ctx.page
      .locator('[data-testid="hud-move-zone"]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) ctx.log('  ⚠ [hud] hud-move-zone never appeared — is ?ui= wired on this branch? filming with fallbacks');
  }
  if (!(await rectOf(ctx, 'hud-credits'))) ctx.log('  ⚠ [hud] hud-credits not visible');
  await ctx.sleep(600);
}

type ViewportKey = 'phone-landscape' | 'desktop' | 'phone-portrait';

function hudShot(v: Variant, vk: ViewportKey): Shot {
  const phone = vk !== 'desktop';
  const long = vk !== 'phone-portrait';
  const durationMs = long ? 20_000 : 10_000;
  const where = vk === 'phone-landscape' ? 'phone, landscape' : vk === 'phone-portrait' ? 'phone, portrait' : 'desktop';
  return {
    id: `hud-${v}-${vk}`,
    section: 'tech',
    title: `HUD ${v.toUpperCase()} · ${VARIANT_NAMES[v]}`,
    caption:
      vk === 'desktop'
        ? `${VARIANT_NAMES[v]} on desktop — WASD to fly, hold the mouse to aim and fire, right mouse to boost, F for auto.`
        : `${VARIANT_NAMES[v]} (${where}) — steer with the left thumb, auto-fire, manual aim and boost.`,
    features: ['U8'],
    docs: ['hud-variants'],
    reel: false,
    server: 'lean',
    viewport: vk === 'phone-portrait' ? 'phone' : vk,
    // Desktop fills the frame: a caption would cover the HUD.
    ...(vk === 'desktop' ? { captionLayout: 'none' as const } : {}),
    maxBitrateKbps: MAX_KBPS,
    target: { room: 'cascade-test', params: PARAMS(v) },
    hud: 'full',
    durationMs,
    prepare: (ctx) => waitForHud(ctx, phone),
    run: (ctx) => (phone ? runPhone(ctx, v, durationMs, long) : runDesktop(ctx, durationMs)),
  };
}

const VARIANTS: readonly Variant[] = ['a', 'b', 'c'];
const VIEWPORTS: readonly ViewportKey[] = ['phone-landscape', 'desktop', 'phone-portrait'];

/** All nine HUD takes: hud-<a|b|c>-<phone-landscape|desktop|phone-portrait>. */
export const hudVariantShots: readonly Shot[] = VARIANTS.flatMap((v) => VIEWPORTS.map((vk) => hudShot(v, vk)));
