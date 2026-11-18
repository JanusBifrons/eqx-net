/**
 * Hull avoidance (ramming is a real weapon since #558, so an accidental ram
 * hurts both ships). Any ship or debris piece whose closest approach on the
 * current velocities passes inside `hullClearance` (both shield bubbles + a
 * radius), sooner than the time I need to turn the nose sideways at my turn
 * rate and slide clear with my thrust (× `AVOID_SAFETY`, + `AVOID_LATENCY_S`),
 * makes me dodge: nose to the side away from it, thrust and boost. All from
 * the kind's own handling and size, so it follows a retuned ship.
 *
 * Debris (`AiWorldView.debris`: wreck pieces, drifting field rocks) is solid
 * terrain steered round by the same rule; one already inside the clearance
 * with no real closing speed (riding on the bubble) is a collision now.
 *
 * One per brain (it latches the dodge side). Allocation-free (#14).
 */
import type { AiEntity, IAiNeighbourQuery } from '../contracts/IAiBehaviour.js';
import type { PilotHandling } from './virtualPilot.js';
import { hullClearance } from './tactics/manoeuvre.js';

const AVOID_SAFETY = 1.3;
const AVOID_LATENCY_S = 0.1;
/** Look this many seconds of closing ahead for a ship to avoid. */
const AVOID_LOOK_S = 3;
/** The dodge side (left / right of the closing velocity) is latched for the
 *  running manoeuvre, and freed once no dodge has been flown for this long
 *  (ticks, 1 s). Picked afresh each tick, it flipped as the two ships slid
 *  across each other's closest-approach point: the turn key flapped at full
 *  rate nose to nose (filmed Robot Orb, 2026-11-14). */
const AVOID_SIDE_IDLE_TICKS = 60;
/** Ships read per check (nearest first). */
const SHIP_AVOID_K = 8;
/** Debris pieces read per check (nearest first): a ship flying through a
 *  fresh break-up has a dozen pieces round it, and the nearest few are the
 *  ones it can hit next. */
const DEBRIS_AVOID_K = 4;

export class HullAvoid {
  /** The dodge direction from the last check that found one (unit). */
  x = 0;
  y = 0;
  /** Latched dodge side: +1 left of the closing velocity, −1 right, 0 free. */
  private side = 0;
  /** Tick of the last dodge (frees the latch after `AVOID_SIDE_IDLE_TICKS`). */
  private lastTick = 0;
  /** Scan scratch: soonest collision this check and its side. */
  private bestT = Infinity;
  private bestSide = 0;
  /** This check holds a dodge begun last tick until the course clears. */
  private hold = false;
  private readonly idx = new Int32Array(SHIP_AVOID_K);

  /** Free the latched side (a new manoeuvre). */
  resetSide(): void { this.side = 0; }

  /**
   * The most urgent hull (`ships`, may be absent) or debris piece on a
   * collision course with me. True ⇒ dodge along (`x`, `y`): away from where
   * it will pass, or, dead head-on, to my right of the relative velocity,
   * which is the other ship's left of its own, so the two dodge apart. The
   * side is latched for the running manoeuvre. `sticky`: a dodge flown last
   * tick goes on while anything still passes inside the clearance, however
   * far off (a leg toward a goal past a rock: let go early, it steers
   * straight back in); combat leaves it off.
   */
  check(self: AiEntity, h: PilotHandling, radius: number, shieldPad: number, accel: number, tick: number,
    ships: IAiNeighbourQuery | undefined, debris: IAiNeighbourQuery | undefined, sticky = false): boolean {
    if (accel <= 0) return false;
    this.hold = sticky && tick - this.lastTick <= 1;
    const reach = AVOID_LOOK_S * (Math.hypot(self.vx, self.vy) + h.cruiseSpeed) + 4 * radius;
    if (this.side !== 0 && tick - this.lastTick > AVOID_SIDE_IDLE_TICKS) this.side = 0;
    this.bestT = Infinity;
    this.bestSide = 0;
    if (ships !== undefined) {
      const n = ships.queryNeighbours(self.x, self.y, reach, SHIP_AVOID_K, this.idx, self.id);
      this.scan(self, h, radius, shieldPad, ships, n, accel, false);
    }
    if (debris !== undefined && debris.count > 0) {
      const n = debris.queryNeighbours(self.x, self.y, reach, DEBRIS_AVOID_K, this.idx);
      this.scan(self, h, radius, shieldPad, debris, n, accel, true);
    }
    if (this.bestT === Infinity) return false;
    if (this.bestSide !== 0) this.side = this.bestSide;
    this.lastTick = tick;
    return true;
  }

