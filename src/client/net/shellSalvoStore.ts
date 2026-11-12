/**
 * Shells as events, client ingest + drawing (docs/architecture/shell-events.md
 * §2, §4, §5). Keeps `mirror.shellSalvos`: for every naval shell the server
 * described in a `shell_salvo` (or the welcome's `shellsInFlight`, or a
 * snapshot `shellKey` keyframe), its salvo id, fire tick, flight length,
 * origin, velocity, owner and gun, keyed by the same id as its
 * `mirror.projectiles` entry.
 *
 * - Slice 2a reads it for the incoming-fire countdown.
 * - Slice 2b draws from it: `place()` puts each live shell into
 *   `mirror.projectiles` at `shellPoseAt(displayTick)` (flagged `event`), so
 *   it flies on the same display timeline as the ships it is aimed at. A
 *   `shell_end` only MARKS a shell; `place()` bursts it (`bursts` queue) and
 *   removes it when the display tick reaches the hit, so the explosion is where
 *   the drawn shell is. A miss is removed silently at `shellPathEndTick`.
 *
 * Records and projectile entries are pooled and mutated in place (#14).
 */
import type { ProjectileRenderState, ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import { shellPathEndTick, SHELL_TICK_DT_S } from '@core/combat/shellFlight';
import type { ShellEnd, ShellKeyRecord, ShellSalvo } from '@shared-types/messages/shellEvents';
import { getWeapon, isWeaponId } from '@core/combat/WeaponCatalogue';

/** A shell's own radius when its gun is unknown (a burst still shows). */
const DEFAULT_SHELL_RADIUS = 3;

function shellRadiusOf(w: string): number {
  const def = isWeaponId(w) ? getWeapon(w) : null;
  return def && def.mode !== 'hitscan' ? def.radius : DEFAULT_SHELL_RADIUS;
}

export class ShellSalvoStore {
  readonly map = new Map<string, ShellSalvoRenderInfo>();
  private readonly free: ShellSalvoRenderInfo[] = [];

  private put(
    id: string, s: number, t: number, n: number,
    x0: number, y0: number, vx: number, vy: number, o: string, w: string,
  ): void {
    let r = this.map.get(id);
    if (r === undefined) {
      r = this.free.pop() ?? { s: 0, t: 0, n: 1, x0: 0, y0: 0, wr: 0, vx: 0, vy: 0, o: '', w: '', endTick: -1, ex: 0, ey: 0 };
      this.map.set(id, r);
      r.endTick = -1;
    }
    r.s = s; r.t = t; r.n = n; r.x0 = x0; r.y0 = y0;
    r.vx = vx; r.vy = vy; r.o = o; r.w = w;
    r.wr = shellRadiusOf(w);
  }

  /** A `shell_salvo` (or one entry of the welcome's `shellsInFlight`). */
  applySalvo(msg: ShellSalvo): void {
    for (const sh of msg.sh) this.put(sh[0], msg.s, msg.t, msg.n, sh[1], sh[2], sh[3], sh[4], msg.o, msg.w);
  }

  /** A snapshot keyframe: adopt shells we don't know; ignore known ones. */
  applyKeyframe(recs: readonly ShellKeyRecord[] | undefined): void {
    if (!recs) return;
    for (const r of recs) if (!this.map.has(r[0])) this.put(r[0], r[1], r[4], r[5], r[6], r[7], r[8], r[9], r[2], r[3]);
  }

  /**
   * A `shell_end`: those shells hit something at `tick`, at (x, y). The shell
   * keeps flying on screen until the display clock reaches the hit
   * (`place`). An end for a shell we never saw bursts at once.
   */
  applyEnd(msg: ShellEnd, bursts?: number[]): void {
    for (const e of msg.e) {
      const r = this.map.get(e[0]);
      if (r === undefined) {
        if (bursts) bursts.push(e[2], e[3], DEFAULT_SHELL_RADIUS);
        continue;
      }
      r.endTick = e[1]; r.ex = e[2]; r.ey = e[3];
    }
  }

  /**
   * One frame (slice 2b): draw every live shell at `displayTick` (fractional
   * server ticks) into `projectiles` as an `event` entry; burst and remove
   * shells whose hit the display has reached; remove misses past their path;
   * remove `event` entries we no longer hold. Alloc-free once warm.
   */
  place(projectiles: Map<string, ProjectileRenderState>, displayTick: number, bursts: number[]): void {
    for (const [id, r] of this.map) {
      const hit = r.endTick >= 0 && displayTick >= r.endTick;
      if (hit || displayTick > shellPathEndTick(r.t, r.n)) {
        if (hit) bursts.push(r.ex, r.ey, r.wr);
        if (projectiles.get(id)?.event === true) projectiles.delete(id);
        this.drop(id);
        continue;
      }
      if (displayTick < r.t) continue; // fired, but not yet on the display clock
      const dt = (displayTick - r.t) * SHELL_TICK_DT_S;
      let p = projectiles.get(id);
      if (p === undefined) {
        p = { x: 0, y: 0, vx: 0, vy: 0, ownerId: '', weaponId: '' };
        projectiles.set(id, p);
      }
      p.x = r.x0 + r.vx * dt;
      p.y = r.y0 + r.vy * dt;
      p.vx = r.vx; p.vy = r.vy;
      // How far it has flown: the drawn streak trails the shell and is never
      // longer than this (FxProjectiles.draw).
      p.flown = Math.sqrt(r.vx * r.vx + r.vy * r.vy) * dt;
      p.ownerId = r.o; p.weaponId = r.w;
      p.isGhost = false;
      p.event = true;
    }
    for (const [id, p] of projectiles) if (p.event === true && !this.map.has(id)) projectiles.delete(id);
  }

  /** Forget shells past their path by `tick` (backstop when no frames run). */
  sweep(tick: number): void {
    for (const [id, r] of this.map) if (tick > shellPathEndTick(r.t, r.n)) this.drop(id);
  }

  private drop(id: string): void {
    const r = this.map.get(id);
    if (r === undefined) return;
    this.map.delete(id);
    this.free.push(r);
  }

  /** Sector handoff / dispose. */
  clear(): void {
    for (const r of this.map.values()) this.free.push(r);
    this.map.clear();
  }
}
