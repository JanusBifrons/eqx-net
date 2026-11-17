import { GALAXY_SECTORS } from '@core/galaxy/galaxy';
import type { SectorControl, SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import { splitChallenger, flipRingStrength } from './galaxyTerritories';
import { resolveSectorOwner, NEUTRAL_OWNER } from './sectorOwnership';

/**
 * The galaxy map's motion between two feed polls (pure, no Pixi): the split
 * line easing to its new share, the flip wipe, the new-fighting flare, the
 * hot-front pulse and the nebula drift. `galaxyMapFx.ts` turns these into
 * Pixi calls inside the `GalaxyMapLayer` ticker. All times are the layer's
 * UI clock (ms of ticker time while the map is visible).
 */

/** How long a split line takes to ease to its new share. */
export const SPLIT_EASE_MS = 1000;
/** How long a flip's wipe in the new owner's colour takes to cross the hex. */
export const FLIP_WIPE_MS = 900;
/** How long a new-fighting flare lasts. */
export const FLARE_MS = 1400;
/** Threat at or above which a sector is a hot front and pulses. */
export const HOT_THREAT = 2;
/** One slow hot-front pulse (ms). */
export const HOT_PULSE_PERIOD_MS = 2600;
/** The split line never goes closer to a hex side than this fraction, so a
 *  thin share still reads as a sliver of colour. */
export const SPLIT_MIN_SIDE = 0.18;

/** The viewer asked the OS for reduced motion (main thread only; false in a worker). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Smooth in-out ease, 0 → 1 (clamped). */
export function easeInOut(t: number): number {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * The holder's side of a hex as a fraction of its width (0 = all challenger,
 * 1 = whole hex the holder's). A sector with no split (see `splitChallenger`)
 * is 1. Owned: holder share over holder + challenger. Nobody's ground: the
 * grey side is what the leader has not taken. Clamped to
 * [{@link SPLIT_MIN_SIDE}, 1 - SPLIT_MIN_SIDE] while split.
 */
export function splitFraction(control: SectorControl | null | undefined, holderId: string): number {
  if (!control || splitChallenger(control, holderId) === null) return 1;
  const c = control.challengerShare;
  const unowned = holderId === NEUTRAL_OWNER || holderId === '';
  const raw = unowned ? (100 - c) / 100 : control.holderShare / Math.max(1e-6, control.holderShare + c);
  return Math.min(1 - SPLIT_MIN_SIDE, Math.max(SPLIT_MIN_SIDE, raw));
}

/** Did this poll bring NEW fighting? Threat rose, or recent combat appeared.
 *  The first poll (`prevThreat < 0`) never flares. */
export function isNewFighting(prevThreat: number, prevCombat: boolean, threat: number, combat: boolean): boolean {
  if (prevThreat < 0) return false;
  return threat > prevThreat || (combat && !prevCombat);
}

/** Flare look `ageMs` after it started: radius as a fraction of the hex size
 *  (grows) and alpha (fades); alpha 0 once over. Written into `out`. */
export function flareAt(ageMs: number, out: { radius: number; alpha: number }): void {
  if (!(ageMs >= 0) || ageMs >= FLARE_MS) {
    out.radius = 0;
    out.alpha = 0;
    return;
  }
  const t = ageMs / FLARE_MS;
  out.radius = 0.45 + 0.75 * (1 - (1 - t) * (1 - t));
  out.alpha = 1 - t;
}

/** Hot-front glow alpha at a clock time: a slow breath between 0.15 and 0.6;
 *  a steady 0.35 under reduced motion. */
export function hotPulseAlpha(clockMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0.35;
  const s = 0.5 - 0.5 * Math.cos((clockMs / HOT_PULSE_PERIOD_MS) * Math.PI * 2);
  return 0.15 + 0.45 * s;
}

/** The dashed flip ring waits for the wipe, then fades as before. */
export function flipRingAfterWipe(ageMs: number): number {
  return ageMs >= FLIP_WIPE_MS ? flipRingStrength(ageMs) : 0;
}

/** Slow nebula drift at a clock time, written into `out`: an offset in map px,
 *  a scale factor and an alpha factor. Periods are long and co-prime-ish so
 *  the cloud never visibly loops. Reduced motion: no drift. */
export function nebulaDrift(
  clockMs: number, reducedMotion: boolean, out: { dx: number; dy: number; scale: number; alpha: number },
): void {
  if (reducedMotion) {
    out.dx = 0; out.dy = 0; out.scale = 1; out.alpha = 1;
    return;
  }
  const t = clockMs / 1000;
  out.dx = 22 * Math.sin(t * 0.071);
  out.dy = 16 * Math.sin(t * 0.053 + 1.3);
  out.scale = 1 + 0.025 * Math.sin(t * 0.041 + 0.7);
  out.alpha = 0.88 + 0.12 * Math.sin(t * 0.097 + 2.1);
}

/**
 * Cut a convex polygon (flat `x,y,…` points) by the vertical line `x = cut`:
 * the part left of it into `left`, right of it into `right` (both flat, both
 * cleared first). Allocation-free: the outputs are reused per hex.
 */
export function clipPolyAtX(v: readonly number[], cut: number, left: number[], right: number[]): void {
  left.length = 0;
  right.length = 0;
  const n = v.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = v[i * 2]!, ay = v[i * 2 + 1]!;
    const j = (i + 1) % n;
    const bx = v[j * 2]!, by = v[j * 2 + 1]!;
    if (ax <= cut) left.push(ax, ay);
    if (ax >= cut) right.push(ax, ay);
    if ((ax < cut && bx > cut) || (ax > cut && bx < cut)) {
      const y = ay + ((cut - ax) / (bx - ax)) * (by - ay);
      left.push(cut, y);
      right.push(cut, y);
    }
  }
}

/** How one hex draws this frame (written by {@link GalaxyMotion.look}). */
export interface HexLook {
  /** Owner on the left side (the holder, or the new owner mid-wipe). */
  left: string;
  /** Owner on the right side, or null for a whole hex. */
  right: string | null;
  /** The left side's fraction of the hex width (1 = whole hex). */
  frac: number;
  /** True mid-wipe: the cut is drawn in the new owner's colour. */
  wiping: boolean;
}

const IDLE = Number.NaN;

/**
 * Per-sector motion state, indexed by `GALAXY_SECTORS` order (the layer's entry
 * order, stable across territory re-groups). `onFeed` runs at poll cadence
 * and starts tweens; `look` / `flareAge` / `isAnimating` run per frame and
 * allocate nothing.
 */
export class GalaxyMotion {
  readonly count = GALAXY_SECTORS.length;
  private readonly owner: string[] = new Array<string>(this.count).fill('');
  private readonly other: string[] = new Array<string>(this.count).fill('');
  private readonly prevThreat = new Int8Array(this.count).fill(-1);
  private readonly prevCombat = new Uint8Array(this.count);
  private readonly splitFrom = new Float64Array(this.count).fill(1);
  private readonly splitTo = new Float64Array(this.count).fill(1);
  private readonly splitStart = new Float64Array(this.count).fill(IDLE);
  private readonly wipeStart = new Float64Array(this.count).fill(IDLE);
  private readonly wipeFrom: string[] = new Array<string>(this.count).fill('');
  private readonly flareStart = new Float64Array(this.count).fill(IDLE);
  private readonly hot = new Uint8Array(this.count);
  private seen = false;

  constructor(readonly reducedMotion: boolean) {}

  /** A feed poll arrived at `nowMs`. Starts the split ease, flip wipe and
   *  flare for every sector that changed; the first poll animates nothing. */
  onFeed(byKey: ReadonlyMap<string, SectorLiveState>, nowMs: number): void {
    for (let i = 0; i < this.count; i++) {
      const key = GALAXY_SECTORS[i]!.key;
      const st = byKey.get(key);
      const c = st?.control;
      const owner = resolveSectorOwner(key, byKey);
      const challenger = splitChallenger(c, owner);
      const target = splitFraction(c, owner);
      const current = this.fracAt(i, nowMs);
      const threat = c?.threat ?? 0;
      const combat = st?.recentCombat != null;
      this.hot[i] = threat >= HOT_THREAT ? 1 : 0;
      if (challenger !== null) this.other[i] = challenger;
      const flipped = this.seen && this.owner[i] !== owner;
      if (!this.seen || this.reducedMotion) {
        this.splitFrom[i] = target;
        this.splitStart[i] = IDLE;
      } else if (flipped) {
        // Wipe the new owner across, then ease from a whole hex to the split.
        this.wipeFrom[i] = this.owner[i]!;
        this.wipeStart[i] = nowMs;
        this.splitFrom[i] = 1;
        this.splitStart[i] = nowMs + FLIP_WIPE_MS;
      } else if (Math.abs(current - target) > 1e-3) {
        this.splitFrom[i] = current;
        this.splitStart[i] = nowMs;
      }
      this.splitTo[i] = target;
      if (!this.reducedMotion && isNewFighting(this.prevThreat[i]!, this.prevCombat[i] === 1, threat, combat)) {
        this.flareStart[i] = nowMs;
      }
      this.owner[i] = owner;
      this.prevThreat[i] = threat;
      this.prevCombat[i] = combat ? 1 : 0;
    }
    this.seen = true;
  }

  /** The holder's side fraction of hex `i` at `nowMs`. */
  fracAt(i: number, nowMs: number): number {
    const start = this.splitStart[i]!;
    const to = this.splitTo[i]!;
    if (Number.isNaN(start)) return to;
    const t = easeInOut((nowMs - start) / SPLIT_EASE_MS);
    return this.splitFrom[i]! + (to - this.splitFrom[i]!) * t;
  }

  /** Flip-wipe progress of hex `i` (0 → 1), or -1 when no wipe is running. */
  wipeAt(i: number, nowMs: number): number {
    const start = this.wipeStart[i]!;
    if (Number.isNaN(start)) return -1;
    const age = nowMs - start;
    return age >= FLIP_WIPE_MS ? -1 : easeInOut(age / FLIP_WIPE_MS);
  }

  /** How hex `i` (held by `holder`) draws at `nowMs`, into `out`. */
  look(i: number, holder: string, nowMs: number, out: HexLook): void {
    const wipe = this.wipeAt(i, nowMs);
    if (wipe >= 0) {
      out.left = holder;
      out.right = this.wipeFrom[i]!;
      out.frac = wipe;
      out.wiping = true;
      return;
    }
    const frac = this.fracAt(i, nowMs);
    out.left = holder;
    out.right = frac < 1 && this.other[i] !== '' ? this.other[i]! : null;
    out.frac = out.right === null ? 1 : frac;
    out.wiping = false;
  }

  /** Ms since hex `i`'s flare started, or -1 when none is running. */
  flareAge(i: number, nowMs: number): number {
    const start = this.flareStart[i]!;
    if (Number.isNaN(start)) return -1;
    const age = nowMs - start;
    return age >= FLARE_MS ? -1 : age;
  }

  /** Is hex `i` a hot front (threat ≥ {@link HOT_THREAT})? */
  isHot(i: number): boolean {
    return this.hot[i] === 1;
  }

  /** Is hex `i`'s fill moving at `nowMs` (split ease or wipe)? */
  isAnimating(i: number, nowMs: number): boolean {
    if (this.wipeAt(i, nowMs) >= 0) return true;
    const start = this.splitStart[i]!;
    return !Number.isNaN(start) && nowMs - start < SPLIT_EASE_MS;
  }

  /** Mark finished tweens idle. Returns true if hex `i` just settled (draw it
   *  once more at its final look). */
  settle(i: number, nowMs: number): boolean {
    let settled = false;
    const ws = this.wipeStart[i]!;
    if (!Number.isNaN(ws) && nowMs - ws >= FLIP_WIPE_MS) {
      this.wipeStart[i] = IDLE;
      settled = true;
    }
    const ss = this.splitStart[i]!;
    if (!Number.isNaN(ss) && nowMs - ss >= SPLIT_EASE_MS) {
      this.splitStart[i] = IDLE;
      this.splitFrom[i] = this.splitTo[i]!;
      settled = true;
    }
    const fs = this.flareStart[i]!;
    if (!Number.isNaN(fs) && nowMs - fs >= FLARE_MS) this.flareStart[i] = IDLE;
    return settled;
  }

  /** Anything per-hex still running (tween, wipe, pending ease or flare)? */
  anyActive(): boolean {
    for (let i = 0; i < this.count; i++) {
      if (!Number.isNaN(this.splitStart[i]!) || !Number.isNaN(this.wipeStart[i]!) || !Number.isNaN(this.flareStart[i]!)) return true;
    }
    return false;
  }

  /** Any hot front on the map? */
  anyHot(): boolean {
    for (let i = 0; i < this.count; i++) if (this.hot[i] === 1) return true;
    return false;
  }
}
