/**
 * Shells as events, client ingest (docs/architecture/shell-events.md §2, §5).
 * Keeps `mirror.shellSalvos`: for every naval shell the server described in a
 * `shell_salvo` (or the welcome's `shellsInFlight`, or a snapshot `shellKey`
 * keyframe), its salvo id, fire tick, flight length and origin, keyed by the
 * same id as its `mirror.projectiles` entry.
 *
 * Slice 2a reads it for the incoming-fire countdown (one marker per salvo, a
 * countdown that never goes up). Slice 2b will draw shells from it.
 *
 * Records are pooled and mutated in place (#14); a shell leaves the store on
 * its `shell_end`, or once the server tick passes the end of its path.
 */
import type { ShellSalvoRenderInfo } from '@core/contracts/IRenderer';
import { shellPathEndTick } from '@core/combat/shellFlight';
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

  private put(id: string, s: number, t: number, n: number, x0: number, y0: number, w: string): void {
    let r = this.map.get(id);
    if (r === undefined) {
      r = this.free.pop() ?? { s: 0, t: 0, n: 1, x0: 0, y0: 0, wr: 0 };
      this.map.set(id, r);
    }
    r.s = s; r.t = t; r.n = n; r.x0 = x0; r.y0 = y0;
    r.wr = shellRadiusOf(w);
  }

  /** A `shell_salvo` (or one entry of the welcome's `shellsInFlight`). */
  applySalvo(msg: ShellSalvo): void {
    for (const sh of msg.sh) this.put(sh[0], msg.s, msg.t, msg.n, sh[1], sh[2], msg.w);
  }

  /** A snapshot keyframe: adopt shells we don't know; ignore known ones. */
  applyKeyframe(recs: readonly ShellKeyRecord[] | undefined): void {
    if (!recs) return;
    for (const r of recs) if (!this.map.has(r[0])) this.put(r[0], r[1], r[4], r[5], r[6], r[7], r[3]);
  }

  /**
   * A `shell_end`: those shells hit something. With `bursts`, each hit is
   * queued as `[x, y, shellRadius]` (game space) for the renderer's impact
   * burst (`mirror.pendingShellEnds`, slice 2b); the only burst a shell gets
   * when events are on.
   */
  applyEnd(msg: ShellEnd, bursts?: number[]): void {
    for (const e of msg.e) {
      if (bursts) bursts.push(e[2], e[3], this.map.get(e[0])?.wr ?? DEFAULT_SHELL_RADIUS);
      this.drop(e[0]);
    }
  }

  /** Forget shells whose path has ended by `serverTick` (misses send nothing). */
  sweep(serverTick: number): void {
    for (const [id, r] of this.map) if (serverTick > shellPathEndTick(r.t, r.n)) this.drop(id);
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
