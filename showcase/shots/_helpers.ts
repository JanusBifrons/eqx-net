/** Small shared helpers for shot files. */
import { SHOWCASE_PILOT_ID } from '../../src/server/rooms/showcaseRooms.js';
import type { ShotContext } from '../types.js';

/** URL params for a combat take where the player must survive the whole shot. */
export const SURVIVE = { initialHull: 1_000_000, startHostile: 1, noselfdmg: 1 } as const;

/** Send a raw room message through the DEV `__eqxClient` (same path as the E2Es). */
export async function sendRoom(ctx: ShotContext, channel: string, msg: Record<string, unknown>): Promise<void> {
  const ok = await ctx.page.evaluate(
    ([c, m]) => {
      const client = (window as unknown as {
        __eqxClient?: { getRoom?: () => { send: (ch: string, x: unknown) => void } | null };
      }).__eqxClient;
      const room = client?.getRoom?.();
      if (!room) return false;
      room.send(c as string, m);
      return true;
    },
    [channel, msg] as const,
  );
  if (!ok) throw new Error(`could not send ${channel}: no live room`);
}

/** Select an entity at a GAME-space point (inspector panel), via the DEV hook. */
export async function selectAt(ctx: ShotContext, x: number, y: number): Promise<void> {
  await ctx.page.evaluate(
    ([gx, gy]) => (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => void }).__eqxSelectAtWorld?.(gx, gy),
    [x, y] as const,
  );
}

/** World (game, Y-up) → screen px for a camera held at (cx, cy) with `zoom`, on the take's viewport. */
export function toScreen(
  x: number,
  y: number,
  cx: number,
  cy: number,
  zoom: number,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return { x: viewport.width / 2 + (x - cx) * zoom, y: viewport.height / 2 - (y - cy) * zoom };
}

/**
 * Join as the showcase pilot (anonymous join, seeded identity) — owns the
 * prebuilt bases in `showcase-base` / `showcase-defence`, so the build preview
 * connects to them and the inspector reads "you".
 */
export const AS_PILOT = {
  auth: false,
  storage: { eqxPlayerId: SHOWCASE_PILOT_ID },
} as const;
