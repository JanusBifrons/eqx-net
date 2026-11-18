/**
 * Settle-to-sleep (wreck sleep fix, 2026-11-13), split out of World.ts
 * (god-file cap): `PhysicsWorld.setSleepSettle` registers a body here and
 * `PhysicsWorld.tick` calls `step()` after every fixed step. Once a body has
 * moved slower than its `speed` (u/s) and spun slower than its `spin` (rad/s)
 * for `WRECK_SETTLE_STEPS` fixed steps in a row, it is put to sleep, instead
 * of drifting on down to Rapier's global 0.4 u/s threshold (which must stay:
 * a `lengthUnit` change would move every body's). Rapier's JS API has no
 * per-body sleep thresholds, so this is the per-body one. A sleeping body
 * still wakes on a contact or impulse like any other. Deterministic (pure
 * function of the body's state per step), so the server worker and the
 * client predWorld twin run the same rule from `wreckBodyParams` (#15).
 * A body that an active tractor field targets never settles: a heavy tow
 * runs far below the settle speed, and sleep zeroes its velocity; while held
 * its linear damping is capped at `BEAMED_LINEAR_DAMPING` (plain debris
 * drag), restored on release.
 */
import type RAPIER from '@dimforge/rapier2d-compat';
import type { ForceField } from './forceFields.js';

/** Fixed steps a settle body (`setSleepSettle`) must stay under its
 *  thresholds before it is put to sleep: half a second (Rapier's own timer
 *  is 2 s, at a 0.4 u/s threshold). */
export const WRECK_SETTLE_STEPS = 30;

/** Linear damping cap while a tractor beam holds a settle body: plain debris
 *  drag (= `WRECK_LINEAR_DAMPING`, asserted by World.sleepSettle.test.ts), so
 *  a 10× rock drag does not stall a tow. Released, the body's own damping
 *  returns. */
export const BEAMED_LINEAR_DAMPING = 0.06;

interface SettleEntry { id: string; body: RAPIER.RigidBody; speed2: number; spin: number; count: number; base: number; held: boolean }

/** Does an active tractor field target body `id`? (Settle skips it.) */
function tractorHolds(fields: ReadonlyMap<string, ForceField>, id: string): boolean {
  for (const f of fields.values()) if (f.kind === 'tractor' && f.active && f.target === id) return true;
  return false;
}

/** The per-body settle rules of one `PhysicsWorld`. */
export class SleepSettle {
  private readonly settle = new Map<string, SettleEntry>();

  get size(): number { return this.settle.size; }

  /** Register (or retune) `body` under `id`; `speed <= 0` removes it, restoring a held body's damping. */
  set(id: string, body: RAPIER.RigidBody, speed: number, spin: number): void {
    if (!(speed > 0)) {
      const old = this.settle.get(id);
      if (old?.held) body.setLinearDamping(old.base);
      this.settle.delete(id);
      return;
    }
    const s = this.settle.get(id);
    if (s) { s.speed2 = speed * speed; s.spin = spin; s.count = 0; return; }
    this.settle.set(id, { id, body, speed2: speed * speed, spin, count: 0, base: body.linearDamping(), held: false });
  }

  /** Forget `id` (its body is being removed). */
  remove(id: string): void { this.settle.delete(id); }

  /** One settle pass after a fixed step (alloc-free apart from Rapier's own
   *  `linvel()` getter, as in `getAllShipStates`). */
  step(fields: ReadonlyMap<string, ForceField>): void {
    for (const s of this.settle.values()) {
      const b = s.body;
      const held = fields.size > 0 && tractorHolds(fields, s.id);
      if (held !== s.held) {
        s.held = held;
        b.setLinearDamping(held ? Math.min(s.base, BEAMED_LINEAR_DAMPING) : s.base);
      }
      if (held || b.isSleeping()) { s.count = 0; continue; }
      const v = b.linvel();
      if (v.x * v.x + v.y * v.y < s.speed2 && Math.abs(b.angvel()) < s.spin) {
        if (++s.count >= WRECK_SETTLE_STEPS) { b.sleep(); s.count = 0; }
      } else {
        s.count = 0;
      }
    }
  }
}
