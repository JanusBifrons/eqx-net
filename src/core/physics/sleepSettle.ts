/**
 * Settle-to-sleep pass of `PhysicsWorld` (World.ts, `setSleepSettle`): the
 * per-body sleep threshold Rapier's JS API lacks. Moved verbatim out of
 * World.ts (god-file split); `PhysicsWorld.tick` calls `step()` after every
 * fixed step, as it does `CapitalOverlapResolver.resolve()`. One instance per
 * world, so per-sector state never sits at module scope.
 */
import type RAPIER from '@dimforge/rapier2d-compat';

/** Fixed steps a settle body (`setSleepSettle`) must stay under its
 *  thresholds before it is put to sleep: half a second (Rapier's own timer
 *  is 2 s, at a 0.4 u/s threshold). */
export const WRECK_SETTLE_STEPS = 30;

export class SleepSettler {
  private readonly settle = new Map<string, { body: RAPIER.RigidBody; speed2: number; spin: number; count: number }>();

  get size(): number {
    return this.settle.size;
  }

  delete(id: string): void {
    this.settle.delete(id);
  }

  /**
   * Behind `PhysicsWorld.setSleepSettle` (World.ts).
   *
   * Settle-to-sleep (wreck sleep fix, 2026-11-13): once body `id` has moved
   * slower than `speed` (u/s) and spun slower than `spin` (rad/s) for
   * `WRECK_SETTLE_STEPS` fixed steps in a row, it is put to sleep, instead of
   * drifting on down to Rapier's global 0.4 u/s threshold (which must stay:
   * a `lengthUnit` change would move every body's). Rapier's JS API has no
   * per-body sleep thresholds, so this is the per-body one. A sleeping body
   * still wakes on a contact or impulse like any other. Deterministic (pure
   * function of the body's state per step), so the server worker and the
   * client predWorld twin run the same rule from `wreckBodyParams` (#15).
   * `speed <= 0` removes it. Unknown id ⇒ no-op.
   */
  set(id: string, body: RAPIER.RigidBody, speed: number, spin: number): void {
    if (!(speed > 0)) { this.settle.delete(id); return; }
    const s = this.settle.get(id);
    if (s) { s.speed2 = speed * speed; s.spin = spin; s.count = 0; return; }
    this.settle.set(id, { body, speed2: speed * speed, spin, count: 0 });
  }

  /** One settle pass after a fixed step (alloc-free apart from Rapier's own
   *  `linvel()` getter, as in `getAllShipStates`). */
  step(): void {
    for (const s of this.settle.values()) {
      const b = s.body;
      if (b.isSleeping()) { s.count = 0; continue; }
      const v = b.linvel();
      if (v.x * v.x + v.y * v.y < s.speed2 && Math.abs(b.angvel()) < s.spin) {
        if (++s.count >= WRECK_SETTLE_STEPS) { b.sleep(); s.count = 0; }
      } else {
        s.count = 0;
      }
    }
  }
}
