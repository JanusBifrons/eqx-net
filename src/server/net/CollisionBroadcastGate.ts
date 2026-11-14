/**
 * Which ship contacts go out as `collision_resolved` this tick.
 *
 * Rapier reports a contact-force event EVERY step a contact lasts, so two
 * ships grinding or pressing into each other produce one aggregated pair per
 * tick: 60 messages a second per pair, every one broadcast to every client.
 * The client keeps very few of them, and it counts per BODY, not per pair:
 * `pushCollisionShieldContacts` draws at most one shield contact per shield
 * per 150 ms and `applyCollisionResolved` applies at most 4 per ship per
 * second. The rest are bytes on the wire that the client throws away.
 *
 * The worker's force floor (`CONTACT_FORCE_FLOOR`) was meant to drop those
 * grinding contacts, but a force floor stops working once ships push harder:
 * a ship pressing into another pushes with its own thrust, and the arcade
 * handling (2026-11-13) multiplied thrust by 16–18. Fleet-fight pilots then
 * received ~3,000 contact messages a second (533 KB/s), 99 % of them ships of
 * one side bumped together with a closing speed under 10 u/s.
 *
 * So this gate keys on what the client can use, not how hard a ship pushes:
 *   - an impact (normal closing speed >= `RAM_MIN_IMPACT_SPEED`, the speed
 *     that can deal ram damage) always goes out;
 *   - any other contact goes out when either body has had no contact sent for
 *     `COLLISION_RESEND_TICKS` (150 ms, the client's shield-contact spacing),
 *     so a body's first touch goes out at once and a grinding shield still
 *     shows at the rate the client draws it.
 *
 * Only the BROADCAST is gated. Ramming damage and the bus event still see
 * every contact every tick.
 */
import { RAM_MIN_IMPACT_SPEED } from '../../core/combat/Ramming.js';

/** 150 ms at 60 Hz: the client's `SHIELD_CONTACT_MIN_MS`. */
export const COLLISION_RESEND_TICKS = 9;

/** Forget bodies with no contact sent for this long (bounded memory). */
const FORGET_AFTER_TICKS = 120;

export class CollisionBroadcastGate {
  /** Body id -> tick a contact naming it was last sent. */
  private readonly lastSent = new Map<string, number>();
  private lastSweepTick = 0;

  /** True when this tick's contact between `aId` and `bId` should be broadcast. */
  shouldSend(aId: string, bId: string, normalSpeed: number, tick: number): boolean {
    const send = normalSpeed >= RAM_MIN_IMPACT_SPEED || this.stale(aId, tick) || this.stale(bId, tick);
    if (send) {
      this.lastSent.set(aId, tick);
      this.lastSent.set(bId, tick);
    }
    return send;
  }

  private stale(id: string, tick: number): boolean {
    const last = this.lastSent.get(id);
    // tick < last: the tick went backwards (worker restart), start over.
    return last === undefined || tick - last >= COLLISION_RESEND_TICKS || tick < last;
  }

  /** Drop bodies with nothing sent for a while. Call once per contact batch
   *  (cheap: it sweeps only every `FORGET_AFTER_TICKS`). */
  sweep(tick: number): void {
    if (tick - this.lastSweepTick < FORGET_AFTER_TICKS) return;
    this.lastSweepTick = tick;
    this.lastSent.forEach(this.forgetStale);
  }

  private readonly forgetStale = (t: number, id: string): void => {
    if (this.lastSweepTick - t >= FORGET_AFTER_TICKS) this.lastSent.delete(id);
  };

  /** Bodies currently remembered (tests). */
  size(): number {
    return this.lastSent.size;
  }
}
