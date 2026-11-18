/**
 * The client half of fire control's blocked-line hold (core
 * `blockedLineHold.ts`; server `BlockedLineHold`, #15, #19): the local fire
 * pass (`ColyseusClient.fcGroupBears` / `fcMountBears` / `fcFireMounts`) asks
 * here before a beam or railgun mount may fire, so the client never draws a
 * predicted beam the server will refuse.
 *
 * The query is the client's one first-hit ray (`DisplayPoseHitscan`, the drawn
 * beam's ray): from the muzzle to the target's centre, skipping the own ship
 * and loot pods, and wreck pieces for a pass-through slug, exactly the
 * server's skips. Anything hit before the target blocks. The timer is the one
 * core `BlockedLineTimers`, stepped in GAME time. Allocation-free per call (#14).
 * Parity: `tests/unit/blockedLineHoldParity.test.ts`.
 */
import { BlockedLineTimers, holdsOnBlockedLine, shotPassesThrough } from '@core/combat/blockedLineHold';
import type { WeaponId } from '@core/combat/WeaponCatalogue';

/** The first-hit ray (`DisplayPoseHitscan.hitscan`). */
export interface LineRay {
  hitscan(
    fromX: number, fromY: number, dirX: number, dirY: number, maxDist: number, excludeId: string,
    halfWidth?: number, passWreck?: boolean,
  ): { hitId: string; dist: number } | null;
}

export class BlockedLineMirror {
  private readonly timers = new BlockedLineTimers();
  /** Running count of line queries (host-independent work count). */
  checks = 0;

  /**
   * True ⇒ this mount holds fire now: `weaponId` is a straight-line weapon and
   * its line (fx, fy) → (tx, ty) to `targetId` (a predWorld body key) has been
   * blocked for the tolerance. `selfId`: the own ship's body key.
   */
  held(
    ray: LineRay, key: string, mountIdx: number, weaponId: WeaponId,
    fx: number, fy: number, tx: number, ty: number, selfId: string, targetId: string, nowMs: number,
  ): boolean {
    if (!holdsOnBlockedLine(weaponId)) return false;
    this.checks++;
    const dx = tx - fx, dy = ty - fy;
    const len = Math.hypot(dx, dy);
    const h = len > 1e-6 ? ray.hitscan(fx, fy, dx / len, dy / len, len, selfId, 0, shotPassesThrough(weaponId)) : null;
    return this.timers.step(key, mountIdx, targetId, h !== null && h.hitId !== targetId, nowMs);
  }

  /** Drop a ship's timers (own ship gone, sector handoff). */
  forget(key: string): void { this.timers.forget(key); }

  /** Drop every timer (sector handoff). */
  clear(): void { this.timers.clear(); }
}
