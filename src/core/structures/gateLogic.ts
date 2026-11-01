/**
 * Gate open/close logic — zone-pure (plan soft-leaping-truffle v2, phase V gates).
 *
 * The server runs this on the 10 Hz structure tick; the client never predicts
 * it (it reads the open state from room state). Occupancy is built from ship
 * positions in the gate's LOCAL frame (`worldToLocal` in gateGeometry.ts).
 *
 *   Shield Gate: opens while a ship it ADMITS is in the approach zone; closes
 *   GATE_CLOSE_HOLD_MS after the zone empties, never on top of a ship.
 *
 *   Shield Airlock: one `phase` field (closed / open A / open B), so both ends
 *   can never be open at once. A ship waiting outside an end opens that end;
 *   once every ship inside is clear of that span, it closes; then the far end
 *   opens to let them out.
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

/** Wire value of the open state: bit 0 = the gate span / airlock end A open,
 *  bit 1 = airlock end B open. Never 3 (both ends). */
export const GATE_OPEN_A = 1;
export const GATE_OPEN_B = 2;

const GATE_HALF_W = 160;

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
  /** Any ship (admitted or not) overlaps span A (the gate span) / span B. */
  bandA: boolean;
  bandB: boolean;
}

export function newOccupancy(): GateOccupancy {
  return { admittedNear: false, waitA: false, waitB: false, inside: false, insideClearA: true, insideClearB: true, bandA: false, bandB: false };
}

export function clearOccupancy(o: GateOccupancy): void {
  o.admittedNear = false;
  o.waitA = false;
  o.waitB = false;
  o.inside = false;
  o.insideClearA = true;
  o.insideClearB = true;
  o.bandA = false;
  o.bandB = false;
}

/** Add one ship (local position lx, ly; radius r) to a gate's occupancy. */
export function addShipToOccupancy(type: GateType, lx: number, ly: number, r: number, admitted: boolean, o: GateOccupancy): void {
  const gapHalf = gateGapHalf(type);
  const bandHalf = GATE_SPAN_THICKNESS / 2 + r;
  if (type === 'gate') {
    if (Math.abs(lx) <= gapHalf + r && Math.abs(ly) <= bandHalf) o.bandA = true;
    if (admitted && Math.abs(lx) <= GATE_HALF_W + r && Math.abs(ly) <= GATE_APPROACH_DEPTH) o.admittedNear = true;
    return;
  }
  const yA = AIRLOCK_END_Y;
  const inLane = Math.abs(lx) <= gapHalf + r;
  if (inLane && Math.abs(ly - yA) <= bandHalf) o.bandA = true;
  if (inLane && Math.abs(ly + yA) <= bandHalf) o.bandB = true;
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

/** Shield Gate state. */
export interface GateState {
  open: boolean;
  lastBusyMs: number;
}

export function stepGate(s: GateState, o: GateOccupancy, nowMs: number): void {
  if (o.admittedNear) {
    s.open = true;
    s.lastBusyMs = nowMs;
    return;
  }
  if (!s.open) return;
  if (o.bandA) { s.lastBusyMs = nowMs; return; } // never close on a ship
  if (nowMs - s.lastBusyMs >= GATE_CLOSE_HOLD_MS) s.open = false;
}

export const AIRLOCK_CLOSED = 0;
export const AIRLOCK_OPEN_A = 1;
export const AIRLOCK_OPEN_B = 2;
const END_NONE = 0;
const END_A = 1;
const END_B = 2;

/** Shield Airlock state. `exitTo` is the end the ships inside will leave by. */
export interface AirlockState {
  phase: number;
  exitTo: number;
  lastBusyMs: number;
}

export function newAirlockState(): AirlockState {
  return { phase: AIRLOCK_CLOSED, exitTo: END_NONE, lastBusyMs: 0 };
}

export function stepAirlock(s: AirlockState, o: GateOccupancy, nowMs: number): void {
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
  const band = end === END_A ? o.bandA : o.bandB;
  const clear = end === END_A ? o.insideClearA : o.insideClearB;
  if (band) { s.lastBusyMs = nowMs; return; } // never close on a ship
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

/** Wire open mask for a gate or airlock state. */
export function gateOpenMask(gate: GateState | undefined, airlock: AirlockState | undefined): number {
  if (gate) return gate.open ? GATE_OPEN_A : 0;
  if (airlock) return airlock.phase === AIRLOCK_OPEN_A ? GATE_OPEN_A : airlock.phase === AIRLOCK_OPEN_B ? GATE_OPEN_B : 0;
  return 0;
}
