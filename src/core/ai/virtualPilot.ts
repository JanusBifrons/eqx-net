/**
 * Virtual pilot (AI pilot layer, plan composed-harbor §0): turns what an NPC
 * brain WANTS (a facing angle and a velocity) into the control keys a player
 * would press this tick — thrust, reverse, turn left / right, boost — packed as
 * {@link AiInputBits}. The worker then runs those keys through the same
 * `applyShipInput` a pilot's keys go through, so an NPC has exactly a player's
 * controls and nothing else (owner rule 2026-11-13: no impulse, no angvel snap).
 *
 * Model (mirrors `physics/applyShipInput.ts`):
 * - Turning. Snap kinds: a held turn key sets angvel to ±maxAngvel, release
 *   stops the turn at once, so each tick held moves the nose maxAngvel·dt.
 *   The pilot presses like a player, not a servo ({@link easedSnapTurn}): it
 *   lets a small error ride (a dead-band of a few turn steps), holds a press
 *   for several ticks, lets go about a tick early so the nose stops on the
 *   heading, and never reverses within a few ticks of letting go (owner
 *   2026-11-14: the NPC turn was "sort of jerky and abrupt rather than a
 *   smooth turn": it tapped the key 1 tick on, 1–2 off, and hunted ±4°
 *   swapping left / right every tick).
 *   Torque kinds (capitals, `turnTorque`): a held key adds turnTorque/I of
 *   angvel per tick, angular damping bleeds it (ω ← ω/(1+c·dt) per step), so a
 *   released turn coasts ω/c further. The pilot stops early on that coast and
 *   counter-turns when even the coast would overshoot.
 * - Throttle: thrust pushes along the nose, reverse against it. The pilot
 *   presses whichever reduces the error between the wanted and actual velocity
 *   along the nose (bang-bang with a half-tick deadband); boost on top when the
 *   caller allows it and the nose is on the wanted course. Combat flying
 *   (`PilotParams.combatThrust`) holds thrust by default instead (owner
 *   2026-11-14: "everyone accelerates all the time in combat, unless they've
 *   got a reason not to"): see {@link pilotInputs}.
 *
 * Ship angle convention: forward = (-sin θ, cos θ); a direction (dx, dy) is the
 * facing atan2(-dx, dy).
 *
 * Pure, scalar in / caller-owned state, allocation-free (#14).
 */
import {
  AI_INPUT_BOOST,
  AI_INPUT_REVERSE,
  AI_INPUT_THRUST,
  AI_INPUT_TURN_LEFT,
  AI_INPUT_TURN_RIGHT,
  type AiInputBits,
} from '../contracts/IAiBehaviour.js';
import type { ShipKind } from '../../shared-types/shipKinds.js';
import { shipAngularInertia } from '../../shared-types/shipScale/tuning.js';

const TICK_DT = 1 / 60;

/** A kind's handling as the pilot needs it, derived once per behaviour. */
export interface PilotHandling {
  /** Turn cap (rad/s); a snap kind's held-turn rate. */
  maxAngvel: number;
  /** True for torque-turning kinds (capitals). */
  torqueTurn: boolean;
  /** Torque kinds: angvel gained per tick a turn key is held (rad/s). */
  turnAccel: number;
  /** Angular damping (1/s). */
  angularDamping: number;
  /** Speed gained per tick of thrust (u/s). */
  thrustAccel: number;
  /** Speed shed per tick of reverse (u/s); 0 if the kind has no reverse. */
  reverseAccel: number;
  /** Linear damping (1/s). */
  linearDamping: number;
  /** Speed clamp (u/s). */
  maxSpeed: number;
  /** Top speed on thrust alone: damping-limited terminal or the clamp. */
  cruiseSpeed: number;
}

/** Derive the pilot's view of `kind`'s handling for a body of `mass`. */
export function makePilotHandling(kind: ShipKind, mass: number): PilotHandling {
  const torque = kind.turnTorque ?? 0;
  const inertia = shipAngularInertia(mass, kind.radius);
  const thrustAccel = kind.thrustImpulse / mass;
  const d = kind.linearDamping;
  // Terminal speed under held thrust: v = (v + a)/(1 + d·dt) ⇒ v∞ = a/(d·dt).
  const terminal = d > 0 ? thrustAccel / (d * TICK_DT) : Infinity;
  return {
    maxAngvel: kind.maxAngvel,
    torqueTurn: torque > 0,
    turnAccel: torque > 0 && inertia > 0 ? torque / inertia : 0,
    angularDamping: kind.angularDamping,
    thrustAccel,
    reverseAccel: thrustAccel * kind.reverseFactor,
    linearDamping: d,
    maxSpeed: kind.maxSpeed,
    cruiseSpeed: Math.min(kind.maxSpeed, terminal),
  };
}

