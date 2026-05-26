/**
 * Structured-cloneable serialisations of native browser events.
 *
 * `OffscreenCanvas` has no DOM event source in the worker (per
 * pixijs/pixijs#9132), so pointer / wheel events are stamped on the
 * main thread, posted, and consumed by the worker's hand-rolled
 * `Camera` state machine. Plain primitives only — no Pixi handles,
 * no functions, no DOM refs.
 */

/**
 * Subset of `PointerEvent` fields the worker camera reads. Stamped
 * with `Date.now()` on the main thread so the worker can translate
 * to its own performance.now() timeline if needed (the two clocks
 * differ by an unknown offset).
 */
export interface SerialisedPointerEvent {
  type: string;
  pointerId: number;
  pointerType: string;
  button: number;
  buttons: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isPrimary: boolean;
  pressure: number;
  width: number;
  height: number;
  twist: number;
  tiltX: number;
  tiltY: number;
  stamp: number;
}

export interface SerialisedWheelEvent {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  offsetX: number;
  offsetY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  stamp: number;
}
