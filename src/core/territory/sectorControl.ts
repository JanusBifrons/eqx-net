/**
 * Robot sector control (plan peppy-jumping-pinwheel P3). Pure, zone-blind.
 *
 * Each sector carries a control PRESSURE in [-100, 100]. Robots present push
 * it up (a living nexus pushes hard); player structures and players present
 * push it down. Pressure moves toward that target at a bounded rate, so a
 * passing squad doesn't flip a sector instantly. Ownership has HYSTERESIS:
 * robots CLAIM a sector at ≥ CLAIM_AT and only RELEASE it at ≤ RELEASE_AT, so a
 * contested frontier doesn't flicker on the galaxy map.
 *
 * Contested = robots hold it while players (or their bases) are present too.
 */

export const CONTROL_MAX = 100;
export const CLAIM_AT = 60;
export const RELEASE_AT = 20;
/** Pressure change per second toward the target (≈ 40 s from 0 to a claim). */
export const PRESSURE_RATE_PER_S = 1.5;

/** Pressure contributions (balance knobs). */
export const PRESSURE_PER_ROBOT = 12;
export const PRESSURE_NEXUS = 80;
export const PRESSURE_PER_PLAYER_STRUCTURE = 6;
export const PRESSURE_PER_PLAYER = 15;

export interface ControlInputs {
  /** Active robot bots in the sector. */
  robots: number;
  /** A living robot nexus is in the sector. */
  nexus: boolean;
  /** Player-owned structures in the sector. */
  playerStructures: number;
  /** Players present in the sector. */
  players: number;
}

export interface SectorControlState {
  pressure: number;
  robotHeld: boolean;
}

export function freshControl(): SectorControlState {
  return { pressure: 0, robotHeld: false };
}

/** The pressure a sector is heading toward for these inputs. */
export function targetPressure(i: ControlInputs): number {
  const raw =
    i.robots * PRESSURE_PER_ROBOT +
    (i.nexus ? PRESSURE_NEXUS : 0) -
    i.playerStructures * PRESSURE_PER_PLAYER_STRUCTURE -
    i.players * PRESSURE_PER_PLAYER;
  return Math.max(-CONTROL_MAX, Math.min(CONTROL_MAX, raw));
}

/**
 * Advance one sector by `dtMs`. Mutates `s`; returns true when ownership
 * changed (claimed or released).
 */
export function stepControl(s: SectorControlState, i: ControlInputs, dtMs: number): boolean {
  const target = targetPressure(i);
  const maxStep = (PRESSURE_RATE_PER_S * Math.max(0, dtMs)) / 1000;
  const delta = target - s.pressure;
  s.pressure += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
  const was = s.robotHeld;
  if (!s.robotHeld && s.pressure >= CLAIM_AT) s.robotHeld = true;
  else if (s.robotHeld && s.pressure <= RELEASE_AT) s.robotHeld = false;
  return was !== s.robotHeld;
}

export function isContested(s: SectorControlState, i: ControlInputs): boolean {
  return s.robotHeld && (i.playerStructures > 0 || i.players > 0);
}
