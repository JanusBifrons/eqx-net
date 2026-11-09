/**
 * Pure motion curves for scripted touch / mouse input (showcase/touch.ts).
 * A curve maps progress u ∈ [0, 1] to a point; the driver samples it against
 * wall-clock time, so a slow CDP round-trip never stretches a gesture.
 * Unit-locked in tests/unit/showcaseTouch.test.ts.
 */

export interface Pt {
  x: number;
  y: number;
}

export type Curve = (u: number) => Pt;
export type Ease = (u: number) => number;

const clamp01 = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u);

export const linear: Ease = (u) => clamp01(u);

/** Sine ease-in-out: a thumb accelerates and settles, never snaps. */
export const easeInOut: Ease = (u) => {
  const t = clamp01(u);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
};

/** Ease-out (quick start, gentle arrival) — a flick toward a target. */
export const easeOut: Ease = (u) => {
  const t = clamp01(u);
  return 1 - (1 - t) * (1 - t);
};

/** Straight line from → to. */
export function line(from: Pt, to: Pt): Curve {
  return (u) => ({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u });
}

/**
 * Arc around (cx, cy) at radius r from angle a0 to a1 (radians, screen space:
 * 0 = right, +π/2 = down). A thumb rolling the stick around its centre.
 */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number): Curve {
  return (u) => {
    const a = a0 + (a1 - a0) * u;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  };
}

/**
 * A "wiggle": travel along `base` while swaying sideways (perpendicular to the
 * direction from base(0) to base(1), or along x for a stationary base) by
 * `amp` px, `cycles` times. The sway eases in/out so the ends sit on `base`.
 */
export function wiggle(base: Curve, amp: number, cycles: number): Curve {
  const p0 = base(0);
  const p1 = base(1);
  let nx = -(p1.y - p0.y);
  let ny = p1.x - p0.x;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) {
    nx = 1;
    ny = 0;
  } else {
    nx /= len;
    ny /= len;
  }
  return (u) => {
    const b = base(u);
    const envelope = Math.sin(Math.PI * clamp01(u));
    const s = Math.sin(2 * Math.PI * cycles * u) * amp * envelope;
    return { x: b.x + nx * s, y: b.y + ny * s };
  };
}

/** Hold still at p. */
export function still(p: Pt): Curve {
  return () => ({ x: p.x, y: p.y });
}

/** Point on a curve at progress u under an easing. */
export function sample(curve: Curve, ease: Ease, u: number): Pt {
  return curve(ease(clamp01(u)));
}

/**
 * Fixed-rate samples of a curve over `ms` (inclusive of both ends) — what the
 * driver would emit if every step ran on time. Used by tests and for planning.
 */
export function samples(curve: Curve, ms: number, ease: Ease = easeInOut, hz = 60): Pt[] {
  const n = Math.max(1, Math.ceil((ms / 1000) * hz));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(sample(curve, ease, i / n));
  return out;
}

/** Offset of length r in the direction of angle a (screen radians). */
export function polar(origin: Pt, r: number, a: number): Pt {
  return { x: origin.x + Math.cos(a) * r, y: origin.y + Math.sin(a) * r };
}

/** Keep p inside a rect (inset by `pad`). */
export function clampTo(p: Pt, rect: { x: number; y: number; width: number; height: number }, pad = 0): Pt {
  return {
    x: Math.min(rect.x + rect.width - pad, Math.max(rect.x + pad, p.x)),
    y: Math.min(rect.y + rect.height - pad, Math.max(rect.y + pad, p.y)),
  };
}
