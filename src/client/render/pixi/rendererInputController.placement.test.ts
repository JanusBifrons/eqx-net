/**
 * Build mode (owner design 2026-11-20): in the Command view, a tap or drag on
 * the world moves the placement ghost and never steers the ship. Placement
 * routing comes first, so no gesture reaches the camera, the helm course or a
 * fleet order while `_placementActive` is set.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';

function setup() {
  const camera = {
    // 1 px = 1 world unit, origin at the canvas top-left.
    screenToWorld: vi.fn((x: number, y: number) => ({ x, y })),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: true })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const feedback = { helmCourseSeq: 0, orderSeq: 0, placementConfirmSeq: 0 } as unknown as RendererFeedback;
  const ctl = new RendererInputController({
    camera: camera as unknown as Camera,
    lastMirror: null, galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
  ctl.setCommandView(true); // build mode runs in the Command view
  ctl._placementActive = true;
  return { ctl, camera, feedback };
}

const ev = (type: string, x: number, y: number, stamp: number) =>
  ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch' });

describe('RendererInputController: build-mode drag', () => {
  it('a touch drag moves the ghost and sends no helm, order or camera input', () => {
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

  it('a tap moves the ghost to the tap point', () => {
    const { ctl, feedback } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 40, 60, 0));
    ctl.forwardPointerEvent(ev('pointerup', 40, 60, 30));
    expect(ctl._placementChosenX).toBe(40);
    expect(ctl._placementChosenY).toBe(-60);
    expect(feedback.helmCourseSeq).toBe(0);
    expect(feedback.orderSeq).toBe(0);
  });
});
