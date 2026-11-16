/**
 * A capital wreck's separating kicks, held for the crack delay
 * (`WRECK_CRACK_MS`) and then posted, all of one tick's in ONE worker
 * message so a wreck's pieces part on the same physics step. Split out of
 * `CapitalWreckSubsystem` (which owns one); story in
 * docs/architecture/capital-destruction.md "How pieces reach the worker".
 */
import type { CapitalWreckDeps } from './capitalWreckTypes.js';

/** A piece's separating kick, held until the wreck's crack delay ends. */
interface PendingKick {
  id: string;
  dueTick: number;
  /** Kick in the world frame at the death angle. */
  vx: number;
  vy: number;
  w: number;
  angle0: number;
}

export class WreckKickQueue {
  /** Kicks waiting for their tick (oldest first; compacted in place). */
  private readonly kicks: PendingKick[] = [];

  constructor(private readonly d: CapitalWreckDeps) {}

  /** Hold piece `id`'s kick (world frame at death angle `angle0`) until `dueTick`. */
  push(id: string, dueTick: number, vx: number, vy: number, w: number, angle0: number): void {
    this.kicks.push({ id, dueTick, vx, vy, w, angle0 });
  }

  /** Kicks still held. */
  get length(): number {
    return this.kicks.length;
  }

  /**
   * Per server tick: give each piece whose wreck's crack delay is over its
   * separating kick. The kick was built at the death angle; the piece has
   * turned with the hull since, so it is turned by the same amount. Kicks for
   * pieces already gone are dropped. The tick's kicks go in ONE worker
   * message (`beginBatch`). Alloc-free (#14): compacts in place.
   */
  tick(): void {
    if (this.kicks.length === 0) return;
    this.d.beginBatch?.();
    try {
      this.kickDue(this.d.serverTick());
    } finally {
      this.d.endBatch?.();
    }
  }

  private kickDue(now: number): void {
    const k = this.kicks;
    let w = 0;
    for (let r = 0; r < k.length; r++) {
      const e = k[r]!;
      if (e.dueTick > now) {
        k[w++] = e;
        continue;
      }
      const angle = this.d.pieceAngle(e.id);
      if (angle === null) continue;
      const da = angle - e.angle0;
      const c = Math.cos(da);
      const s = Math.sin(da);
      this.d.kickPiece(e.id, e.vx * c - e.vy * s, e.vx * s + e.vy * c, e.w);
    }
    k.length = w;
  }
}
