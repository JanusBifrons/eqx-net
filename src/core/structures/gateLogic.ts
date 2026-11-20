/**
 * Gate open/close logic — zone-pure (plan soft-leaping-truffle v2, phase V gates).
 *
 * The server runs this on the 10 Hz structure tick; the client never predicts
 * it (it reads the open state from room state). Occupancy is built from ship
 * positions in the gate's LOCAL frame (`worldToLocal` in gateGeometry.ts).
 *
 *   Shield Gate: opens while a ship it ADMITS is in the approach zone; closes
 *   GATE_CLOSE_HOLD_MS after the zone empties.
 *
 *   Shield Airlock: one `phase` field (closed / open A / open B), so both ends
 *   are never TARGETED open at once. A ship waiting outside an end opens that
 *   end; once every ship inside is clear of that span, it closes; then the far
 *   end opens to let them out.
 *
 * Solid doors (plan door-power, slice 7): the open/shut decision above is each
 * door's TARGET. Every door has a motion segment (`DoorTrack`, doorMotion.ts)
 * that travels there at the grid power level L (3 s at full power; L 0 freezes
 * it). Hold timers count from the door's ARRIVAL fully open, not from the
 * decision. An airlock end starts opening only once the other end is fully
 * shut (position 0), so both doors are never open at once. There is no
 * "never close on a ship" hold: the leaves are kinematic and shove ships out
 * (owner, round 3).
 */
import {
  AIRLOCK_CYCLE_HOLD_MS,
  AIRLOCK_END_Y,
  GATE_APPROACH_DEPTH,
  GATE_CLOSE_HOLD_MS,
  GATE_SPAN_THICKNESS,
  gateGapHalf,
  type GateType,
} from './gateGeometry.js';
import { GATE_W } from '../../shared-types/structureKinds/gatePosts.js';
import { doorFullyOpen, doorMoving, doorPosAt, driveDoor, newDoorTrack, type DoorTrack } from './doorMotion.js';

/** Open bits: bit 0 = the gate / airlock end A, bit 1 = airlock end B.
 *  Never 3 (both ends). */
export const GATE_OPEN_A = 1;
export const GATE_OPEN_B = 2;

/** Half the gate's full width (tower outer edge to centre). */
const GATE_HALF_W = GATE_W / 2;

/** Per-tick occupancy of a gate (reset with `clearOccupancy`). */
export interface GateOccupancy {
  /** Gate: an admitted ship is in the approach zone. */
  admittedNear: boolean;
  /** Airlock: an admitted ship waits outside end A / end B. */
  waitA: boolean;
  waitB: boolean;
  /** Airlock: an admitted ship is in the chamber. */
  inside: boolean;
  /** Airlock: every ship in the chamber is clear of span A / span B. */
  insideClearA: boolean;
  insideClearB: boolean;
}

export function newOccupancy(): GateOccupancy {
  return { admittedNear: false, waitA: false, waitB: false, inside: false, insideClearA: true, insideClearB: true };
}

export function clearOccupancy(o: GateOccupancy): void {
  o.admittedNear = false;
  o.waitA = false;
  o.waitB = false;
  o.inside = false;
  o.insideClearA = true;
  o.insideClearB = true;
}

/** Add one ship (local position lx, ly; radius r) to a gate's occupancy. */
export function addShipToOccupancy(type: GateType, lx: number, ly: number, r: number, admitted: boolean, o: GateOccupancy): void {
  const gapHalf = gateGapHalf(type);
  const bandHalf = GATE_SPAN_THICKNESS / 2 + r;
  if (type === 'gate') {
    if (admitted && Math.abs(lx) <= GATE_HALF_W + r && Math.abs(ly) <= GATE_APPROACH_DEPTH) o.admittedNear = true;
    return;
  }
  const yA = AIRLOCK_END_Y;
  const inChamber = Math.abs(lx) <= gapHalf && Math.abs(ly) <= yA;
  if (inChamber) {
    if (admitted) o.inside = true;
    if (ly >= yA - bandHalf) o.insideClearA = false;
    if (ly <= -yA + bandHalf) o.insideClearB = false;
    return;
  }
  if (!admitted || Math.abs(lx) > GATE_HALF_W + r) return;
  if (ly > yA && ly <= yA + GATE_APPROACH_DEPTH) o.waitA = true;
  else if (ly < -yA && ly >= -yA - GATE_APPROACH_DEPTH) o.waitB = true;
}

/** Shield Gate state. `open` is the door's target; `door` its motion. */
export interface GateState {
  open: boolean;
  lastBusyMs: number;
  readonly door: DoorTrack;
}

export function newGateState(nowMs = 0): GateState {
  return { open: false, lastBusyMs: nowMs, door: newDoorTrack() };
}

/** Step a gate at wall time `nowMs`, game tick `tick` and power level
 *  `level` (0..15). Returns true when the door's segment changed. */
export function stepGate(s: GateState, o: GateOccupancy, nowMs: number, tick: number, level: number): boolean {
  if (o.admittedNear) {
    s.open = true;
    s.lastBusyMs = nowMs;
  } else if (s.open) {
    if (!doorFullyOpen(s.door, tick)) s.lastBusyMs = nowMs; // the hold starts on arrival
    else if (nowMs - s.lastBusyMs >= GATE_CLOSE_HOLD_MS) s.open = false;
  }
  return driveDoor(s.door, s.open, level, tick, nowMs);
}

export const AIRLOCK_CLOSED = 0;
export const AIRLOCK_OPEN_A = 1;
export const AIRLOCK_OPEN_B = 2;
const END_NONE = 0;
const END_A = 1;
const END_B = 2;

