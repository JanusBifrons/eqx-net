/**
 * Burn lines: the recent cut lines of the cutting beams on one hull or one
 * wreck piece (fracture v12 multi-cut; capital-destruction.md "Multi-cut").
 *
 * Owner 2026-11-15, "one cut per beam": three main turrets burn a piece at
 * slightly different points and angles; when it gives way (a live ship's
 * kill split, a worn-out piece's re-split) it breaks along EVERY line that
 * burned it, not only the last shot's. The ONE tracker for both paths: the
 * server keeps one per tracked hull (`CapitalWreckSubsystem`'s hit entry)
 * and one per wreck piece (its per-piece entry, beside the integrity).
 *
 * Each slot holds the latest line of one beam: a weapon with a `killCut`
 * (heavy beam, railgun, mining laser) hitting at a point along a direction,
 * in the hull's 1× Pixi-up frame (the frame the fracture and the wire use),
 * mapped from the hit's world point with the target's pose AT THE HIT, so
 * the line stays put while the target moves and turns. A beam's next hit
 * from the same shooter on (nearly) the same line overwrites its slot, so a
 * sweeping beam keeps one slot without knowing its mount; a new line takes
 * a free or stale slot, else the oldest. Lines older than
 * `BURN_LINE_WINDOW_TICKS` (~1 s of game time) are gone.
 *
 * Near-duplicates merge (`sameBurnLine`: under ~5° apart and a gap under
 * `mergeGap` between their strips), so near-parallel beams never leave a
 * sliver between them. Fixed typed slots, no allocation per hit (#14);
 * `extraCuts` allocates its short result once per break.
 */
import { unitDirFromSteps } from '../geometry/unitDir.js';
import { CUT_ANGLE_STEPS, FRACTURE_MAX_EXTRA_CUTS } from './fractureHull.js';
import type { WreckExtraCut } from '../../shared-types/messages/wreckDescriptor.js';

/** Lines one hull or piece remembers (the main cut and three more). */
export const BURN_LINE_SLOTS = FRACTURE_MAX_EXTRA_CUTS + 1;
/** A line older than this many server ticks (~1 s of game time at 60 Hz)
 *  no longer cuts. */
export const BURN_LINE_WINDOW_TICKS = 60;
/** Two lines closer than ~5° (|cos| of the angle between them) may merge. */
export const BURN_LINE_MERGE_COS = 0.9961946980917455;
/** The gap two near-parallel lines' strips may leave and still merge, per
 *  unit of the cut thing's radius (a hull's, or a piece's own; #18). */
export const BURN_LINE_MERGE_GAP_PER_RADIUS = 0.08;

const DIR = { x: 0, y: 0 };
const PT = { x: 0, y: 0 };

/** World point (wx, wy) → the 1× Pixi-up frame of a hull whose origin is at
 *  world (ox, oy), turned by `angle`, `scale` world units per 1× unit (the
 *  hull's scaled math-up frame, then ÷ scale and y flipped). Into `out`. */
export function hullPointInto(
  ox: number, oy: number, angle: number, scale: number, wx: number, wy: number, out: { x: number; y: number },
): void {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const hx = wx - ox;
  const hy = wy - oy;
  out.x = (hx * c + hy * sn) / scale;
  out.y = -(-hx * sn + hy * c) / scale;
}

/**
 * Do two cut lines (hull frame: a point, a unit direction, a strip width)
 * count as one? Under ~5° apart AND b's point lies within `mergeGap` of a's
 * strip (both half-widths added), so the sliver between them would be
 * thinner than `mergeGap`. Scalars only.
 */
export function sameBurnLine(
  ax: number, ay: number, adx: number, ady: number, aw: number,
  bx: number, by: number, bdx: number, bdy: number, bw: number, mergeGap: number,
): boolean {
  if (Math.abs(adx * bdx + ady * bdy) < BURN_LINE_MERGE_COS) return false;
  const off = Math.abs((bx - ax) * -ady + (by - ay) * adx);
  return off <= mergeGap + (aw + bw) / 2;
}

/** A world direction → the u16 cut angle in the frame of a hull turned by
 *  `angle` (Pixi-up, `cutAng`). Scalar twin of `hullLocalCutAngle`. */
export function hullCutAngleOf(angle: number, dirX: number, dirY: number): number {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  const mx = dirX * c + dirY * sn;
  const my = -dirX * sn + dirY * c;
  const t = Math.atan2(-my, mx) / (2 * Math.PI);
  return ((Math.round(t * CUT_ANGLE_STEPS) % CUT_ANGLE_STEPS) + CUT_ANGLE_STEPS) % CUT_ANGLE_STEPS;
}

export class BurnLines {
  private readonly shooter: string[] = [];
  /** Server tick of each slot's latest hit; -1 = empty. */
  private readonly tick = new Float64Array(BURN_LINE_SLOTS).fill(-1);
  private readonly x = new Float64Array(BURN_LINE_SLOTS);
  private readonly y = new Float64Array(BURN_LINE_SLOTS);
  private readonly dx = new Float64Array(BURN_LINE_SLOTS);
  private readonly dy = new Float64Array(BURN_LINE_SLOTS);
  private readonly w = new Float64Array(BURN_LINE_SLOTS);
  private readonly ang = new Int32Array(BURN_LINE_SLOTS);

