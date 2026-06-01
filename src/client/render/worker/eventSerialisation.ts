/**
 * Pure DOM-event → structured-clone-safe serialisers for the main →
 * worker pointer / wheel forwarding pipeline. Extracted from the
 * monolithic `WorkerRendererClient.ts` per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 8).
 *
 * Coordinate frame: CSS (logical) pixels — NO DPR scaling. The worker
 * `Camera`, its `setScreenSize`, and the Pixi `screen` all operate in
 * CSS px (HiDPI handled by `resolution: dpr`, Pixi's standard contract).
 * Forwarded pointer/wheel `offset*` therefore stay raw so every consumer
 * shares one frame. A previous version multiplied by
 * `window.devicePixelRatio` to match a (buggy) physical-px worker frame;
 * that frame was removed when BOOT switched to sending CSS px — keeping
 * the multiply would now make pinch/wheel pivot drift by the DPR factor
 * on high-DPR devices. (plan: zazzy-engelbart, Phase 1.)
 *
 * Stateless — call from anywhere. The `stamp` field is filled in via
 * `Date.now()` so the worker can correlate events with its own clock
 * if/when that becomes interesting.
 */

import type { SerialisedPointerEvent, SerialisedWheelEvent } from './protocol.js';

export function serialisePointerEvent(e: PointerEvent): SerialisedPointerEvent {
  return {
    type: e.type,
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    clientX: e.clientX,
    clientY: e.clientY,
    offsetX: e.offsetX,
    offsetY: e.offsetY,
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
  // CSS px, no DPR scaling — wheel zoom pivots on (offsetX, offsetY) and
  // the Camera frame is CSS px (see header note).
  return {
    deltaX: e.deltaX,
    deltaY: e.deltaY,
    deltaZ: e.deltaZ,
    deltaMode: e.deltaMode,
    clientX: e.clientX,
    clientY: e.clientY,
    offsetX: e.offsetX,
    offsetY: e.offsetY,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    stamp: Date.now(),
  };
}
