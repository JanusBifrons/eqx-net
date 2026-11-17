/**
 * Loot window search time, per (viewer, container) (plan cargo-pods slice
 * 12). Server-owned: the client only ever receives what `searchView` reveals.
 *
 * Driven by the cargo request path, never a tick: each in-reach query credits
 * the game time since the last one, capped at `MAX_GAP_MS` so time spent with
 * the window shut or out of reach never counts. An out-of-reach query pauses
 * the search; it resumes where it stopped.
 */

/** Longest gap between in-reach queries that still counts as searching (the
 *  open window re-asks at each reveal, ≤ 2 s apart). */
export const MAX_GAP_MS = 2500;
/** Forget searches idle this long (game ms). */
const IDLE_FORGET_MS = 120_000;
const SWEEP_ABOVE = 256;

interface Entry { elapsed: number; lastAt: number; running: boolean }

export class LootSearch {
  private readonly entries = new Map<string, Entry>();

  /** Search time so far for `viewer` on `container` at game time `now`. */
  advance(viewer: string, container: string, now: number, inReach: boolean): number {
    const key = viewer + '|' + container;
    let e = this.entries.get(key);
    if (e === undefined) {
      if (!inReach) return 0;
      if (this.entries.size >= SWEEP_ABOVE) this.sweep(now);
      e = { elapsed: 0, lastAt: now, running: true };
      this.entries.set(key, e);
      return 0;
    }
    if (inReach && e.running) e.elapsed += Math.min(Math.max(0, now - e.lastAt), MAX_GAP_MS);
    e.running = inReach;
    e.lastAt = now;
    return e.elapsed;
  }

  /** Drop every search on `container` (it left the world). */
  forgetContainer(container: string): void {
    const tail = '|' + container;
    for (const k of this.entries.keys()) if (k.endsWith(tail)) this.entries.delete(k);
  }

  size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [k, e] of this.entries) if (now - e.lastAt > IDLE_FORGET_MS) this.entries.delete(k);
  }
}
