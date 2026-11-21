/**
 * Helm orders are a Command control, never a Fly one (owner, 2026-11-21).
 * Command: tap a point to move there and set the ship's speed (the helm
 * panel). Fly: manual piloting only (WASD / the thumbstick), for every hull,
 * capitals included; no speed telegraph and no tap-to-move.
 *
 * `HelmModeGate.frame` runs once per RAF from `gameRafLoop`: it turns a
 * renderer tap (`helmCourseSeq`) into a course only in Command, and drops any
 * course still in force the moment the pilot switches to Fly, so manual
 * control takes over cleanly. Alloc-free (#14). The programmatic
 * `ColyseusGameClient.setHelmCourse` (dev / e2e / netgate hook) is not gated.
 */
import { selectControlMode } from '../state/controlMode.js';
import type { ControlMode, UIStore } from '../state/storeTypes.js';

type ModeState = Pick<UIStore, 'pilotMode' | 'buildMode'>;

/** True only in Command: the one place helm orders (course, speed) apply. */
export function helmOrdersAllowed(s: ModeState): boolean {
  return selectControlMode(s) === 'command';
}

/** The client half the gate drives (a `ColyseusGameClient`). */
export interface HelmModeClient {
  setHelmCourse(x: number, y: number): void;
  clearHelm(): void;
}

/** The renderer feedback fields carrying a tap on empty space. */
export interface HelmTapFeedback {
  readonly helmCourseSeq: number;
  readonly helmCourseX: number;
  readonly helmCourseY: number;
}

export class HelmModeGate {
  private lastSeq = 0;
  private lastMode: ControlMode | null = null;

  frame(client: HelmModeClient, s: ModeState, fb: HelmTapFeedback): void {
    const mode = selectControlMode(s);
    if (mode === 'fly' && this.lastMode !== null && this.lastMode !== 'fly') client.clearHelm();
    this.lastMode = mode;
    if (fb.helmCourseSeq === this.lastSeq) return;
    this.lastSeq = fb.helmCourseSeq; // consumed even in Fly: never replayed later
    if (mode === 'command') client.setHelmCourse(fb.helmCourseX, fb.helmCourseY);
  }
}
