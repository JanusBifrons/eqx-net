/**
 * Holds a naval shell hit's damage visuals until the shell's burst is drawn
 * (time scale stream, docs/streams/time-scale.md).
 *
 * The `damage` event arrives as soon as the server applies the hit, but event
 * shells are drawn at the display tick (`SHELL_DISPLAY_DELAY_MS` behind the
 * server, plus RTT/2), and their burst waits for the display to reach the
 * shell's `shell_end` (`ShellSalvoStore.place`). Firing the hull flash on
 * arrival made it lead the drawn impact (~0.1 s at 1×, ~0.5 s at 0.25×).
 *
 * The damage event names no shell, so it is matched by position:
 *  1. on arrival, a hit whose point lies on the path of a live, not-yet-ended
 *     shell in the store is HELD (`maybeHold`); anything else is not;
 *  2. the `shell_end` (sent in the same server flush, after the damage) names
 *     the hit point exactly: held hits at that point take its hit tick
 *     (`onShellEnd`), splash victims included (their hit point is the burst);
 *  3. each frame, a held hit is released when the display tick reaches its
 *     hit tick, the same frame the burst is pushed (`release`).
 * Safety: an unmatched hit is released `UNMATCHED_HOLD_MS` game ms after it
 * arrived and a matched one after `MAX_HOLD_MS`, so a lost `shell_end` never
 * swallows the flash. Presentation only: HP / shield state is never held.
 *
 * Entries are pooled and mutated in place; no allocation once warm (#14).
 */
import type { ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import { shellPathEndTick, SHELL_TICK_DT_S } from '@core/combat/shellFlight';
import type { DamageEvent } from '@shared-types/messages';

/** Game ms an unmatched held hit waits for its `shell_end` (sent in the same
 *  server flush as the damage, so a few wall ms later at most). */
export const UNMATCHED_HOLD_MS = 300;
/** Game ms a matched hit may wait for the display to reach it (display delay
 *  100 game ms + RTT/2 in game ms; generous so only a stalled display hits it). */
export const MAX_HOLD_MS = 1500;
/** How close (u) the `shell_end` point must be to the damage hit point.
 *  Both are the server's same `bestHitX/Y`, so they are equal up to JSON. */
const END_MATCH_EPS = 0.5;

export interface HeldDamage {
  evt: DamageEvent;
  suppressNumber: boolean;
  /** Server tick of the matched `shell_end`, -1 while unmatched. */
  endTick: number;
  /** Game ms after which it is released whatever happens. */
  deadline: number;
}

export interface HeldDamageSink {
  applyHeldDamage(h: HeldDamage): void;
}

/** Is (hx, hy) on shell `r`'s closed-form path (within its radius)? */
function onShellPath(r: ShellSalvoRenderInfo, hx: number, hy: number): boolean {
  const v2 = r.vx * r.vx + r.vy * r.vy;
  if (v2 <= 0) return false;
  const flightS = (shellPathEndTick(r.t, r.n) - r.t) * SHELL_TICK_DT_S;
  let s = ((hx - r.x0) * r.vx + (hy - r.y0) * r.vy) / v2;
  if (s < 0) s = 0;
  else if (s > flightS) s = flightS;
  const dx = r.x0 + r.vx * s - hx;
  const dy = r.y0 + r.vy * s - hy;
  const tol = 2 * r.wr + 1;
  return dx * dx + dy * dy <= tol * tol;
}

export class NavalHitHold {
  private readonly held: HeldDamage[] = [];
  private count = 0;

  get size(): number { return this.count; }

  /**
   * Hold `evt`'s visuals if its hit point is on a live, unended shell's path
   * in `shells`. Copies the event into a pooled entry. Returns whether held.
   */
  maybeHold(
    evt: DamageEvent, suppressNumber: boolean,
    shells: ReadonlyMap<string, ShellSalvoRenderInfo>, nowGameMs: number,
  ): boolean {
    if (evt.hitX === undefined || evt.hitY === undefined || shells.size === 0) return false;
    let onPath = false;
    for (const r of shells.values()) {
      if (r.endTick < 0 && onShellPath(r, evt.hitX, evt.hitY)) { onPath = true; break; }
    }
    if (!onPath) return false;
    let h = this.held[this.count];
    if (h === undefined) {
      h = {
        evt: {
          type: 'damage', targetId: '', damage: 0, newHealth: 0, shooterId: '',
          newShield: 0, shieldMax: 0, hullMax: 0, hitLayer: 'hull',
        },
        suppressNumber: false, endTick: -1, deadline: 0,
      };
      this.held[this.count] = h;
    }
    this.count++;
    const e = h.evt;
    e.targetId = evt.targetId; e.damage = evt.damage; e.newHealth = evt.newHealth;
    e.shooterId = evt.shooterId; e.hitX = evt.hitX; e.hitY = evt.hitY;
    e.newShield = evt.newShield; e.shieldMax = evt.shieldMax; e.hullMax = evt.hullMax;
    e.hitLayer = evt.hitLayer;
    h.suppressNumber = suppressNumber;
    h.endTick = -1;
    h.deadline = nowGameMs + UNMATCHED_HOLD_MS;
    return true;
  }

  /** A `shell_end` tuple: held hits at (x, y) take its hit tick. */
  onShellEnd(endTick: number, x: number, y: number, nowGameMs: number): void {
    for (let i = 0; i < this.count; i++) {
      const h = this.held[i]!;
      if (h.endTick >= 0) continue;
      if (Math.abs(h.evt.hitX! - x) <= END_MATCH_EPS && Math.abs(h.evt.hitY! - y) <= END_MATCH_EPS) {
        h.endTick = endTick;
        h.deadline = nowGameMs + MAX_HOLD_MS;
      }
    }
  }

  /** Release every held hit whose shell the display has reached, or whose
   *  safety deadline passed. Call after the shells are placed for the frame. */
  release(displayTick: number, nowGameMs: number, sink: HeldDamageSink): void {
    let i = 0;
    while (i < this.count) {
      const h = this.held[i]!;
      if ((h.endTick >= 0 && displayTick >= h.endTick) || nowGameMs >= h.deadline) {
        sink.applyHeldDamage(h);
        // Swap-remove, keeping the entry object pooled at the tail.
        const last = this.count - 1;
        this.held[i] = this.held[last]!;
        this.held[last] = h;
        this.count = last;
        continue;
      }
      i++;
    }
  }

  /** Release everything now (shell events switched off / sector handoff). */
  flush(sink: HeldDamageSink): void {
    this.release(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, sink);
  }

  clear(): void { this.count = 0; }
}