/** Per-ship pilot state (caller-owned, one per behaviour). */
export interface PilotState {
  /** Keys chosen last decision (held through the reaction latch). */
  bits: AiInputBits;
  /** Ticks left before the pilot decides again. */
  latch: number;
  /** Snap turn: the turn-key discipline's state ({@link easedSnapTurn}). */
  turn: SnapTurnState;
  /** Throttle key held now: 1 thrust, -1 reverse, 0 none. */
  throttle: number;
  /** Ticks the current throttle choice has been held. */
  throttleHeld: number;
}

export function makePilotState(): PilotState {
  return { bits: 0, latch: 0, turn: makeSnapTurnState(), throttle: 0, throttleHeld: 0 };
}

/** One snap turner's turn-key state (caller-owned). */
export interface SnapTurnState {
  /** Key held now: 1 left, -1 right, 0 none. */
  dir: number;
  /** Ticks the current press has lasted. */
  held: number;
  /** Ticks since the last press ended. */
  idle: number;
  /** Direction of the last press (0 before the first). */
  lastDir: number;
  /** The error smoothed over a couple of ticks (rad): what starts a press and
   *  bounds the minimum hold, so a heading that jitters a few steps tick to
   *  tick cannot set up a hunt. */
  smooth: number;
}

export function makeSnapTurnState(): SnapTurnState {
  return { dir: 0, held: 0, idle: 0, lastDir: 0, smooth: 0 };
}

/**
 * The turn-key discipline of a snap turner, in turn steps (one tick held =
 * maxAngvel·dt of turn) and ticks, so it follows any kind's turn rate:
 * - `deadbandSteps`: an error under this many steps is left alone (no taps);
 * - `minHoldTicks`: a press lasts at least this long, as long as the swing
 *   past the heading stays inside the dead-band (a short correction becomes
 *   one deliberate press that stops a little past, then rests);
 * - `noReverseTicks`: no press the other way within this many ticks of
 *   letting go (no left / right hunting).
 * A press ends about a tick early, once less than half a step is left (the
 * error the pilot sees already includes its lead), so the nose stops on the
 * heading rather than past it. Starting a press and the minimum hold read the
 * error smoothed over ~2 ticks (`smoothKeep`; a jump of more than 90° is taken
 * at once), so a heading that jitters tick to tick (measured: ±4° every tick
 * for ~50 ticks) sets up no taps and no left / right swaps.
 */
export const SNAP_TURN_EASE = { deadbandSteps: 2.5, minHoldTicks: 5, noReverseTicks: 6, smoothKeep: 0.5 } as const;

/**
 * The turn key a snap turner presses this tick: 1 left, -1 right, 0 none.
 * `err` is the facing error the pilot acts on (rad, positive = turn left;
 * the caller adds its own lead), `step` one tick's turn (maxAngvel·dt) and
 * `minDeadband` a floor on the dead-band (rad). Writes `st`. Pure and
 * allocation-free, so any pilot (an NPC brain, a wingman) can use it.
 */
export function easedSnapTurn(st: SnapTurnState, err: number, step: number, minDeadband = 0): number {
  const ease = SNAP_TURN_EASE;
  let band = ease.deadbandSteps * step;
  if (band < minDeadband) band = minDeadband;
  const jump = err - st.smooth;
  st.smooth = jump > Math.PI / 2 || jump < -Math.PI / 2 ? err : st.smooth * ease.smoothKeep + err * (1 - ease.smoothKeep);
  const sm = st.smooth;
  if (st.dir !== 0) {
    st.held++;
    // Turn still to go along the press (negative: already past the heading).
    const togo = err * st.dir;
    // Keep pressing while at least half a step is left; inside the minimum
    // hold, while this tick's turn leaves the nose less than a dead-band past.
    if (togo >= 0.5 * step || (st.held <= ease.minHoldTicks && sm * st.dir - step > -band)) return st.dir;
    st.lastDir = st.dir;
    st.dir = 0;
    st.idle = 0;
  }
  st.idle++;
  const absErr = sm < 0 ? -sm : sm;
  if (absErr <= band) return 0;
  const want = sm > 0 ? 1 : -1;
  if (want !== st.lastDir && st.lastDir !== 0 && st.idle <= ease.noReverseTicks) return 0;
  st.dir = want;
  st.held = 1;
  return want;
}