  /** `mergeGap`: hull 1× frame (`BURN_LINE_MERGE_GAP_PER_RADIUS` × the cut
   *  thing's 1× radius). */
  constructor(public mergeGap: number) {
    for (let i = 0; i < BURN_LINE_SLOTS; i++) this.shooter.push('');
  }

  /** Forget every line (a pooled entry reused for another hull). */
  clear(mergeGap: number): void {
    this.mergeGap = mergeGap;
    this.tick.fill(-1);
    for (let i = 0; i < BURN_LINE_SLOTS; i++) this.shooter[i] = '';
  }

  /**
   * A cutting hit by `shooter` at server tick `tick`: world point (hitX,
   * hitY) along world (dirX, dirY), on a hull whose 1× Pixi-up frame has its
   * origin at world (ox, oy), turned by `angle`, `scale` world units per 1×
   * unit; `width` the cut's strip in world units. Alloc-free (#14).
   */
  record(
    shooter: string, tick: number, ox: number, oy: number, angle: number, scale: number,
    hitX: number, hitY: number, dirX: number, dirY: number, width: number,
  ): void {
    if (!(scale > 0) || (dirX === 0 && dirY === 0)) return;
    hullPointInto(ox, oy, angle, scale, hitX, hitY, PT);
    const lx = PT.x;
    const ly = PT.y;
    const ang = hullCutAngleOf(angle, dirX, dirY);
    const d = unitDirFromSteps(ang, DIR);
    const lw = width > 0 ? width / scale : 0;
    let slot = -1;
    let oldest = 0;
    for (let i = 0; i < BURN_LINE_SLOTS; i++) {
      const t = this.tick[i]!;
      const live = t >= 0 && tick - t < BURN_LINE_WINDOW_TICKS;
      if (live && this.shooter[i] === shooter
        && sameBurnLine(this.x[i]!, this.y[i]!, this.dx[i]!, this.dy[i]!, this.w[i]!, lx, ly, d.x, d.y, lw, this.mergeGap)) {
        slot = i;
        break;
      }
      if (t < this.tick[oldest]!) oldest = i;
    }
    if (slot < 0) slot = oldest;
    this.shooter[slot] = shooter;
    this.tick[slot] = tick;
    this.x[slot] = lx;
    this.y[slot] = ly;
    this.dx[slot] = d.x;
    this.dy[slot] = d.y;
    this.w[slot] = lw;
    this.ang[slot] = ang;
  }

  /** Lines still live at `tick` (test seam and diagnostics). */
  liveCount(tick: number): number {
    let n = 0;
    for (let i = 0; i < BURN_LINE_SLOTS; i++) {
      const t = this.tick[i]!;
      if (t >= 0 && tick - t < BURN_LINE_WINDOW_TICKS) n++;
    }
    return n;
  }

  /**
   * The further cuts of a break at `tick` whose main cut runs through hull
   * point (x, y) at u16 angle `ang`, strip `w` (1× frame): every live line
   * that is not a near-duplicate of the main cut nor of a line already
   * taken, newest first, at most `FRACTURE_MAX_EXTRA_CUTS`; undefined when
   * none. Once per break (allocates its result).
   */
  extraCuts(tick: number, x: number, y: number, ang: number, w: number): WreckExtraCut[] | undefined {
    const pd = unitDirFromSteps(ang, { x: 0, y: 0 });
    const taken: number[] = [];
    const out: WreckExtraCut[] = [];
    const used = new Uint8Array(BURN_LINE_SLOTS);
    while (out.length < FRACTURE_MAX_EXTRA_CUTS) {
      // The newest live line not yet considered (ties: the lower slot).
      let best = -1;
      for (let i = 0; i < BURN_LINE_SLOTS; i++) {
        const t = this.tick[i]!;
        if (used[i] || t < 0 || tick - t >= BURN_LINE_WINDOW_TICKS) continue;
        if (best < 0 || t > this.tick[best]!) best = i;
      }
      if (best < 0) break;
      used[best] = 1;
      const bx = this.x[best]!, by = this.y[best]!, bdx = this.dx[best]!, bdy = this.dy[best]!, bw = this.w[best]!;
      if (sameBurnLine(x, y, pd.x, pd.y, w, bx, by, bdx, bdy, bw, this.mergeGap)) continue;
      let dup = false;
      for (const j of taken) {
        if (sameBurnLine(this.x[j]!, this.y[j]!, this.dx[j]!, this.dy[j]!, this.w[j]!, bx, by, bdx, bdy, bw, this.mergeGap)) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      taken.push(best);
      out.push(bw > 0 ? { x: bx, y: by, ang: this.ang[best]!, w: bw } : { x: bx, y: by, ang: this.ang[best]! });
    }
    return out.length > 0 ? out : undefined;
  }
}
