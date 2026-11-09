/**
 * Desktop mouse aim (exp/hud-mobile-first; experimental HUD + non-touch only).
 *
 *  - LEFT button held on the game surface = aim at the cursor + manual fire.
 *    A quick click (released before HOLD_MS without moving DRAG_PX) never
 *    aims, so click-to-select keeps working exactly as before.
 *  - RIGHT button held = boost. The in-game context menu is suppressed.
 *  - The cursor becomes a crosshair over the game surface.
 *
 * The bearing is the cursor's offset from the surface centre: the pilot camera
 * follows the local ship with no lag (`followLerpFactor: 1`) and never
 * rotates, so the ship IS the screen centre — no camera round-trip to the
 * render worker is needed. Writes `aimInput` only; ColyseusClient reads it.
 */
import { aimInput } from './AimInput';
import { stickToWorldBearing } from '@core/combat/manualAim';

export const MOUSE_AIM_HOLD_MS = 160;
export const MOUSE_AIM_DRAG_PX = 8;

/** Pure: cursor (client px) → world bearing, relative to the surface centre. */
export function cursorBearing(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): number {
  return stickToWorldBearing(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
}

/** Install on the game surface element. Returns a dispose function. */
export function installMouseAim(el: HTMLElement): () => void {
  let down = false;
  let aiming = false;
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const prevCursor = el.style.cursor;
  el.style.cursor = 'crosshair';

  const aimAt = (x: number, y: number): void => {
    aimInput.setWorldBearing(cursorBearing(x, y, el.getBoundingClientRect()));
  };
  const startAim = (): void => {
    if (!down || aiming) return;
    aiming = true;
    aimAt(lastX, lastY);
  };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 2) {
      aimInput.setBoostHeld(true);
      return;
    }
    if (e.button !== 0) return;
    down = true;
    aiming = false;
    downAt = performance.now();
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    if (timer) clearTimeout(timer);
    timer = setTimeout(startAim, MOUSE_AIM_HOLD_MS);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (!down) return;
    if (aiming) {
      aimAt(lastX, lastY);
      return;
    }
    const dx = lastX - downX, dy = lastY - downY;
    if (dx * dx + dy * dy > MOUSE_AIM_DRAG_PX * MOUSE_AIM_DRAG_PX || performance.now() - downAt > MOUSE_AIM_HOLD_MS) startAim();
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 2) {
      aimInput.setBoostHeld(false);
      return;
    }
    if (e.button !== 0) return;
    down = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (aiming) aimInput.clear();
    aiming = false;
  };
  const onContext = (e: Event): void => { e.preventDefault(); };
  const onBlur = (): void => {
    down = false;
    aiming = false;
    if (timer) { clearTimeout(timer); timer = null; }
    aimInput.clear();
    aimInput.setBoostHeld(false);
  };

  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  el.addEventListener('contextmenu', onContext);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    el.style.cursor = prevCursor;
    el.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.removeEventListener('contextmenu', onContext);
    window.removeEventListener('blur', onBlur);
  };
}