/** Tunables of one call; plain numbers so a caller can keep one const record. */
export interface PilotParams {
  /** Facing error (rad) accepted as on-heading. Snap kinds never use less than
   *  half a tick's turn (the turn cannot be finer than one tick), and once on
   *  the heading resume only past this plus one tick's turn. */
  deadzone: number;
  /** The pilot's view of its own pose lags the body by this many ticks (the
   *  server reads the last physics step, keys land on the next): it predicts
   *  its angle forward by ω·dt·leadTicks before deciding. */
  leadTicks: number;
  /** Thrust only while cos(nose, wanted course) ≥ this (when a course is
   *  wanted); -1 = any nose. Reverse has no cone: it always sheds speed along
   *  the nose. */
  thrustConeCos: number;
  /** Boost only while cos(nose, wanted course) ≥ this. */
  boostConeCos: number;
  /** Boost only while the wanted speed along the nose exceeds the actual by at
   *  least this share of the kind's max speed. */
  boostSpeedGap: number;
  /** Reaction latch: hold each decision this many extra ticks (0 = decide
   *  every tick). A per-role difficulty knob. */
  reactionTicks: number;
  /** Combat throttle: thrust is held by default and speed is managed by
   *  turning. Let go only when the wanted speed is below the actual by
   *  `combatSlackFrac` × cruise (the manoeuvre's named reason: a pass about to
   *  overshoot, a station to arrive at, a stand-off to hold); reverse only
   *  when it is below by twice that and the velocity runs along the nose. */
  combatThrust: boolean;
  /** Combat throttle slack, as a share of the kind's cruise speed. */
  combatSlackFrac: number;
  /** A throttle choice (thrust / none / reverse) is held at least this many
   *  ticks before it may change (0 = free): no on/off chatter. */
  throttleHoldTicks: number;
}

export const DEFAULT_PILOT_PARAMS: Readonly<PilotParams> = {
  deadzone: 0.02,
  leadTicks: 1,
  thrustConeCos: 0,
  boostConeCos: 0.95,
  boostSpeedGap: 0.25,
  reactionTicks: 0,
  combatThrust: false,
  combatSlackFrac: 0.1,
  throttleHoldTicks: 0,
};

