/**
 * The Ancients' gate "Astrolabe" (teleporter redesign A1): three nested stone
 * rings round the gate's crystal, each three arc segments with three gaps
 * ("lanes") 120° apart. They turn at different speeds and directions, slow
 * into line before each timetabled jump (a visible swing) so the lanes open, hold aligned
 * through the jump cycle, then drift apart again. LOOKS ONLY: the rings are
 * cosmetic spin hinges (`rigs/transport.ts`, `ALIEN_GATE_ASTROLABE_DEF`), so
 * no collider, hit box, nav or physics change; ships fly under them (the
 * rig's `over` layer: stone arches over the lanes). (The inner ring's seal while SEALED is the gate's iris, not this rig: redesign
 * A3, `alienGateSeal.ts`.)
 *
 * One clock drives all three rings: ring i's angle is `spin_i * clock`, so a
 * clock of 0 lines every lane up, and slowing the clock slows every ring
 * together. Each ring turns a whole number of turns per timetable interval
 * (`ASTROLABE_RINGS[i].turns`), so the clock wraps back to 0 at the next jump
 * with no jump in any angle. The client feeds `clockTicks` to the rig view's
 * spin clock (`StructureRigView.spinClock`) instead of letting it run free.
 *
 * Pure and deterministic: the pose comes only from the game time, the pair's
 * timetable offset (`alienGateOffsetMs`) and the live phase on the wire, so a
 * late joiner sees the same angles as everyone else (invariant #16). No
 * allocation per call (#14): the caller owns the `AstrolabePose`.
 */
import { ALIEN_GATE_CYCLE_SCALE, ALIEN_GATE_INTERVAL_MS, TP_PHASE, TP_PHASE_MS } from '../../shared-types/teleport.js';
import { ALIEN_GATE_INNER_RING_RADIUS, ALIEN_GATE_INNER_RING_WIDTH } from '../../shared-types/alienGateSeal.js';

/** Game ticks per second (the spin clock and the rig's spin rates use ticks). */
const TICKS_PER_MS = 60 / 1000;

/** How long an alien gate's jump cycle runs (ms, unscaled): armed + closing +
 *  sealed + open at `ALIEN_GATE_CYCLE_SCALE` (~5 s). The rings hold aligned
 *  through all of it. */
export const ASTROLABE_CYCLE_MS = (TP_PHASE_MS[1] + TP_PHASE_MS[2] + TP_PHASE_MS[3] + TP_PHASE_MS[4]) * ALIEN_GATE_CYCLE_SCALE;
/** The rings are in line this long before the gate fires (ms; taste). */
export const ASTROLABE_PRE_HOLD_MS = 1500;
/** They swing into line over this long before that (ms; taste): a visible
 *  spin-up and brake, like a combination lock (owner, take 19: the rings
 *  must be SEEN to line up before the jump; the B mock-up's 2.5 s swing). */
export const ASTROLABE_SETTLE_MS = 3000;
/** Spin clock the swing covers (ms of full-speed running; taste): more than
 *  the window, so the rings speed up before they brake into line. */
export const ASTROLABE_SETTLE_RUN_MS = 5000;
/** And speed back up over this long after the cycle (ms; taste). */
export const ASTROLABE_RELEASE_MS = 4000;

/** Free-running time between release and settle (ms). */
const FREE_MS = ALIEN_GATE_INTERVAL_MS - ASTROLABE_CYCLE_MS - ASTROLABE_RELEASE_MS - ASTROLABE_SETTLE_MS - ASTROLABE_PRE_HOLD_MS;
/** Spin clock run over one interval (ticks): full speed through the free
 *  stretch, half (a linear speed ramp) through release, the swing's run. */
export const ASTROLABE_CLOCK_PERIOD_TICKS =
  (ASTROLABE_RELEASE_MS / 2 + FREE_MS + ASTROLABE_SETTLE_RUN_MS) * TICKS_PER_MS;
/** The swing's speed bump: speed(τ) = (1 − τ/W) + A·sin(πτ/W) runs
 *  ASTROLABE_SETTLE_RUN_MS of clock over the window W, starting at full
 *  speed and ending stopped. */
