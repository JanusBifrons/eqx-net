/**
 * Build mode (owner design 2026-11-20): in the Command view, a gesture on the
 * world never steers the ship. A touch that starts ON the placement ghost
 * drags it; a one-finger drag on empty space pans the camera exactly like
 * Command view (the same `CommandPointerRouter` path), so a phone builder can
 * reach a spot off screen; a quick tap still moves the ghost to the tap point.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup() {
  const camera = {
    // 1 px = 1 world unit, origin at the canvas top-left.
    screenToWorld: vi.fn((x: number, y: number) => ({ x, y })),
    scale: { x: 1, y: 1 },
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: true })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const feedback = { helmCourseSeq: 0, orderSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  // A Solar ghost being placed; its pose is the pointer-chosen point.
  const mirror = {
    localPlayerId: 'me', ships: new Map(), swarm: new Map(),
    pendingPlacementPreview: { kind: 'solar', x: 0, y: 0, angle: 0 },
  } as unknown as RenderMirror;
  const ctl = new RendererInputController({
    camera: camera as unknown as Camera,
    lastMirror: mirror, galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
  ctl.setCommandView(true); // build mode runs in the Command view
  ctl._placementActive = true;
  // The ghost sits at screen (100, 100) = game (100, -100).
  ctl._placementChosenX = 100;
  ctl._placementChosenY = -100;
  return { ctl, camera, feedback };
}

const ev = (type: string, x: number, y: number, stamp: number, pointerType = 'touch') =>
  ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType });

describe('RendererInputController: build-mode touch', () => {
  it('a touch drag that starts on the ghost moves it and sends no helm, order or camera input', () => {
    const { ctl, camera, feedback } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 100, 100, 0));
    ctl.forwardPointerEvent(ev('pointermove', 180, 140, 16));
    ctl.forwardPointerEvent(ev('pointermove', 260, 200, 32));
    ctl.forwardPointerEvent(ev('pointerup', 260, 200, 48));
    // Game space is Y-up: the ghost parks where the finger lifted.
    expect(ctl._placementChosenX).toBe(260);
    expect(ctl._placementChosenY).toBe(-200);
    expect(feedback.helmCourseSeq).toBe(0);
    expect(feedback.orderSeq).toBe(0);
    // Touch never commits on lift: Confirm is the banner's job.
    expect(feedback.placementConfirmSeq).toBe(0);
    expect(camera.onPointerDown).not.toHaveBeenCalled();
    expect(camera.onPointerMove).not.toHaveBeenCalled();
    expect(camera.onPointerUp).not.toHaveBeenCalled();
  });

  it('a one-finger drag on empty space pans the camera and leaves the ghost', () => {
    const { ctl, camera, feedback } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 500, 400, 0));
    ctl.forwardPointerEvent(ev('pointermove', 520, 400, 16)); // past the tap threshold, before the hold
    ctl.forwardPointerEvent(ev('pointermove', 600, 420, 32));
    ctl.forwardPointerEvent(ev('pointerup', 600, 420, 48));
    expect(camera.onPointerDown).toHaveBeenCalledWith(1, 500, 400, 0);
    expect(camera.onPointerMove).toHaveBeenCalledWith(1, 600, 420);
    expect(camera.onPointerUp).toHaveBeenCalledTimes(1);
    expect(ctl._placementChosenX).toBe(100);
    expect(ctl._placementChosenY).toBe(-100);
    expect(feedback.helmCourseSeq).toBe(0);
    expect(feedback.orderSeq).toBe(0);
    expect(feedback.placementConfirmSeq).toBe(0);
  });

  it('a tap on empty space moves the ghost to the tap point', () => {
    const { ctl, camera, feedback } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 40, 260, 0));
    ctl.forwardPointerEvent(ev('pointerup', 40, 260, 30));
    expect(ctl._placementChosenX).toBe(40);
    expect(ctl._placementChosenY).toBe(-260);
    expect(camera.onPointerDown).not.toHaveBeenCalled();
    expect(feedback.helmCourseSeq).toBe(0);
    expect(feedback.orderSeq).toBe(0);
    expect(feedback.placementConfirmSeq).toBe(0);
  });

  it('a two-finger pinch off the ghost goes to the camera', () => {
    const { ctl, camera } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 500, 400, 0));
    ctl.forwardPointerEvent({ ...ev('pointerdown', 700, 400, 5), pointerId: 2 });
    ctl.forwardPointerEvent({ ...ev('pointermove', 760, 400, 20), pointerId: 2 });
    expect(camera.onPointerDown).toHaveBeenCalledTimes(2);
    expect(camera.onPointerMove).toHaveBeenCalledWith(2, 760, 400);
    expect(ctl._placementChosenX).toBe(100);
  });

  it('the mouse keeps hover-follow and click-to-place (no pan)', () => {
    const { ctl, camera, feedback } = setup();
    ctl.forwardPointerEvent(ev('pointermove', 500, 400, 0, 'mouse'));
    ctl.forwardPointerEvent(ev('pointerdown', 500, 400, 10, 'mouse'));
    ctl.forwardPointerEvent(ev('pointerup', 500, 400, 20, 'mouse'));
    expect(ctl._placementChosenX).toBe(500);
    expect(feedback.placementConfirmSeq).toBe(1);
    expect(camera.onPointerDown).not.toHaveBeenCalled();
  });
});