  /** One source's candidates (entries `idx[0..n)` of `q`): keeps the soonest
   *  collision in `bestT` and its dodge in (`x`, `y`). */
  private scan(self: AiEntity, h: PilotHandling, r: number, shieldPad: number, q: IAiNeighbourQuery, n: number, accel: number, isDebris: boolean): void {
    const idx = this.idx;
    const fx = -Math.sin(self.angle);
    const fy = Math.cos(self.angle);
    const minW2 = 0.01 * h.cruiseSpeed * h.cruiseSpeed;
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      const px = q.xAt(i) - self.x;
      const py = q.yAt(i) - self.y;
      // Shields up, ships collide as their bubbles (hull radius + shield
      // pad, cede4a25), so clear both bubbles: the neighbour's pad is taken
      // as mine (the grid carries only its hull radius; a pad follows the
      // size class). On hull radii alone a passing pair aimed ~60 u apart at
      // the 2x default, inside the ~80 u the bubbles touch at: two fighters
      // boosting through a head-on pass grazed in 3 of 8 duels (dogfight
      // x8, 2026-11-14, once the doubled pool kept both boosting 6 s in).
      const clear = hullClearance(r, q.radiusAt(i), shieldPad);
      const wx = q.vxAt(i) - self.vx;
      const wy = q.vyAt(i) - self.vy;
      const w2 = wx * wx + wy * wy;
      const p2 = px * px + py * py;
      if (isDebris && p2 < clear * clear && (w2 < minW2 || px * wx + py * wy >= 0)) {
        // Riding on (or drifting off) the bubble: slide off it now, to the
        // side of my own velocity away from the piece (straight away from it
        // when all but stopped). Most urgent: t = 0.
        if (this.bestT <= 0) continue;
        const sp2 = self.vx * self.vx + self.vy * self.vy;
        let dx: number;
        let dy: number;
        if (sp2 > minW2) {
          const sl = Math.sqrt(sp2);
          // Left of my velocity is (−vy, vx); the piece on my left ⇒ go right.
          const side = -self.vy * px + self.vx * py > 0 ? -1 : 1;
          dx = (-self.vy / sl) * side;
          dy = (self.vx / sl) * side;
        } else {
          const pl = Math.sqrt(p2);
          if (pl < 1e-6) continue;
          dx = -px / pl;
          dy = -py / pl;
        }
        this.bestT = 0;
        this.bestSide = 0;
        this.x = dx;
        this.y = dy;
        continue;
      }
      if (w2 < minW2) continue;
      const t = -(px * wx + py * wy) / w2;
      if (t <= 0 || t >= this.bestT) continue;
      const mx = px + wx * t;
      const my = py + wy * t;
      const miss = Math.hypot(mx, my);
      if (miss >= clear) continue;
      // Away from where it passes (−m, square to w), as a side of w: +1 its
      // left (−wy, wx), −1 its right; dead head-on, the right. A latched
      // side wins.
      let side = this.side;
      if (side === 0) side = miss > 0.05 * clear && wy * mx - wx * my > 0 ? 1 : -1;
      const wl = Math.sqrt(w2);
      const dx = (-wy / wl) * side;
      const dy = (wx / wl) * side;
      const c = fx * dx + fy * dy;
      const turn = Math.acos(c > 1 ? 1 : c < -1 ? -1 : c) / Math.max(h.maxAngvel, 1e-3);
      const need = AVOID_SAFETY * (turn + Math.sqrt((2 * (clear - miss)) / accel)) + AVOID_LATENCY_S;
      if (t > need && !this.hold) continue;
      this.bestT = t;
      this.bestSide = side;
      this.x = dx;
      this.y = dy;
    }
  }
}
