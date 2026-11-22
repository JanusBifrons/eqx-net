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
 * arrived and a matched one after `matchedHoldMs` (`MAX_HOLD_MS` piloting,
 * `OFF_PILOT_MAX_HOLD_MS` off pilot, where the display delay may grow to
 * `OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS`), so a lost `shell_end` never
 * swallows the flash and a slow drawn shell is never overtaken by its hit.
 * Presentation only: HP / shield state is never held.
 *
 * Stamped hits (off-pilot event timing, slice 1/6): a hit on a target drawn on
 * the DRONE timeline (drones, scrap, missiles: drawn up to
 * `OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS` in the past) has no shell to wait
 * for. `holdStamped` holds it with a stamp: the newest snapshot tick at
 * arrival (the event carries no tick), placed on the drone tick clock
 * (`swarmTickToStampMs`). `release` frees it once the drones' read point
 * (`swarmReadPointMs`: now − the held display delay, the time every drone
 * read targets) reaches that stamp, or at its deadline: the current delay plus
 * `STAMPED_HOLD_MARGIN_MS`, capped by `matchedHoldMs`. Shell matching
 * (`onShellEnd`, `releaseHitAt`) never touches a stamped entry.
 *
 * Entries are pooled and mutated in place; no allocation once warm (#14).
 */
import type { ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import { shellPathEndTick, SHELL_TICK_DT_S } from '@core/combat/shellFlight';
import type { DamageEvent } from '@shared-types/messages';
import { MAX_TOTAL_DISPLAY_DELAY_MS, OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS } from './swarmDelaySizing.js';
import { getSwarmDisplayDelayMs, getSwarmDisplaySpeed, swarmTickToStampMs } from './swarmInterpolation.js';

/** Game ms an unmatched held hit waits for its `shell_end` (sent in the same
 *  server flush as the damage, so a few wall ms later at most). */
export const UNMATCHED_HOLD_MS = 300;
/** Game ms a matched hit may wait for the display to reach it (display delay
 *  100 game ms + RTT/2 in game ms; generous so only a stalled display hits it). */
export const MAX_HOLD_MS = 1500;
/** Game ms a matched hit may wait OFF PILOT (Command, Build, spectate, or the
 *  catch-up after it), where shells are drawn on a display delay of up to
 *  OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS game ms (pilot: MAX_TOTAL_DISPLAY_DELAY_MS).
 *  The same headroom over the largest delay as `MAX_HOLD_MS` has piloting
 *  (1500 + 4000 − 400 = 5100). Game ms like the delay maxima, so it holds at
 *  any speed. */
export const OFF_PILOT_MAX_HOLD_MS =
  MAX_HOLD_MS + OFF_PILOT_MAX_TOTAL_DISPLAY_DELAY_MS - MAX_TOTAL_DISPLAY_DELAY_MS;

/** The matched-hit (and held-death) deadline, game ms: `MAX_HOLD_MS` while
 *  the display delay is on its pilot bounds, else `OFF_PILOT_MAX_HOLD_MS`. */
export function matchedHoldMs(offPilot: boolean): number {
  return offPilot ? OFF_PILOT_MAX_HOLD_MS : MAX_HOLD_MS;
}
/** Game ms a stamped hit may wait past the current drone display delay: the
 *  headroom `MAX_HOLD_MS` has over the largest pilot delay (1500 − 400). */
export const STAMPED_HOLD_MARGIN_MS = MAX_HOLD_MS - MAX_TOTAL_DISPLAY_DELAY_MS;

/** The drones' read point at wall `nowMs` (`swarmArrivalStampMs` units): the
 *  time every drone read targets (`interpolateSwarmPose`: now − the held
 *  display delay). A stamped hit is drawn once this reaches its stamp.
 *  Read-only. */
export function swarmReadPointMs(nowMs: number): number {
  return nowMs - getSwarmDisplayDelayMs();
}

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
  /** Stamped hits (`holdStamped`): the newest snapshot tick at arrival, else -1. */
  stampTick: number;
  /** That tick's stamp on the drone tick clock (wall ms), else NaN. */
  stampMs: number;
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
    this.push(evt, suppressNumber, nowGameMs + UNMATCHED_HOLD_MS);
    return true;
  }

  /**
   * Hold `evt`'s visuals until the drones' read point reaches server tick
   * `stampTick` (the newest snapshot tick at arrival, e.g. `anchorTick()`).
   * `nowWallMs` is on the drone pose clock, `nowGameMs` on the game clock;
   * `offPilot` as for `onShellEnd`. Not held (returns false) before the
   * drone tick clock is seeded: there is no drone timeline to wait for.
   */
  holdStamped(
    evt: DamageEvent, suppressNumber: boolean, stampTick: number,
    nowWallMs: number, nowGameMs: number, offPilot = false,
  ): boolean {
    const stampMs = swarmTickToStampMs(stampTick, nowWallMs);
    if (Number.isNaN(stampMs)) return false;
    const delayGameMs = getSwarmDisplayDelayMs() * getSwarmDisplaySpeed();
    const h = this.push(evt, suppressNumber,
      nowGameMs + Math.min(delayGameMs + STAMPED_HOLD_MARGIN_MS, matchedHoldMs(offPilot)));
    h.stampTick = stampTick;
    h.stampMs = stampMs;
    return true;
  }

  /** Copy `evt` into a pooled entry (unmatched, unstamped). */
  private push(evt: DamageEvent, suppressNumber: boolean, deadline: number): HeldDamage {
    let h = this.held[this.count];
    if (h === undefined) {
      h = {
        evt: {
          type: 'damage', targetId: '', damage: 0, newHealth: 0, shooterId: '',
          newShield: 0, shieldMax: 0, hullMax: 0, hitLayer: 'hull',
        },
        suppressNumber: false, endTick: -1, deadline: 0, stampTick: -1, stampMs: Number.NaN,
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
    h.deadline = deadline;
    h.stampTick = -1;
    h.stampMs = Number.NaN;
    return h;
  }

  /** A `shell_end` tuple: held hits at (x, y) take its hit tick. `offPilot`:
   *  the display delay is on its off-pilot bounds (`matchedHoldMs`). */
  onShellEnd(endTick: number, x: number, y: number, nowGameMs: number, offPilot = false): void {
    for (let i = 0; i < this.count; i++) {
      const h = this.held[i]!;
      if (h.endTick >= 0 || h.stampTick >= 0) continue;
      if (Math.abs(h.evt.hitX! - x) <= END_MATCH_EPS && Math.abs(h.evt.hitY! - y) <= END_MATCH_EPS) {
        h.endTick = endTick;
        h.deadline = nowGameMs + matchedHoldMs(offPilot);
      }
    }
  }

  /** Release every held hit whose shell the display has reached, whose stamp
   *  the drones' read point `readPointMs` (`swarmReadPointMs`; NaN: none this
   *  frame) has reached, or whose safety deadline passed. Call after the
   *  shells are placed for the frame. */
  release(displayTick: number, nowGameMs: number, sink: HeldDamageSink, readPointMs = Number.NaN): void {
    let i = 0;
    while (i < this.count) {
      const h = this.held[i]!;
      if ((h.endTick >= 0 && displayTick >= h.endTick) || readPointMs >= h.stampMs
        || nowGameMs >= h.deadline) {
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
    this.release(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, sink, Number.POSITIVE_INFINITY);
  }

  /** Is `targetId`'s KILLING hit (hull to 0) still held for its drawn shell?
   *  Only then does its death wait (`ColyseusClient` deferred kills): other
   *  shells still in flight to it did not kill it (heavy-beam take 8). */
  holdsKill(targetId: string): boolean {
    for (let i = 0; i < this.count; i++) {
      const e = this.held[i]!.evt;
      if (e.targetId === targetId && e.newHealth <= 0) return true;
    }
    return false;
  }

  /**
   * A beam (`laser_fired`) hit `targetId` at (x, y): a hit still held there
   * unmatched was matched by position to a shell it did not come from (the
   * beam's point lay on a live shell's path). Release it now: a hitscan hit
   * shows on arrival. Returns whether one was released.
   */
  releaseHitAt(targetId: string, x: number, y: number, sink: HeldDamageSink): boolean {
    let released = false;
    let i = 0;
    while (i < this.count) {
      const h = this.held[i]!;
      if (h.endTick < 0 && h.stampTick < 0 && h.evt.targetId === targetId
        && Math.abs(h.evt.hitX! - x) <= END_MATCH_EPS && Math.abs(h.evt.hitY! - y) <= END_MATCH_EPS) {
        sink.applyHeldDamage(h);
        const last = this.count - 1;
        this.held[i] = this.held[last]!;
        this.held[last] = h;
        this.count = last;
        released = true;
        continue;
      }
      i++;
    }
    return released;
  }

  /** Release every hit held for `targetId` now: the target was destroyed,
   *  and its explosion is not held, so a later release would put the number
   *  over the wreck after the blast (fight-clip review 2026-11-13). */
  flushTarget(targetId: string, sink: HeldDamageSink): void {
    let i = 0;
    while (i < this.count) {
      const h = this.held[i]!;
      if (h.evt.targetId === targetId) {
        sink.applyHeldDamage(h);
        const last = this.count - 1;
        this.held[i] = this.held[last]!;
        this.held[last] = h;
        this.count = last;
        continue;
      }
      i++;
    }
  }

  clear(): void { this.count = 0; }
}
