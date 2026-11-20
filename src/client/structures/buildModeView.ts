/**
 * Build mode's view (owner's sideways-phone design, 2026-11-20): picking a
 * building switches to the Command (overhead) view and pulls the camera back;
 * Confirm, Cancel or Escape puts you back in the view you were in, at the
 * zoom you had. Only in a galaxy sector: a room with no sector key cannot give
 * the ship back, so build mode stays in Fly there (camera pull-back only).
 *
 * Build mode IS `placementKind !== null` (no second mode flag). This is not a
 * new view system: it drives the existing Command ⇄ Fly switch through the
 * same senders the toggle uses (`setPilotMode('spectator')` + `sendCommand`
 * to let go, `sendPilotShip` to take the same ship back) and the existing
 * camera glide (`glideCameraTo` with a target zoom). Called once per frame by
 * `gameRafLoop`; edge-triggered, so the steady state is two compares and no
 * allocation.
 *
 * The camera scale is read from the renderer feedback's `viewHalf` (the larger
 * half of the visible world): scale = (larger window side / 2) / viewHalf.
 */
import { selectControlMode, useUIStore } from '../state/store.js';
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
}

/**
 * Per frame. `kind` = the store's `placementKind`; `view` = this frame's
 * renderer feedback (null when none was read); `localShipInstanceId` = the
 * hull being flown (mirror), so the exit can take that same ship back.
 */
export function stepBuildModeView(
  kind: string | null,
  view: BuildViewSample | null,
  localShipInstanceId: string | null,
  camera: BuildViewCamera,
  winW: number,
  winH: number,
): void {
  if (kind !== null) {
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
  if (selectControlMode(ui) !== 'fly') return;
  // Only let go where the room can hand the ship back: the server ignores
  // `pilot_ship` in a room with no sector key (pilotSwap `reclaimLingeringHull`,
  // engineering / test rooms like `?room=sector`), so Command there would strand
  // the player. Build mode stays in Fly; the HUD still hides, the camera pulls back.
  if (ui.currentSectorKey === null) return;
  st.flyShipId = localShipInstanceId;
  // The Command toggle's own path: flip the view, hand the ship to its AI.
  ui.setPilotMode('spectator');
  sendCommand();
}

function exitBuildView(camera: BuildViewCamera): void {
  if (st.savedScale > 0) camera.glideCameraTo(st.lastX, st.lastY, BUILD_VIEW_GLIDE_MS, st.savedScale);
  // Back to flying the same ship, unless the player already took one.
  const shipId = st.flyShipId;
  const flyBack = shipId !== null && selectControlMode(useUIStore.getState()) === 'command';
  if (flyBack) sendPilotShip(shipId);
  const scale = st.savedScale;
  resetBuildModeView();
  if (flyBack) st.restoreScale = scale;
}
