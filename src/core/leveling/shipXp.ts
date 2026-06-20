/**
 * Per-ship-instance XP curve — pure, zone-blind (Phase 4 WS-B1, plan:
 * effervescent-umbrella).
 *
 * Ship XP is PER SHIP INSTANCE (locked decision D8): a veteran ship is
 * genuinely stronger, and switching ships switches your progression. The
 * server awards XP to the KILLER SHIP INSTANCE on `SHIP_DESTROYED`, weighted by
 * the victim's toughness (`maxHealth`), then runs this curve to decide whether
 * the kill crossed a level threshold.
 *
 * Zone-pure (`src/core`): no I/O, no allocation in the hot path beyond the one
 * small result literal `applyKillXp` returns (called only on a kill — a
 * LOW-frequency discrete event, never per-tick, so invariant #14's hot-loop
 * ban does not bite). Same inputs ⇒ same outputs on any caller; the server is
 * the only authority that runs it, but it lives in core for testability + so a
 * future client-side XP preview can read the same numbers.
 *
 * Tunables (D10 — capped, escalating; balance knobs, adjust on-device):
 *   - `XP_PER_KILL_DIVISOR` — XP per kill ≈ victim.maxHealth / K. Tougher
 *     enemies (gunship/capital, higher maxHealth) award proportionally more.
 *   - `XP_CURVE_BASE` / the `l^1.5` shape — each level costs more than the last.
 *   - `LEVEL_CAP` — hard ceiling (~10). At cap, XP stops accumulating and the
 *     progress bar pins to 0 (no overflow hoarding toward a non-existent level).
 */

/** Hard level ceiling. A ship can never exceed this (D10). */
export const LEVEL_CAP = 10;

/** XP per kill = round(victim.maxHealth / K), floored at 1. Lower K ⇒ faster
 *  levelling; this is a pure balance knob. */
export const XP_PER_KILL_DIVISOR = 40;

/** Base cost of the first level-up (level 1 → 2). The curve scales this by
 *  `level^1.5` (D10 — `xpToNext(l) = base · l^1.5`). */
export const XP_CURVE_BASE = 100;

/**
 * XP awarded for destroying a victim of the given hull cap. Linear in
 * `maxHealth` so a tougher ship (gunship/capital) is worth proportionally more
 * than a scout (D10). Always a non-negative integer, floored at 1 so even the
 * weakest victim grants a sliver of progress.
 */
export function xpForKill(victimMaxHealth: number): number {
  if (!(victimMaxHealth > 0)) return 1;
  const raw = Math.round(victimMaxHealth / XP_PER_KILL_DIVISOR);
  return raw < 1 ? 1 : raw;
}

/**
 * XP required to advance FROM `level` to `level + 1`. Escalating: each level
 * costs more (`base · level^1.5`). Returns `Infinity` at and beyond the cap so
 * the apply loop terminates cleanly (a capped ship can never gather enough).
 */
export function xpToNext(level: number): number {
  if (level >= LEVEL_CAP) return Infinity;
  return Math.round(XP_CURVE_BASE * Math.pow(level, 1.5));
}

/** Result of folding a kill's XP into a ship's progression. */
export interface XpApplyResult {
  /** New level (≥ prior level, ≤ LEVEL_CAP). */
  level: number;
  /** Carried XP toward the NEXT level after any level-ups (0 at cap). */
  xp: number;
  /** Number of level thresholds crossed by this award (0 = no level-up). */
  levelsGained: number;
}

/**
 * Fold a kill's XP award into a ship's `(level, xp)` progression.
 *
 * - Below threshold: accumulate `xp`, no level change.
 * - Crossing one or more thresholds: increment level (one per threshold,
 *   never double-counting a single kill), carrying the remainder XP into the
 *   new level. A single fat award can cross several thresholds at once.
 * - At `LEVEL_CAP`: pin `xp` to 0 and stop — no overflow hoarding.
 *
 * Pure: returns a fresh small result object; the caller owns persistence + the
 * `SHIP_LEVEL_UP` emit. A non-positive `gainedXp` is a no-op (returns the input
 * unchanged), so a 0-XP edge (e.g. a victim that resolved to 0 weight) never
 * mutates state.
 */
export function applyKillXp(level: number, xp: number, gainedXp: number): XpApplyResult {
  if (level >= LEVEL_CAP) return { level: LEVEL_CAP, xp: 0, levelsGained: 0 };
  if (!(gainedXp > 0)) return { level, xp, levelsGained: 0 };

  let curLevel = level;
  let curXp = xp + gainedXp;
  let gained = 0;

  // Cross as many thresholds as the accumulated XP allows, stopping at cap.
  while (curLevel < LEVEL_CAP) {
    const need = xpToNext(curLevel);
    if (curXp < need) break;
    curXp -= need;
    curLevel += 1;
    gained += 1;
  }

  if (curLevel >= LEVEL_CAP) curXp = 0; // no progress bar past the cap

  return { level: curLevel, xp: curXp, levelsGained: gained };
}