/** Wrap an angle into [-π, π]. */
export function wrapAngle(rad: number): number {
  let r = rad;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

/** The facing that points along (dx, dy). */
export function facingOf(dx: number, dy: number): number {
  return Math.atan2(-dx, dy);
}

/**
 * The highest speed from which the ship can still stop within `dist`, braking
 * with reverse plus damping while its nose points along the way it is going
 * (`safety` < 1 leaves margin). Conservative: the larger of the two braking
 * terms alone, never their sum.
 */
export function brakingSpeed(h: PilotHandling, dist: number, safety = 0.8): number {
  if (dist <= 0) return 0;
  const a = h.reverseAccel / TICK_DT; // u/s²
  const byReverse = Math.sqrt(2 * a * dist);
  const byDamping = h.linearDamping * dist;
  return safety * Math.max(byReverse, byDamping);
}

/** Turn keys toward `desired` (one of AI_INPUT_TURN_LEFT/RIGHT, or 0). */
function turnBits(h: PilotHandling, st: PilotState, p: PilotParams, angle: number, angvel: number, desired: number): number {
  const lead = angvel * TICK_DT * p.leadTicks;
  const err = wrapAngle(desired - (angle + lead));
  const sign = err >= 0 ? 1 : -1;
  const toward = sign > 0 ? AI_INPUT_TURN_LEFT : AI_INPUT_TURN_RIGHT;
  const away = sign > 0 ? AI_INPUT_TURN_RIGHT : AI_INPUT_TURN_LEFT;
  const absErr = Math.abs(err);
  if (!h.torqueTurn) {
    // Snap turn: a held key moves the nose one tick's turn, release stops it.
    const k = easedSnapTurn(st.turn, err, h.maxAngvel * TICK_DT, p.deadzone);
    return k > 0 ? AI_INPUT_TURN_LEFT : k < 0 ? AI_INPUT_TURN_RIGHT : 0;
  }
  // Torque turners (capitals) keep the coast planner below: a released key
  // coasts on under angular damping, so the turn is smooth on screen already
  // and a tap only nudges the spin; the snap-turn discipline would add lag.
  // Torque turn: plan around the coast a release leaves.
  const c = h.angularDamping;
  const dw = h.turnAccel;
  const closing = angvel * sign; // > 0: already turning toward the heading
  const tol = p.deadzone;
  if (closing <= 0) {
    // Turning away (or not at all): press toward unless already there and slow.
    if (absErr > tol || -closing > dw) return toward;
    return 0;
  }
  // Coast after release: ω/c (Σ ω·k^n·dt with k = 1/(1+c·dt)).
  const coastNow = c > 0 ? closing / c : Infinity;
  // Brake-by-counter-turn distance (no damping, conservative).
  const counter = dw > 0 ? (closing * closing) / (2 * dw / TICK_DT) : Infinity;
  const stopNow = Math.min(coastNow, counter);
  if (stopNow > absErr + tol) return away; // would overshoot: counter-turn
  // One more tick held: the coast from the faster spin, plus this tick's travel.
  const w1 = Math.min(closing + dw, h.maxAngvel) / (1 + c * TICK_DT);
  const coastNext = (c > 0 ? w1 / c : Infinity) + closing * TICK_DT;
  const counterNext = dw > 0 ? (w1 * w1) / (2 * dw / TICK_DT) + closing * TICK_DT : Infinity;
  if (Math.min(coastNext, counterNext) <= absErr) return toward;
  return 0;
}

/**
 * One tick of the pilot: the keys that turn the nose to `facing` and bring the
 * velocity to (`wantVx`, `wantVy`). `boostOk` is the caller's allowance (far
 * from the goal and the energy to pay for a tick); the pilot adds its own
 * conditions (nose on course, a real speed gap). Writes `st` (the latch).
 */
export function pilotInputs(
  h: PilotHandling,
  st: PilotState,
  p: PilotParams,
  angle: number,
  angvel: number,
  vx: number,
  vy: number,
  facing: number,
  wantVx: number,
  wantVy: number,
  boostOk: boolean,
): AiInputBits {
  if (st.latch > 0) {
    st.latch--;
    return st.bits;
  }
  let bits = turnBits(h, st, p, angle, angvel, facing);

  const fx = -Math.sin(angle);
  const fy = Math.cos(angle);
  const ex = wantVx - vx;
  const ey = wantVy - vy;
  const along = ex * fx + ey * fy;
  const wantSpeed = Math.hypot(wantVx, wantVy);
  // cos(nose, wanted course); 1 when no course is wanted (hold / brake).
  const cosCourse = wantSpeed > 1e-6 ? (wantVx * fx + wantVy * fy) / wantSpeed : 1;
  let throttle: number;
  if (p.combatThrust) {
    // Combat: thrust held by default; speed is managed by turning. Let go
    // only when the wanted speed is clearly below the actual (the
    // manoeuvre's reason: a pass about to overshoot, a station, a
    // stand-off); reverse only when well below with the velocity along the
    // nose; never thrust with the nose off the course (it would push the
    // wrong way).
    const speed = Math.hypot(vx, vy);
    const slack = p.combatSlackFrac * h.cruiseSpeed;
    const brake = h.reverseAccel > 0 && along < -h.reverseAccel * 0.5;
    if (cosCourse < p.thrustConeCos) throttle = brake ? -1 : 0;
    else if (wantSpeed >= speed - slack) throttle = 1;
    else if (brake && wantSpeed < speed - 2 * slack) throttle = -1;
    else throttle = 0;
  } else if (along > h.thrustAccel * 0.5 && cosCourse >= p.thrustConeCos) {
    throttle = 1;
  } else if (h.reverseAccel > 0 && along < -h.reverseAccel * 0.5) {
    throttle = -1;
  } else {
    throttle = 0;
  }
  // No chatter: a throttle choice stands for `throttleHoldTicks`.
  if (throttle !== st.throttle && st.throttleHeld > 0 && st.throttleHeld < p.throttleHoldTicks) throttle = st.throttle;
  if (throttle === st.throttle) st.throttleHeld++;
  else {
    st.throttle = throttle;
    st.throttleHeld = 1;
  }
  if (throttle > 0) {
    bits |= AI_INPUT_THRUST;
    if (boostOk && cosCourse >= p.boostConeCos && along >= h.maxSpeed * p.boostSpeedGap) {
      bits |= AI_INPUT_BOOST;
    }
  } else if (throttle < 0) {
    bits |= AI_INPUT_REVERSE;
  }

  st.bits = bits;
  st.latch = p.reactionTicks;
  return bits;
}
