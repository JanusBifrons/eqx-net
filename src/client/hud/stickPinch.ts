/**
 * Two fingers landing together on the touch sticks are a pinch-zoom, not two
 * sticks. Shared by every `FloatingStick` on screen.
 *
 * A finger that lands within `PINCH_WINDOW_MS` of another stick finger (on
 * either stick, or the same one) turns both into a pinch: the stick that had
 * already started is switched off, and both fingers are handed to the world
 * canvas as ordinary pointer events, so the renderer's existing camera pinch
 * does the zoom. A finger that joins later (fly, THEN lock) drives its own
 * stick as before.
 */

/** Two fingers this close together in time are "placed together". */
export const PINCH_WINDOW_MS = 150;

export interface PinchableStick {
  /** Stop driving the stick from `pointerId` and forward it as a pinch finger. */
  joinPinch(pointerId: number): void;
}

export type StickTouch = 'stick' | 'pinch' | 'ignore';

interface Active {
  pointerId: number;
  stick: PinchableStick;
  downAt: number;
  pinch: boolean;
}

const active: Active[] = [];

/** A finger went down on `stick`. `busy` = that stick already has a driving finger. */
export function stickTouchDown(pointerId: number, stick: PinchableStick, now: number, busy: boolean): StickTouch {
  let pinching = 0;
  for (const t of active) if (t.pinch) pinching++;
  // A pinch already has its two fingers; a third is ignored.
  if (pinching >= 2) return 'ignore';
  for (const t of active) {
    if (!t.pinch && now - t.downAt <= PINCH_WINDOW_MS) {
      t.pinch = true;
      active.push({ pointerId, stick, downAt: now, pinch: true });
      t.stick.joinPinch(t.pointerId);
      return 'pinch';
    }
  }
  if (busy) return 'ignore';
  active.push({ pointerId, stick, downAt: now, pinch: false });
  return 'stick';
}

/** A finger tracked by `stickTouchDown` lifted (or was cancelled). */
export function stickTouchUp(pointerId: number): void {
  const i = active.findIndex((t) => t.pointerId === pointerId);
  if (i >= 0) active.splice(i, 1);
}

/** Test hook. */
export function resetStickPinch(): void {
  active.length = 0;
}

/** The world canvas under (x, y), else the first canvas on the page. */
function worldCanvasAt(x: number, y: number): HTMLCanvasElement | null {
  if (typeof document.elementsFromPoint === 'function') {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el instanceof HTMLCanvasElement) return el;
    }
  }
  return document.querySelector('canvas');
}

/** Hand one pinch finger's event to the world canvas (the camera owns pinch). */
export function forwardPinchPointer(type: string, pointerId: number, clientX: number, clientY: number): void {
  const canvas = worldCanvasAt(clientX, clientY);
  if (!canvas) return;
  canvas.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      clientX,
      clientY,
      pointerType: 'touch',
      isPrimary: false,
      bubbles: true,
      cancelable: true,
    }),
  );
}