/** Shield Airlock state. `exitTo` is the end the ships inside will leave by;
 *  `phase` is the doors' target; `doorA` / `doorB` their motion. */
export interface AirlockState {
  phase: number;
  exitTo: number;
  lastBusyMs: number;
  readonly doorA: DoorTrack;
  readonly doorB: DoorTrack;
}

export function newAirlockState(): AirlockState {
  return { phase: AIRLOCK_CLOSED, exitTo: END_NONE, lastBusyMs: 0, doorA: newDoorTrack(), doorB: newDoorTrack() };
}

/** Step an airlock (see `stepGate` for the arguments). Returns true when
 *  either door's segment changed. */
export function stepAirlock(s: AirlockState, o: GateOccupancy, nowMs: number, tick: number, level: number): boolean {
  decideAirlock(s, o, nowMs, tick);
  // Shut the untargeted end first, then open the targeted one only once the
  // other end reads position 0 (interlock: both open is impossible).
  const wantA = s.phase === AIRLOCK_OPEN_A;
  const wantB = s.phase === AIRLOCK_OPEN_B;
  let changed = false;
  if (!wantA) changed = driveDoor(s.doorA, false, level, tick, nowMs);
  if (!wantB) changed = driveDoor(s.doorB, false, level, tick, nowMs) || changed;
  if (wantA) changed = driveDoor(s.doorA, doorPosAt(s.doorB.seg, tick) === 0, level, tick, nowMs) || changed;
  if (wantB) changed = driveDoor(s.doorB, doorPosAt(s.doorA.seg, tick) === 0, level, tick, nowMs) || changed;
  return changed;
}

/** The open/shut decision (the doors' target `phase`). */
function decideAirlock(s: AirlockState, o: GateOccupancy, nowMs: number, tick: number): void {
  if (s.phase === AIRLOCK_CLOSED) {
    if (o.inside) {
      // Let the ships inside out. With no recorded direction, pick the end no
      // one is waiting at (B by default).
      const exit = s.exitTo !== END_NONE ? s.exitTo : (o.waitB && !o.waitA ? END_A : END_B);
      s.exitTo = exit;
      s.phase = exit === END_A ? AIRLOCK_OPEN_A : AIRLOCK_OPEN_B;
      s.lastBusyMs = nowMs;
      return;
    }
    if (o.waitA) { s.phase = AIRLOCK_OPEN_A; s.exitTo = END_B; s.lastBusyMs = nowMs; return; }
    if (o.waitB) { s.phase = AIRLOCK_OPEN_B; s.exitTo = END_A; s.lastBusyMs = nowMs; return; }
    s.exitTo = END_NONE;
    return;
  }
  const end = s.phase === AIRLOCK_OPEN_A ? END_A : END_B;
  const wait = end === END_A ? o.waitA : o.waitB;
  const clear = end === END_A ? o.insideClearA : o.insideClearB;
  if (!doorFullyOpen(end === END_A ? s.doorA : s.doorB, tick)) s.lastBusyMs = nowMs; // holds start on arrival
  if (s.exitTo !== end) {
    // Entering through this end.
    if (o.inside && clear && !wait) {
      if (nowMs - s.lastBusyMs >= AIRLOCK_CYCLE_HOLD_MS) s.phase = AIRLOCK_CLOSED; // the far end opens next tick
      return;
    }
    if (wait || o.inside) { s.lastBusyMs = nowMs; return; }
    if (nowMs - s.lastBusyMs >= GATE_CLOSE_HOLD_MS) { s.phase = AIRLOCK_CLOSED; s.exitTo = END_NONE; }
    return;
  }
  // Leaving through this end.
  if (o.inside) { s.lastBusyMs = nowMs; return; }
  if (wait) { s.exitTo = end === END_A ? END_B : END_A; s.lastBusyMs = nowMs; return; } // someone wants in from this side
  if (nowMs - s.lastBusyMs >= GATE_CLOSE_HOLD_MS) { s.phase = AIRLOCK_CLOSED; s.exitTo = END_NONE; }
}

/** Target open mask for a gate or airlock state (the decision, not the door
 *  position: see `gateFullyOpenMask`). */
export function gateOpenMask(gate: GateState | undefined, airlock: AirlockState | undefined): number {
  if (gate) return gate.open ? GATE_OPEN_A : 0;
  if (airlock) return airlock.phase === AIRLOCK_OPEN_A ? GATE_OPEN_A : airlock.phase === AIRLOCK_OPEN_B ? GATE_OPEN_B : 0;
  return 0;
}

/** Bits of the doors that are FULLY open at `tick` (deck light green only
 *  then). Never 3: the airlock interlock keeps one end shut. */
export function gateFullyOpenMask(gate: GateState | undefined, airlock: AirlockState | undefined, tick: number): number {
  if (gate) return doorFullyOpen(gate.door, tick) ? GATE_OPEN_A : 0;
  if (!airlock) return 0;
  return (doorFullyOpen(airlock.doorA, tick) ? GATE_OPEN_A : 0) | (doorFullyOpen(airlock.doorB, tick) ? GATE_OPEN_B : 0);
}

/** Any of the gate's doors is still travelling (or frozen short of its
 *  target): it draws full power while this holds (general grid rule). */
export function gateDoorsMoving(gate: GateState | undefined, airlock: AirlockState | undefined, tick: number): boolean {
  if (gate) return doorMoving(gate.door, tick);
  if (!airlock) return false;
  return doorMoving(airlock.doorA, tick) || doorMoving(airlock.doorB, tick);
}
