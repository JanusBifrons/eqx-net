/**
 * Pure DOM-event → structured-clone-safe serialisers for the main →
 * worker pointer / wheel forwarding pipeline. Extracted from the
 * monolithic `WorkerRendererClient.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 8).
 *
 * Why DPR scaling: the worker-side `Camera` operates in the renderer's
 * internal pixel frame, which in worker mode is PHYSICAL pixels (Pixi's
 * resolution-aware sizing). DOM-mode pointer events arrive in CSS
 * pixels — multiplying by `window.devicePixelRatio` ahead of the
 * postMessage means the worker's Camera reads coordinates in the same
 * frame regardless of DPR. Without it, pinch zoom pivots toward the
 * top-left on high-DPR phones (the Camera thinks the user is in the
 * left quarter of the canvas).
 *
 * Stateless — call from anywhere. The `stamp` field is filled in via
 * `Date.now()` so the worker can correlate events with its own clock
 * if/when that becomes interesting.
 */

import type { SerialisedPointerEvent, SerialisedWheelEvent } from './protocol.js';

export function serialisePointerEvent(e: PointerEvent): SerialisedPointerEvent {
  const dpr = window.devicePixelRatio ?? 1;
  return {
    type: e.type,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    clientX: e.clientX * dpr,
    clientY: e.clientY * dpr,
    offsetX: e.offsetX * dpr,
    offsetY: e.offsetY * dpr,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    isPrimary: e.isPrimary,
    pressure: e.pressure,
    width: e.width,
    height: e.height,
    twist: e.twist,
    tiltX: e.tiltX,
    tiltY: e.tiltY,
    stamp: Date.now(),
  };
}

export function serialiseWheelEvent(e: WheelEvent): SerialisedWheelEvent {
  // Same DPR scaling as `serialisePointerEvent` — wheel zoom pivots on
  // (offsetX, offsetY) so the coord frame must match the Camera's.
  const dpr = window.devicePixelRatio ?? 1;
  return {
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX * dpr,
    clientY: e.clientY * dpr,
    offsetX: e.offsetX * dpr,
    offsetY: e.offsetY * dpr,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    stamp: Date.now(),
  };
}
