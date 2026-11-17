/**
 * Closed-form easing curves for articulation clips (structure-restyle 2a).
 *
 * A clip pose must be a pure function of `(clip, startTick, nowTick)`, so its
 * easing has to be a curve `t in [0, 1] -> [0, 1]` with no state. The existing
 * smoothers (`engineFx.ts easeTo`, `camera/smoothDamp.ts`, `virtualPilot.ts
 * easedSnapTurn`) are stateful dt integrators: their output depends on the
 * frame history, so they cannot replay a clip from its start tick. They stay
 * where they are; nothing here duplicates them.
 *
 * Arithmetic only (no pow / trig), so every engine gives the same bits.
 */

/** Easing ids a keyframe may name (the curve INTO that keyframe). */
export const EASE_IDS = ['linear', 'in', 'out', 'inOut', 'step'] as const;
export type EaseId = (typeof EASE_IDS)[number];

/** Numeric code of an ease id (what a built rig stores). */
export function easeCode(id: EaseId): number {
  const i = EASE_IDS.indexOf(id);
  if (i < 0) throw new Error(`articulation: unknown ease '${String(id)}'`);
  return i;
}

/**
 * The eased fraction for `t` (clamped to [0, 1]) under ease `code`.
 * Every curve maps 0 -> 0 and 1 -> 1 exactly.
 *  - linear: t
 *  - in:     cubic ease-in, t^3
 *  - out:    cubic ease-out, 1 - (1 - t)^3
 *  - inOut:  smoothstep, t^2 (3 - 2t)
 *  - step:   0 until the keyframe, then 1
 */
export function applyEase(code: number, t: number): number {
  if (!(t > 0)) return 0; // also maps NaN to 0
  if (t >= 1) return 1;
  switch (code) {
    case 1: return t * t * t;
    case 2: { const u = 1 - t; return 1 - u * u * u; }
    case 3: return t * t * (3 - 2 * t);
    case 4: return 0;
    default: return t;
  }
}
