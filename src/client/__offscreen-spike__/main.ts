/**
 * Phase 1 spike — main thread.
 *
 * Validates the OffscreenCanvas + Web Worker pattern for the eqx-peri
 * Pixi migration. Throwaway code; no React/MUI/Zustand dependency.
 *
 * Pass criteria:
 *   1. Worker logs `[ready]` within ~1 s of page load.
 *   2. Mouse drag pans the viewport.
 *   3. Mouse wheel zooms the viewport.
 *   4. Click on a hex fires a HEX_TAP message back to main (logged here).
 *   5. Touch drag pans on mobile.
 *   6. Pinch zooms on mobile.
 *
 * If any of these fail, the migration plan (humble-strolling-coral.md)
 * Phase 1 returns NO-GO and we fall back to either forking pixi-viewport
 * or hand-rolling a camera.
 */

const logEl = document.getElementById('log') as HTMLPreElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

function log(line: string, cls: 'pass' | 'fail' | 'info' = 'info'): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = `${stamp} ${line}\n`;
  logEl.prepend(span);
}

// Spike simplification: drop DPR multiplication. CSS pixels = canvas
// backing pixels = pointer offsetX/offsetY directly. Spike is testing
// the worker + camera mechanism, not pixel-perfect rendering quality.
const dpr = 1;
canvas.width = canvas.clientWidth;
canvas.height = canvas.clientHeight;

const offscreen = canvas.transferControlToOffscreen();

const worker = new Worker(new URL('./spike-worker.ts', import.meta.url), { type: 'module' });

worker.postMessage(
  {
    type: 'BOOT',
    canvas: offscreen,
    width: canvas.width,
    height: canvas.height,
    dpr,
  },
  [offscreen],
);

worker.onmessage = (e: MessageEvent): void => {
  const msg = e.data as { type: string; [k: string]: unknown };
  switch (msg.type) {
    case 'READY':
      log('[ready] worker booted; viewport + 5 hexes mounted', 'pass');
      break;
    case 'HEX_TAP':
      log(`[hex-tap] index=${msg.index as number}`, 'pass');
      break;
    case 'ERROR':
      log(`[error] ${msg.message as string}`, 'fail');
      break;
    default:
      log(`[unknown-msg] ${JSON.stringify(msg)}`, 'info');
  }
};

worker.onerror = (e: ErrorEvent): void => {
  log(`[worker-error] ${e.message}`, 'fail');
};

// ---------- Pointer event forwarding ----------
//
// We serialise the fields pixi-viewport reads. Pixi's EventSystem on the
// worker side reconstructs a fake PointerEvent-shape from these. Note
// that worker and main `performance.now()` clocks differ; we stamp every
// event with `Date.now()` so the worker can translate to its local
// timeline if needed.

interface SerialisedPointer {
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

function serialisePointer(e: PointerEvent): SerialisedPointer {
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

const forwardPointer = (e: PointerEvent): void => {
  worker.postMessage({ type: 'POINTER_EVENT', native: serialisePointer(e) });
};

canvas.addEventListener('pointerdown', forwardPointer);
canvas.addEventListener('pointermove', forwardPointer);
canvas.addEventListener('pointerup', forwardPointer);
canvas.addEventListener('pointercancel', forwardPointer);
canvas.addEventListener('pointerleave', forwardPointer);

// Wheel — non-passive so we can preventDefault and the page doesn't scroll.
canvas.addEventListener(
  'wheel',
  (e: WheelEvent): void => {
    e.preventDefault();
    worker.postMessage({
      type: 'WHEEL_EVENT',
      native: {
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
      },
    });
  },
  { passive: false },
);

// Touch — for iOS / Android. Pinch is reconstructed from touch points on
// the worker side via pixi-viewport's pinch plugin (which listens on the
// renderer's EventSystem).
canvas.addEventListener(
  'touchmove',
  (e: TouchEvent): void => {
    e.preventDefault();
  },
  { passive: false },
);

// ---------- Resize ----------
window.addEventListener('resize', () => {
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  worker.postMessage({ type: 'RESIZE', width: canvas.width, height: canvas.height, dpr });
});

log('[boot] transferred canvas to worker; awaiting READY');
