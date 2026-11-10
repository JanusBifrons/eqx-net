/**
 * Desktop smart-aim lock (fire control, non-touch only).
 *
 *  - LEFT button held on the game surface draws a lock line from the ship
 *    toward the cursor; the target nearest it is highlighted and the active
 *    group's lock builds while you keep it there. Move off it, or let go before
 *    it finishes, and it drains back to 0.
 *    A quick click (no drag, released before HOLD_MS) is left alone, so
 *    click-to-select keeps working.
 *  - RIGHT button held = boost (context menu suppressed).
 *  - Keys: 1–9 select a weapon group, Shift+1–9 toggle that group AUTO/MAN,
 *    T locks the selected entity with the active group, X drops the active
 *    group's locks.
 *
 * The ship is the screen centre (the pilot camera follows it with no lag), so
 * the bearing is the cursor's offset from the surface centre (no camera
 * round-trip to the render worker needed).
 */
import { aimInput } from './AimInput';
import { stickToWorldBearing } from '@core/combat/manualAim';
import { getGameClient } from '../net/clientSingleton';
import { useUIStore } from '../state/store';

/** A press held this long (or dragged past MOUSE_AIM_DRAG_PX) starts the lock line;
 *  a quicker click is left alone so click-to-select keeps working. */
export const MOUSE_AIM_HOLD_MS = 160;
export const MOUSE_AIM_DRAG_PX = 8;

/** Pure: cursor (client px) → world bearing, relative to the surface centre. */
export function cursorBearing(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): number {
  return stickToWorldBearing(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2));
}

/**
 * Pure: does the lock line take this mouse press? Not while a structure is
 * being placed: placement owns left (place / drag the ghost) and right (cancel)
 * — see `PixiRenderer.routePlacementPointer` — so a press-drag mustn't also
 * draw a lock line, nor a right-click cancel also boost.
 */
export function mouseLockTakesPress(placementKind: string | null): boolean {
  return placementKind === null;
}

/** Pure: key event → fire-control key action (null = not ours). */
export function fcKeyAction(
  key: string,
  code: string,
  shift: boolean,
): { kind: 'select' | 'mode'; index: number } | { kind: 'target' | 'clear' | 'overview' } | null {
  const m = /^Digit([1-9])$/.exec(code);
  if (m) return { kind: shift ? 'mode' : 'select', index: Number(m[1]) - 1 };
  const k = key.toLowerCase();
  if (k === 't') return { kind: 'target' };
  if (k === 'x') return { kind: 'clear' };
  // O: the contacts overview (EVE's "overview"), the list to lock far targets from.
  if (k === 'o') return { kind: 'overview' };
  return null;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function installFcKeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const a = fcKeyAction(e.key, e.code, e.shiftKey);
    if (!a) return;
    const st = useUIStore.getState();
    const client = getGameClient();
    if (a.kind === 'select' || a.kind === 'mode') {
      const g = st.fcGroups[a.index];
      if (!g) return;
      e.preventDefault();
      if (a.kind === 'select') st.setActiveGroupId(g.id);
      else client?.setGroupMode(g.id, g.mode === 'auto' ? 'manual' : 'auto');
      return;
    }
    if (a.kind === 'overview') {
      e.preventDefault();
      st.setContactsOpen(!st.contactsOpen);
      return;
    }
    if (a.kind === 'target') {
      if (client?.lockSelected()) e.preventDefault();
      return;
    }
    if (st.activeGroupId) client?.cancelLock(st.activeGroupId);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

/** Install on the game surface element. Returns a dispose function. */
export function installMouseLock(el: HTMLElement): () => void {
  let down = false;
  let dragging = false;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const prevCursor = el.style.cursor;
  el.style.cursor = 'crosshair';
  const disposeKeys = installFcKeys();

  let refresh: ReturnType<typeof setInterval> | null = null;
  const guide = (): void => {
    getGameClient()?.guideLock(cursorBearing(lastX, lastY, el.getBoundingClientRect()));
  };
  const start = (): void => {
    if (!down || dragging) return;
    dragging = true;
    guide();
    // Targets move under a still cursor: keep re-checking while held.
    refresh = setInterval(guide, 100);
  };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (!mouseLockTakesPress(useUIStore.getState().placementKind)) return;
    if (e.button === 2) { aimInput.setBoostHeld(true); return; }
    if (e.button !== 0) return;
    down = true;
    dragging = false;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    if (timer) clearTimeout(timer);
    timer = setTimeout(start, MOUSE_AIM_HOLD_MS);
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    lastX = e.clientX;
    lastY = e.clientY;
    if (!down) return;
    if (dragging) { guide(); return; }
    const dx = lastX - downX, dy = lastY - downY;
    if (dx * dx + dy * dy > MOUSE_AIM_DRAG_PX * MOUSE_AIM_DRAG_PX) start();
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 2) { aimInput.setBoostHeld(false); return; }
    if (e.button !== 0) return;
    down = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (refresh) { clearInterval(refresh); refresh = null; }
    if (dragging) getGameClient()?.releaseLockGuide();
    dragging = false;
  };
  const onContext = (e: Event): void => { e.preventDefault(); };
  const onBlur = (): void => {
    if (refresh) { clearInterval(refresh); refresh = null; }
    if (dragging) getGameClient()?.releaseLockGuide();
    down = false;
    dragging = false;
    if (timer) { clearTimeout(timer); timer = null; }
    aimInput.setBoostHeld(false);
  };

  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  el.addEventListener('contextmenu', onContext);
  window.addEventListener('blur', onBlur);
  return () => {
    onBlur();
    disposeKeys();
    el.style.cursor = prevCursor;
    el.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    el.removeEventListener('contextmenu', onContext);
    window.removeEventListener('blur', onBlur);
  };
}
