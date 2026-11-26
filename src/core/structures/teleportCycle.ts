/**
 * The teleporter jump cycle and firing rules (plan soft-leaping-truffle v4,
 * T1). Pure, server-side decision logic; the server owns the cycle and the
 * client reads the phase from room state.
 *
 * A pair runs ONE cycle together (both pads arm, close, seal, swap and open
 * at the same moments). The initiator spends its charge at the swap; if it
 * no longer has enough then, the swap is cancelled and both pads reopen.
 */
import { TP_PHASE, TP_PHASE_MS, nextTpPhase, SHIP_BOARD_DWELL_MS, type TeleportRules, type TpPhase } from '../../shared-types/teleport.js';
import type { GoodId } from '../../shared-types/goods.js';

export interface CycleState {
  phase: TpPhase;
  /** When the current phase ends (ms; unused while idle). */
  phaseEndsAtMs: number;
}

/** Start a cycle (idle → armed). `scale` speeds phases up (tests). */
export function armCycle(s: CycleState, nowMs: number, scale = 1): void {
  s.phase = TP_PHASE.ARMED;
  s.phaseEndsAtMs = nowMs + TP_PHASE_MS[1] * scale;
}

/**
 * The chamber doors of BOTH pads of a pair (teleporter redesign T2), as the
 * cycle sees them. Absent: the pads have no doors (the Ancients' gate) and
 * CLOSING ends on its timer as always.
 */
export interface CycleDoors {
  /** Both pads' doors are fully shut. */
  shut: boolean;
  /** A pad's doors cannot move (power level 0) and are not shut. */
  stalled: boolean;
}

/**
 * Advance a running cycle. Returns `'swap'` exactly when SEALED ends (the
 * caller swaps the pads, then the cycle is OPEN), `'done'` when OPEN ends,
 * else null. Never skips a swap, even after a long gap.
 *
 * With `doors` (chamber pads), CLOSING ignores its timer: it ends when both
 * pads' doors are shut (doors move at their grid's power level, so a weak
 * grid closes slowly). A pad whose doors stall (no power) before they are
 * shut cancels the jump: straight to OPEN, no swap, returns `'cancel'` (as a
 * lost charge skips the swap).
 */
export function stepCycle(
  s: CycleState, nowMs: number, scale = 1, doors?: Readonly<CycleDoors>,
): 'swap' | 'done' | 'cancel' | null {
  if (s.phase === TP_PHASE.IDLE) return null;
  if (doors !== undefined && s.phase === TP_PHASE.CLOSING) {
    if (doors.shut) {
      s.phase = TP_PHASE.SEALED;
      s.phaseEndsAtMs = nowMs + TP_PHASE_MS[3] * scale;
      return null;
    }
    if (!doors.stalled) return null;
    s.phase = TP_PHASE.OPEN;
    s.phaseEndsAtMs = nowMs + TP_PHASE_MS[4] * scale;
    return 'cancel';
  }
  if (nowMs < s.phaseEndsAtMs) return null;
  const leaving = s.phase;
  s.phase = nextTpPhase(leaving);
  if (s.phase !== TP_PHASE.IDLE) s.phaseEndsAtMs = nowMs + TP_PHASE_MS[s.phase as 1 | 2 | 3 | 4] * scale;
  if (leaving === TP_PHASE.SEALED) return 'swap';
  if (leaving === TP_PHASE.OPEN) return 'done';
  return null;
}

/** What the rules can see about one pad. */
export interface RuleInputs {
  charged: boolean;
  /** How long an admitted ship has sat on the pad (ms; 0 = none). */
  boardedForMs: number;
  /** Pad hold contents. */
  padGoods: Readonly<Partial<Record<GoodId, number>>>;
  padWeight: number;
}

/**
 * Does a pad's own rules say "fire now"? Charge is always required; the
 * first rule met fires. (Manual firing is a button, not a rule.)
 */
export function rulesSayFire(rules: TeleportRules, inp: RuleInputs): boolean {
  if (!inp.charged) return false;
  if (rules.whenCharged) return true;
  if (rules.shipBoards && inp.boardedForMs >= SHIP_BOARD_DWELL_MS) return true;
  if (rules.loaded !== null) {
    const have = rules.loaded.good === null ? inp.padWeight : (inp.padGoods[rules.loaded.good] ?? 0);
    if (have >= rules.loaded.qty) return true;
  }
  return false;
}
