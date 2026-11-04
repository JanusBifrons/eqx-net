/**
 * Effects — the per-frame maths, kept pure and allocation-free (invariant #14)
 * so it can be unit-tested and shared by the lab and the game.
 */

/** Flipbook frame for an effect `age` seconds into a `life`-second play;
 *  -1 before it starts or after it ends. */
export function flipFrame(age: number, life: number, frames: number): number {
  if (age < 0 || age >= life || life <= 0) return -1;
  return Math.min(frames - 1, Math.floor((age / life) * frames));
}

/** 0 → 1 → 0 envelope: linear rise over `rise` s, exponential-ish fall to
 *  zero at `life`. */
export function envelope(age: number, rise: number, life: number): number {
  if (age < 0 || age >= life) return 0;
  const up = rise > 0 ? Math.min(1, age / rise) : 1;
  const k = (age - rise) / Math.max(1e-6, life - rise);
  const down = age <= rise ? 1 : Math.pow(1 - k, 2);
  return up * down;
}

/** Lerp two 0xRRGGBB colours. */
export function lerpRgb(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = ((a >> 16) & 255) + ((((b >> 16) & 255) - ((a >> 16) & 255)) * k);
  const g = ((a >> 8) & 255) + ((((b >> 8) & 255) - ((a >> 8) & 255)) * k);
  const bl = (a & 255) + (((b & 255) - (a & 255)) * k);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

/** Ember colour by heat 1 (white-hot) → 0 (dark red). */
export function emberTint(heat: number): number {
  return heat > 0.6 ? lerpRgb(0xffb040, 0xfff2d0, (heat - 0.6) / 0.4)
    : heat > 0.25 ? lerpRgb(0xd23a10, 0xffb040, (heat - 0.25) / 0.35)
      : lerpRgb(0x300804, 0xd23a10, heat / 0.25);
}

export interface TileXf { scale: number; x: number; y: number }

/**
 * A backdrop layer's transform for a camera at (`camX`, `camY`, `zoom`).
 *
 * Depth is two numbers: `parallax` (how far the layer pans when the camera
 * moves; 0 = fixed to the screen, 1 = world) and `zoomPow` (how much it grows
 * when you zoom; 0 = not at all, 1 = with the world). Distant layers use small
 * values for both, so zooming feels like moving through depth rather than
 * magnifying a flat picture. Writes the tile scale and tile offset for a
 * `TilingSprite` that covers the screen.
 */
export function backdropXf(camX: number, camY: number, zoom: number, parallax: number, zoomPow: number,
  screenW: number, screenH: number, out: TileXf): TileXf {
  const s = Math.pow(Math.max(1e-3, zoom), zoomPow);
  out.scale = s;
  // The point under the screen centre in layer space is cam * parallax; keep it there.
  out.x = screenW / 2 - camX * parallax * s;
  out.y = screenH / 2 - camY * parallax * s;
  return out;
}

/** Alpha of a layer whose visible zoom window is [inAt..fullAt] up, [dimAt..outAt] down
 *  (log-space smoothstep, so each window reads evenly). */
export function zoomWindow(zoom: number, inAt: number, fullAt: number, dimAt: number, outAt: number): number {
  const z = Math.log(Math.max(1e-3, zoom));
  const ss = (a: number, b: number, v: number): number => {
    if (a === b) return v >= b ? 1 : 0;
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const up = inAt <= 0 ? 1 : ss(Math.log(inAt), Math.log(fullAt), z);
  const down = outAt === Infinity ? 1 : 1 - ss(Math.log(dimAt), Math.log(outAt), z);
  return up * down;
}

/**
 * Up to `SHIELD_HITS` recent hits on one shield: the angle each came from (radians,
 * Pixi space) and when. Oldest is overwritten. Fixed storage: no allocation.
 */
export const SHIELD_HITS = 4;
export class ShieldHits {
  readonly ang = new Float32Array(SHIELD_HITS);
  readonly t = new Float32Array(SHIELD_HITS).fill(-1e9);
  readonly power = new Float32Array(SHIELD_HITS);
  private next = 0;

  add(angle: number, now: number, power = 1): void {
    this.ang[this.next] = angle;
    this.t[this.next] = now;
    this.power[this.next] = power;
    this.next = (this.next + 1) % SHIELD_HITS;
  }

  /** Age of slot `i` (seconds); huge when unused. */
  age(i: number, now: number): number {
    return now - this.t[i]!;
  }

  /** Total visible intensity across hits still inside `life` (0 when idle):
   *  lets the caller skip drawing an idle shield entirely. */
  activity(now: number, life: number): number {
    let s = 0;
    for (let i = 0; i < SHIELD_HITS; i++) {
      const a = now - this.t[i]!;
      if (a >= 0 && a < life) s += this.power[i]! * (1 - a / life);
    }
    return s;
  }

  clear(): void {
    this.t.fill(-1e9);
    this.next = 0;
  }
}

/**
 * A fixed ring of the last `n` positions of something moving (missile smoke):
 * push one point per frame, read them newest-first. No allocation after construction.
 */
export class TrailRing {
  readonly x: Float32Array;
  readonly y: Float32Array;
  private head = 0;
  private filled = 0;

  constructor(readonly n: number) {
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
  }

  push(px: number, py: number): void {
    this.head = (this.head + 1) % this.n;
    this.x[this.head] = px;
    this.y[this.head] = py;
    if (this.filled < this.n) this.filled++;
  }

  /** Point `k` steps back (0 = newest); repeats the oldest while filling. */
  readX(k: number): number { return this.x[this.idx(k)]!; }
  readY(k: number): number { return this.y[this.idx(k)]!; }

  count(): number { return this.filled; }

  reset(px: number, py: number): void {
    this.x.fill(px); this.y.fill(py);
    this.filled = 0; this.head = 0;
  }

  private idx(k: number): number {
    const kk = Math.min(k, Math.max(0, this.filled - 1));
    return (this.head - kk + this.n * 2) % this.n;
  }
}