const SWING_A = ((ASTROLABE_SETTLE_RUN_MS - ASTROLABE_SETTLE_MS / 2) * Math.PI) / (2 * ASTROLABE_SETTLE_MS);

/** Gap ("lane") width at each ring's radius (world units; taste). */
export const ASTROLABE_LANE_WIDTH = 240;
/** Lanes per ring, evenly spaced (lane centres at 0, 120°, 240° in the ring's frame). */
export const ASTROLABE_LANES = 3;

export interface AstrolabeRing {
  /** Rig part id (`ALIEN_GATE_ASTROLABE_DEF`). */
  readonly part: string;
  /** Centre-line radius and band width (world units, 1600-wide gate). */
  readonly radius: number;
  readonly width: number;
  /** Whole turns per timetable interval, signed (+ counter-clockwise). */
  readonly turns: number;
  /** Lane gap angle (rad) at this radius. */
  readonly gap: number;
  /** Spin rate (rad per spin-clock tick) for the rig's `PartDef.spin`. */
  readonly spin: number;
}

function ring(part: string, radius: number, width: number, turns: number): AstrolabeRing {
  return {
    part, radius, width, turns,
    gap: ASTROLABE_LANE_WIDTH / radius,
    spin: (turns * 2 * Math.PI) / ASTROLABE_CLOCK_PERIOD_TICKS,
  };
}

/** Outer, middle, inner (taste: radii/widths from the approved B mock-up;
 *  turns +1 / -2 / +3 so each ring has its own speed and the middle one
 *  runs against the others). The inner ring's size is shared with its seal
 *  (`alienGateSeal.ts`, redesign A3): while SEALED it is a solid circle round
 *  the light pool, the ride area. */
export const ASTROLABE_RINGS: readonly AstrolabeRing[] = [
  ring('ring-outer', 780, 76, 1),
  ring('ring-mid', 610, 66, -2),
  ring('ring-inner', ALIEN_GATE_INNER_RING_RADIUS, ALIEN_GATE_INNER_RING_WIDTH, 3),
];

/** When the jump swaps the riders across (ms after the fire, unscaled): the
 *  end of SEALED. The gate's flash peaks here (`ASTROLABE_FX_PARTS`). */
export const ASTROLABE_SWAP_MS = (TP_PHASE_MS[1] + TP_PHASE_MS[2] + TP_PHASE_MS[3]) * ALIEN_GATE_CYCLE_SCALE;

/** Light-only parts of the gate's rig (the approved B mock-up's effects;
 *  owner, take 19: "no indication you had warped"): no joint motion, no
 *  spin, no outline; the client fades and scales them per frame from the
 *  timetable (`RigDrawHook.partShow`). `under` = on the floor, under the
 *  ships; `over` = over everything at the gate (the flash).
 *  - lanes: three light beams out through the lane gaps;
 *  - pool-0..4: the hex wireframe in five bands from the centre out, lit by
 *    waves running outward;
 *  - crystal: the crystal's glow;
 *  - flash: the jump flash; wave-0..2: rings of light thrown out by it. */
export const ASTROLABE_FX_PARTS: readonly { readonly part: string; readonly layer: 'under' | 'over' }[] = [
  { part: 'fx-lanes', layer: 'under' },
  { part: 'fx-pool-0', layer: 'under' },
  { part: 'fx-pool-1', layer: 'under' },
  { part: 'fx-pool-2', layer: 'under' },
  { part: 'fx-pool-3', layer: 'under' },
  { part: 'fx-pool-4', layer: 'under' },
  { part: 'fx-crystal', layer: 'under' },
  { part: 'fx-flash', layer: 'over' },
  { part: 'fx-wave-0', layer: 'over' },
  { part: 'fx-wave-1', layer: 'over' },
  { part: 'fx-wave-2', layer: 'over' },
];

