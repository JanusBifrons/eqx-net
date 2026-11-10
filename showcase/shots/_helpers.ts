/** Small shared helpers for shot files. */
import { SHOWCASE_PILOT_ID } from '../../src/server/rooms/showcaseRooms.js';
import type { ShotContext } from '../types.js';

/**
 * URL params for a combat take where the player must survive the whole shot.
 * Lock-to-fire (2026-11-09): weapons fire only at a completed lock, so
 * `instantLock` makes the AUTO groups lock what's in front within ~0.1 s and
 * fire on their own, as the legacy auto-fire did. AUTO still picks only
 * HOSTILE targets (`startHostile` makes the drones hostile); it never fires
 * on a neutral structure (that would need the testMode `anyTarget`).
 */
export const SURVIVE = { initialHull: 1_000_000, startHostile: 1, noselfdmg: 1, instantLock: 1 } as const;

/**
 * Put every weapon group in MAN, so nothing self-picks (pair with
 * `instantLock` in a take where the pilot opens fire ON CUE, not on sight).
 */
export async function allGroupsManual(ctx: ShotContext): Promise<void> {
  await ctx.page.waitForFunction(() => {
    const w = window as unknown as {
      __eqxStore?: { getState(): { fcGroups: ReadonlyArray<{ id: string; mode?: string }> } };
      __eqxClient?: { setGroupMode?: (id: string, mode: 'auto' | 'manual') => void };
    };
    const groups = w.__eqxStore?.getState().fcGroups ?? [];
    if (groups.length === 0 || !w.__eqxClient?.setGroupMode) return false;
    for (const g of groups) w.__eqxClient.setGroupMode(g.id, 'manual');
    return true;
  }, undefined, { timeout: 20_000 });
}

/**
 * Lock the lockable target (NPC drone, or a structure that isn't ours) most
 * nearly ahead of the pilot with the ACTIVE group — selection + the LOCK
 * action, the same as the info box's LOCK button — and wait (≤ 3 s) for it to
 * complete (instant under `instantLock`). Then a held Space fires at it.
 */
export async function lockAhead(ctx: ShotContext): Promise<void> {
  await ctx.page.evaluate(() => {
    const w = window as unknown as {
      __eqxStore?: { getState(): { setSelectedEntity(id: string | null, kind: string | null): void } };
      __eqxClient?: {
        lockSelected?: () => boolean;
        mirror?: {
          localPlayerId: string | null;
          ships: Map<string, { x: number; y: number; angle: number }>;
          swarm: Map<number, { kind: number; x: number; y: number }>;
          structures?: Map<number, { owner?: string }>;
        };
      };
    };
    const c = w.__eqxClient;
    const m = c?.mirror;
    const me = m?.localPlayerId ? m.ships.get(m.localPlayerId) : undefined;
    if (!c || !m || !me) return;
    const fx = -Math.sin(me.angle), fy = Math.cos(me.angle);
    let best: number | null = null, bestKind = 'drone', bestScore = Infinity;
    for (const [eid, e] of m.swarm) {
      if (e.kind !== 1 && e.kind !== 2) continue;
      if (e.kind === 2 && m.structures?.get(eid)?.owner === m.localPlayerId) continue;
      const dx = e.x - me.x, dy = e.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      const off = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dy * fy) / d)));
      const score = d * (1 + 4 * off); // nearest, strongly preferring what's ahead
      if (score < bestScore) { bestScore = score; best = eid; bestKind = e.kind === 1 ? 'drone' : 'structure'; }
    }
    if (best === null) return;
    w.__eqxStore?.getState().setSelectedEntity(`swarm-${best}`, bestKind);
    c.lockSelected?.();
  });
  await ctx.page
    .waitForFunction(() => {
      const w = window as unknown as {
        __eqxStore?: { getState(): { activeGroupId: string | null; fcGroups: ReadonlyArray<{ id: string; locks: ReadonlyArray<{ stage: number }> }> } };
      };
      const st = w.__eqxStore?.getState();
      const g = st?.fcGroups.find((x) => x.id === st.activeGroupId);
      return g?.locks.some((l) => l.stage === 2) ?? false;
    }, undefined, { timeout: 3000 })
    .catch(() => undefined); // out of reach: the take goes on (Space then fires nothing)
}

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
