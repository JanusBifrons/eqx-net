/**
 * Fly mode, touch: a tap on a structure's crane bay pad is a helm course,
 * never an inspect. Phone film (base-build-test): flying a Mining Skiff home
 * to the Capital's pad, taps on the pad did nothing (no course, the ship sat
 * short of the pad). The pad is a parking spot: whatever else the tap's
 * grab radius reaches there (a hull parked on the pad, the Capital's own tap
 * slop over the pad's inner strip) must not swallow the course. A tap on the
 * Capital's body still opens its card.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup(mirror: RenderMirror) {
  const camera = {
    // 1 px = 1 world unit; screen (x, y) = game (x, -y).
    screenToWorld: vi.fn((x: number, y: number) => ({ x, y })),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: true })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const feedback = { helmCourseSeq: 0, helmCourseX: 0, helmCourseY: 0, orderSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  const ctl = new RendererInputController({
    camera: camera as unknown as Camera,
    lastMirror: mirror,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
  return { ctl, feedback };
}

/** base-build-test: the Capital at (0, 0) turned 90°, its pad west, centre
 *  (-410, 0), spanning x -530..-290; I fly a Mining Skiff 285 u short of it. */
function mirror(extraShips: Array<[string, { kind: string; x: number; y: number }]> = []): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map([['me', { kind: 'mining-skiff', x: -695, y: 0 }], ...extraShips]),
    swarm: new Map([[1, { kind: 2, shipKind: 'capital', radius: 396, x: 0, y: 0, angle: Math.PI / 2 }]]),
  } as unknown as RenderMirror;
}

function tap(ctl: RendererInputController, gameX: number, gameY: number): void {
  const ev = (type: string, stamp: number) =>
    ({ type, pointerId: 1, offsetX: gameX, offsetY: -gameY, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch' });
  ctl.forwardPointerEvent(ev('pointerdown', 0));
  ctl.forwardPointerEvent(ev('pointerup', 30));
}

describe('Fly mode: a tap on a crane bay pad sets the helm course', () => {
  it('a hull parked on the pad does not swallow the course tap', () => {
    const { ctl, feedback } = setup(mirror([['hull-2', { kind: 'fighter', x: -410, y: 0 }]]));
    tap(ctl, -410, 10);
    expect(feedback.helmCourseSeq).toBe(1);
    expect(feedback.helmCourseX).toBe(-410);
    expect(feedback.helmCourseY).toBe(10);
    expect(ctl._focusId).toBeNull();
  });

  it("the pad's strip beside the Capital is a course, not the Capital", () => {
    const { ctl, feedback } = setup(mirror());
    tap(ctl, -298, 40);
    expect(feedback.helmCourseSeq).toBe(1);
    expect(ctl._focusId).toBeNull();
  });

  it('the open pad is a course', () => {
    const { ctl, feedback } = setup(mirror());
    tap(ctl, -410, 0);
    expect(feedback.helmCourseSeq).toBe(1);
  });

  it("a tap on the Capital's body still opens its card (no course)", () => {
    const { ctl, feedback } = setup(mirror());
    tap(ctl, -100, 0);
    expect(feedback.helmCourseSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-1');
  });
});
