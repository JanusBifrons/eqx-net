/**
 * Build mode's view (owner, 2026-11-20): Build is the third control mode
 * (Fly / Command / Build, the store's `buildMode`). Entering it (the switch's
 * Build button, or picking a structure) lets go of the ship like Command and
 * pulls the camera back. Confirm and Cancel stay in Build; only the switch's
 * Fly or Command leaves it (`leaveBuildMode`), back at the zoom you had, and
 * Fly takes back the ship you were flying.
 *
 * This is not a new view system: it drives the existing Command ⇄ Fly switch
 * through the same senders the toggle uses (`setPilotMode('spectator')` +
 * `sendCommand` to let go, `sendPilotShip` to take the same ship back) and the
 * existing camera glide (`glideCameraTo` with a target zoom). Called once per
 * frame by `gameRafLoop`; edge-triggered, so the steady state is two compares
 * and no allocation.
 *
 * The camera scale is read from the renderer feedback's `viewHalf` (the larger
 * half of the visible world): scale = (larger window side / 2) / viewHalf.
 */
import { useUIStore } from '../state/store.js';
import { sendCommand, sendPilotShip } from '../ships/shipActionsClient.js';

/** Entering build mode multiplies the camera scale by this (a step back). */
export const BUILD_ZOOM_OUT = 0.6;
/** Glide time (ms) for the build-mode pull-back and its restore. */
export const BUILD_VIEW_GLIDE_MS = 350;

/** The renderer feedback's camera view (game space). */
export interface BuildViewSample {
  readonly viewX: number;
  readonly viewY: number;
  readonly viewHalf: number;
}

/** The one camera call build mode needs (`IRenderer.glideCameraTo`). */
export interface BuildViewCamera {
  glideCameraTo(gameX: number, gameY: number, durationMs: number, toScale?: number): void;
}

const st = {
  active: false,
  /** Was flying when build mode began: fly this ship again on exit. */
  flyShipId: null as string | null,
  /** Camera scale before the pull-back (0 = not pulled back yet). */
  savedScale: 0,
  lastX: 0,
  lastY: 0,
  /** Zoom the fly-back's pilot-swap glide must end at (0 = none pending). */
  restoreScale: 0,
  /** `leaveBuildMode('fly')` sent the fly-back: the exit hands its zoom on. */
  flyBackSent: false,
};

/** Camera scale (px per world unit) from a view sample; 0 before the first frame. */
export function scaleOfView(viewHalf: number, winW: number, winH: number): number {
  return viewHalf > 0 ? Math.max(winW, winH) / 2 / viewHalf : 0;
}

/** True while build mode holds the view (test + E2E read). */
export function buildViewActive(): boolean {
  return st.active;
}

/**
 * The zoom build mode's exit is restoring, for the pilot-swap glide that
 * follows the fly-back (one-shot; 0 = none). That glide replaces the restore
 * glide mid-way, so it carries the target zoom too or the zoom would freeze.
 */
export function takeBuildRestoreScale(): number {
  const s = st.restoreScale;
  st.restoreScale = 0;
  return s;
}

/** Forget build-mode view state (teardown, tests). */
export function resetBuildModeView(): void {
  st.restoreScale = 0;
  st.active = false;
  st.flyShipId = null;
  st.savedScale = 0;
  st.lastX = 0;
  st.lastY = 0;
  st.flyBackSent = false;
}

/**
 * Leave Build through the mode switch (the ONLY way out: Confirm and Cancel
 * stay in Build). Drops any ghost; the next frame's step restores the camera.
 * `fly` takes back the ship flown before Build and returns true; false means
 * there was none, so the caller runs the switch's normal Fly (ship menu) from
 * Command. No-op (false) outside Build.
 */
export function leaveBuildMode(next: 'fly' | 'command'): boolean {
  const ui = useUIStore.getState();
  if (!ui.buildMode) return false;
  const shipId = st.flyShipId;
  ui.setPlacementKind(null);
  ui.setBuildMode(false);
  if (next !== 'fly' || shipId === null) return false;
  sendPilotShip(shipId);
  st.flyBackSent = true;
  return true;
}

/**
 * Per frame. `building` = the store's `buildMode`; `view` = this frame's
 * renderer feedback (null when none was read); `localShipInstanceId` = the
 * hull being flown (mirror), so the exit can take that same ship back.
 */
export function stepBuildModeView(
  building: boolean,
  view: BuildViewSample | null,
  localShipInstanceId: string | null,
  camera: BuildViewCamera,
  winW: number,
  winH: number,
): void {
  if (building) {
    if (!st.active) enterBuildView(localShipInstanceId);
    if (view !== null && view.viewHalf > 0) {
      st.lastX = view.viewX;
      st.lastY = view.viewY;
      // Pull back once, on the first frame with a camera reading.
      if (st.savedScale === 0) {
        st.savedScale = scaleOfView(view.viewHalf, winW, winH);
        camera.glideCameraTo(view.viewX, view.viewY, BUILD_VIEW_GLIDE_MS, st.savedScale * BUILD_ZOOM_OUT);
      }
    }
    return;
  }
  if (st.active) exitBuildView(camera);
}

function enterBuildView(localShipInstanceId: string | null): void {
  st.active = true;
  st.savedScale = 0;
  st.restoreScale = 0;
  st.flyShipId = null;
  const ui = useUIStore.getState();
  if (ui.pilotMode !== 'pilot') return; // from Command: nothing to let go of
  st.flyShipId = localShipInstanceId;
  // The Command toggle's own path: flip the view, hand the ship to its AI.
  ui.setPilotMode('spectator');
  sendCommand();
}

function exitBuildView(camera: BuildViewCamera): void {
  if (st.savedScale > 0) camera.glideCameraTo(st.lastX, st.lastY, BUILD_VIEW_GLIDE_MS, st.savedScale);
  // The fly-back (if any) went out from `leaveBuildMode`: its pilot-swap glide
  // carries the restore zoom.
  const flyBack = st.flyBackSent;
  const scale = st.savedScale;
  resetBuildModeView();
  if (flyBack) st.restoreScale = scale;
}