/** The rings' pose at a moment (caller-owned scratch, `createAstrolabePose`). */
export interface AstrolabePose {
  /** Spin clock (game ticks) for the rig view: ring i turns `spin_i * clockTicks`. */
  clockTicks: number;
  /** Ring angles (rad, wrapped to [-π, π)), in `ASTROLABE_RINGS` order. */
  readonly angles: Float64Array;
  /** 1 while the lanes are held in line, falling to 0 at full running speed
   *  (an art hook: glyph glow, light pool). */
  settle: number;
  /** Lanes exactly in line (held: pre-hold, or the jump cycle). */
  aligned: boolean;
  /** Time since the last timetabled fire (ms, unscaled; 0 = the cycle
   *  starts): the gate's effects (charge, flash) run on it. */
  sinceFireMs: number;
}

export function createAstrolabePose(): AstrolabePose {
  return { clockTicks: 0, angles: new Float64Array(ASTROLABE_RINGS.length), settle: 1, aligned: true, sinceFireMs: 0 };
}

function wrap(a: number): number {
  const TAU = 2 * Math.PI;
  return a - TAU * Math.floor((a + Math.PI) / TAU);
}

/**
 * The rings' pose at game time `nowMs` for a pair whose timetable offset is
 * `offsetMs` (`alienGateOffsetMs`). `tpPhase` (the gate's live phase on the
 * wire) wins while a cycle runs: any phase but IDLE holds the lanes exactly in
 * line, whatever this clock says, so clock drift or the server's test speed-up
 * never shows rings out of line during a jump. (The phase's remaining time is
 * not needed: the hold covers the whole cycle.) `scale` is the server's test
 * speed-up (`cycleScale`); clients pass 1. Writes `out`; returns it.
 */
export function astrolabePoseAt(out: AstrolabePose, nowMs: number, offsetMs: number, tpPhase = TP_PHASE.IDLE as number, scale = 1): AstrolabePose {
  const interval = ALIEN_GATE_INTERVAL_MS * scale;
  // Time since the last timetabled fire, back in unscaled ms.
  let u = (nowMs - (offsetMs % ALIEN_GATE_INTERVAL_MS) * scale) % interval;
  if (u < 0) u += interval;
  u /= scale;

  out.sinceFireMs = u;
  let clockMs = 0;
  let speed = 0; // fraction of full speed
  if (tpPhase === TP_PHASE.IDLE && u > ASTROLABE_CYCLE_MS) {
    const releaseEnd = ASTROLABE_CYCLE_MS + ASTROLABE_RELEASE_MS;
    const settleStart = releaseEnd + FREE_MS;
    const settleEnd = settleStart + ASTROLABE_SETTLE_MS;
    if (u < releaseEnd) {
      const t = u - ASTROLABE_CYCLE_MS;
      speed = t / ASTROLABE_RELEASE_MS;
      clockMs = (t * speed) / 2;
    } else if (u < settleStart) {
      speed = 1;
      clockMs = ASTROLABE_RELEASE_MS / 2 + (u - releaseEnd);
    } else if (u < settleEnd) {
      // The swing: a speed bump, then a brake into line.
      const t = u - settleStart, W = ASTROLABE_SETTLE_MS, k = Math.PI / W;
      clockMs = ASTROLABE_RELEASE_MS / 2 + FREE_MS + t - (t * t) / (2 * W) + (SWING_A / k) * (1 - Math.cos(k * t));
      out.clockTicks = clockMs * TICKS_PER_MS;
      out.settle = t / W; // the glow ramps through the swing
      out.aligned = false;
      fillAngles(out);
      return out;
    }
    // else: pre-hold, the clock has wrapped to 0 (every ring a whole number of turns).
  }
  const clock = clockMs * TICKS_PER_MS;
  out.clockTicks = clock;
  out.settle = 1 - speed;
  out.aligned = clockMs === 0;
  fillAngles(out);
  return out;
}

function fillAngles(out: AstrolabePose): void {
  const angles = out.angles, clock = out.clockTicks;
  for (let i = 0; i < ASTROLABE_RINGS.length; i++) angles[i] = wrap(ASTROLABE_RINGS[i]!.spin * clock);
}
