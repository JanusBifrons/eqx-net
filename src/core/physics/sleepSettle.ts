import type RAPIER from '@dimforge/rapier2d-compat';

/** Fixed steps a settle body (`setSleepSettle`) must stay under its
 *  thresholds before it is put to sleep: half a second (Rapier's own timer
 *  is 2 s, at a 0.4 u/s threshold). */
export const WRECK_SETTLE_STEPS = 30;

/** The settle-to-sleep bodies of one `PhysicsWorld` (its `settle`; the rule
 *  is documented on `PhysicsWorld.setSleepSettle`), stepped after every fixed
 *  step. */
export class SleepSettle {
  private readonly settle = new Map<string, { body: RAPIER.RigidBody; speed2: number; spin: number; count: number }>();

  get size(): number { return this.settle.size; }

  delete(id: string): void { this.settle.delete(id); }

  /** Register or update body `id`'s thresholds; `speed <= 0` removes it. */
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
