/**
 * Tap rule T4 (UI plan D10): the tap rule is the same in Fly. On a phone the
 * two FloatingStick zones cover most of the screen, so a quick no-drag touch
 * there must still reach the world tap path and FOCUS a ship or structure
 * that is not mine (the left strip then shows it with Lock). The stick hands
 * the tap to the canvas (`forwardTapToWorld`); the canvas listener's camera
 * classifies it with its ONE tap threshold and calls `handleGameplayTap`.
 * End to end here: real FloatingStick, real Camera, real canvas listeners.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingStick } from '../../hud/FloatingStick';
import { resetStickPinch } from '../../hud/stickPinch';
import { Camera } from '../worker/Camera';
import { RendererInputController } from './rendererInputController.js';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

let now = 1000;

function pe(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, pointerType: 'touch', bubbles: true, cancelable: true });
}

/** An enemy turret at game (100, -100) = screen (100, 100) at zoom `scale`
 *  with the camera at the origin; my own ship far away. */
function setup(scale = 1) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const target = { x: 0, y: 0, scale: { x: scale, y: scale } };
  const camera = new Camera(target as never, { minScale: 0.01, maxScale: 3 });
  const feedback = { orderSeq: 0, helmCourseSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  const mirror = {
    localPlayerId: 'me-123',
    ships: new Map([['me-123', { kind: 'fighter', x: 5000, y: -5000, ownerPlayerId: 'me-123', isActive: true }]]),
    swarm: new Map([[7, { kind: 2, shipKind: 'turret', radius: 20, x: 100, y: -100, angle: 0 }]]),
    structures: new Map([[7, { owner: 'enemy-9' }]]),
  } as unknown as RenderMirror;
  const ctl = new RendererInputController({
    camera, lastMirror: mirror, galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
  ctl.installCanvasEventListeners(canvas);
  const onEnd = vi.fn();
  const r = render(
    <FloatingStick id="r" zone={{ right: 0 }} home={{ right: 10, bottom: 10 }} color="#fff" onMove={vi.fn()} onEnd={onEnd} />,
  );
  return { ctl, feedback, zone: r.getByTestId('r-zone'), canvas, onEnd };
}

describe('Fly: a quick touch in a thumb-stick zone is a world tap (tap rule T4)', () => {
  beforeEach(() => {
    now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    resetStickPinch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('a tap on an enemy structure under the stick zone focuses it', () => {
    const { ctl, feedback, zone, onEnd } = setup();
    act(() => {
      zone.dispatchEvent(pe('pointerdown', 100, 100));
      now += 80;
      zone.dispatchEvent(pe('pointerup', 101, 100));
    });
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(ctl._focusId).toBe('swarm-7');
    expect(ctl._focusKind).toBe('structure');
    expect(feedback.orderSeq).toBe(0);
  });

  it('a drag in the stick zone drives the stick and focuses nothing', () => {
    const { ctl, zone, onEnd } = setup();
    act(() => {
      zone.dispatchEvent(pe('pointerdown', 100, 100));
      zone.dispatchEvent(pe('pointermove', 160, 100));
      now += 80;
      zone.dispatchEvent(pe('pointerup', 160, 100));
    });
    expect(onEnd).toHaveBeenCalledWith(false);
    expect(ctl._focusId).toBeNull();
  });

  it('zoomed out, a finger a few pixels off the enemy still focuses it (the finger slop, as in Command)', () => {
    // Zoom 0.1: the turret (game 100, -100) is at screen (10, 10); a tap 12 px
    // right is 120 world units off: beyond the mouse slop, inside a finger's.
    const { ctl, zone } = setup(0.1);
    act(() => {
      zone.dispatchEvent(pe('pointerdown', 22, 10));
      now += 80;
      zone.dispatchEvent(pe('pointerup', 22, 10));
    });
    expect(ctl._focusId).toBe('swarm-7');
  });
});
