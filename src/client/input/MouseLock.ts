/**
 * Desktop smart-aim lock (exp/fire-control, `?ui=d`, non-touch only).
 *
 *  - LEFT button press-and-drag on the game surface draws a guideline from the
 *    ship toward the cursor; the lockable target nearest the line is
 *    highlighted; release starts the lock for the active weapon group.
 *    A quick click (no drag, released before HOLD_MS) is left alone, so
 *    click-to-select keeps working.
 *  - RIGHT button held = boost (context menu suppressed).
 *  - Keys: 1–9 select a weapon group, Shift+1–9 toggle that group AUTO/MAN,
 *    T locks the selected entity with the active group, X drops the active
 *    group's locks.
 *
 * The ship is the screen centre (the pilot camera follows it with no lag), so
 * the bearing is the cursor's offset from the surface centre — see MouseAim.
 */
import { aimInput } from './AimInput';
import { cursorBearing, MOUSE_AIM_DRAG_PX, MOUSE_AIM_HOLD_MS } from './MouseAim';
import { getGameClient } from '../net/clientSingleton';
import { useUIStore } from '../state/store';

/** Pure: key event → fire-control key action (null = not ours). */
export function fcKeyAction(
  key: string,
  code: string,
  shift: boolean,
): { kind: 'select' | 'mode'; index: number } | { kind: 'target' | 'clear' } | null {
  const m = /^Digit([1-9])$/.exec(code);
  if (m) return { kind: shift ? 'mode' : 'select', index: Number(m[1]) - 1 };
  const k = key.toLowerCase();
  if (k === 't') return { kind: 'target' };
  if (k === 'x') return { kind: 'clear' };
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

  const guide = (): void => {
    getGameClient()?.updateLockGuide(cursorBearing(lastX, lastY, el.getBoundingClientRect()));
  };
  const start = (): void => {
    if (!down || dragging) return;
    dragging = true;
    guide();
  };
  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
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
    if (dragging) getGameClient()?.commitLockGuide();
    dragging = false;
  };
  const onContext = (e: Event): void => { e.preventDefault(); };
  const onBlur = (): void => {
    if (dragging) getGameClient()?.updateLockGuide(NaN);
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
