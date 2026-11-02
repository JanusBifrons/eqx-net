/**
 * Fly the local ship like a player would: steer toward a point with the arrow
 * keys, thrust while facing it, brake on arrival. Shots built on this are
 * filmed from one piloted ship's point of view (camera tracking `local`).
 * Mirrors tests/showcase/helpers.ts `flyTo`.
 */
import type { ShotContext } from '../types.js';

export interface Pose {
  x: number;
  y: number;
  angle: number;
}

export async function localPose(ctx: ShotContext): Promise<Pose | null> {
  return ctx.page.evaluate(() => {
    const c = (window as unknown as {
      __eqxClient?: { mirror?: { localPlayerId?: string | null; ships?: Map<string, Pose> } };
    }).__eqxClient;
    const id = c?.mirror?.localPlayerId;
    const s = id ? c?.mirror?.ships?.get(id) : undefined;
    return s ? { x: s.x, y: s.y, angle: s.angle } : null;
  });
}

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

export interface FlyOpts {
  /** Stop within this distance (default 150). */
  arrive?: number;
  /** Give up after this long (default 8 s). */
  maxMs?: number;
  /** Cruise speed cap in u/s (default: scales with distance, min 120). */
  cruise?: number;
  /** Hold boost on long straight legs. */
  boost?: boolean;
  /** Pass through without braking (for a waypoint in a route). */
  passThrough?: boolean;
}

/** Steer to (tx, ty). Resolves true on arrival. Releases every key it held. */
export async function flyTo(ctx: ShotContext, tx: number, ty: number, o: FlyOpts = {}): Promise<boolean> {
  const { page } = ctx;
  const arrive = o.arrive ?? 150;
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) {
      await page.keyboard.down(key);
      held.add(key);
    }
    if (!on && held.has(key)) {
      await page.keyboard.up(key);
      held.delete(key);
    }
  };
  const end = Date.now() + (o.maxMs ?? 8000);
  let arrived = false;
  let prev: { x: number; y: number; t: number } | null = null;
  while (Date.now() < end) {
    const p = await localPose(ctx);
    if (p) {
      const now = Date.now();
      const speed = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(0.001, (now - prev.t) / 1000) : 0;
      prev = { x: p.x, y: p.y, t: now };
      const dx = tx - p.x;
      const dy = ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < arrive && (o.passThrough || speed < 150)) {
        arrived = true;
        break;
      }
      const diff = wrapPi(Math.atan2(-dx, dy) - p.angle);
      await set('ArrowLeft', diff > 0.08);
      await set('ArrowRight', diff < -0.08);
      const cruise = o.cruise ?? Math.max(120, dist * 0.8);
      const facing = Math.abs(diff) < 0.6;
      await set('ArrowUp', facing && speed < cruise);
      await set('ShiftLeft', !!o.boost && facing && Math.abs(diff) < 0.2 && dist > 500 && speed < cruise);
      await set('ArrowDown', !o.passThrough && facing && speed > cruise * 1.3 && dist < 600);
    }
    await ctx.sleep(50);
  }
  for (const k of [...held]) await set(k, false);
  return arrived;
}

/** Fly a route; every point but the last is passed through without braking. */
export async function flyRoute(ctx: ShotContext, points: ReadonlyArray<[number, number]>, o: FlyOpts = {}): Promise<void> {
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]!;
    const last = i === points.length - 1;
    await flyTo(ctx, x, y, { ...o, passThrough: !last, arrive: last ? o.arrive : 220 });
  }
}

/** Turn (no thrust) to face (tx, ty) for up to `ms`. */
export async function face(ctx: ShotContext, tx: number, ty: number, ms = 400): Promise<void> {
  const end = Date.now() + ms;
  let key: string | null = null;
  while (Date.now() < end) {
    const p = await localPose(ctx);
    if (!p) break;
    const diff = wrapPi(Math.atan2(-(tx - p.x), ty - p.y) - p.angle);
    const want = diff > 0.06 ? 'ArrowLeft' : diff < -0.06 ? 'ArrowRight' : null;
    if (want !== key) {
      if (key) await ctx.page.keyboard.up(key);
      if (want) await ctx.page.keyboard.down(want);
      key = want;
    }
    await ctx.sleep(40);
  }
  if (key) await ctx.page.keyboard.up(key);
}
