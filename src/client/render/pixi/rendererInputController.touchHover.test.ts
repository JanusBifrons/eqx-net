/**
 * Hover outline is a mouse thing. A touch pointermove (one-finger pan, a
 * pinch's two fingers) must not run the whole-mirror `pickEntityAt` scan:
 * on a phone that ran on every finger move and stuttered pinch-zoom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';
import { RendererInputController } from './rendererInputController.js';

const pick = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../pickEntity', async (orig) => {
  const real = await orig<typeof import('../pickEntity')>();
  return {
    ...real,
    pickEntityAt: (...a: Parameters<typeof real.pickEntityAt>) => {
      pick.calls++;
      return real.pickEntityAt(...a);
    },
  };
});

function setup() {
  const camera = {
    screenToWorld: vi.fn((x: number, y: number) => ({ x, y })),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: false })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const mirror = {
    localPlayerId: 'me',
    ships: new Map([['me', { kind: 'fighter', x: 0, y: 0 }], ['other', { kind: 'fighter', x: 50, y: 0 }]]),
    swarm: new Map(),
  } as unknown as RenderMirror;
  const feedback = { helmCourseSeq: 0, orderSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  const ctl = new RendererInputController({
    camera: camera as unknown as Camera,
    lastMirror: mirror,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  });
  return { ctl, camera };
}

const ev = (type: string, pointerId: number, x: number, pointerType: string) =>
  ({ type, pointerId, offsetX: x, offsetY: 0, stamp: 0, button: 0, buttons: 1, pointerType });

describe('hover pick runs for the mouse only', () => {
  beforeEach(() => { pick.calls = 0; });

  it('a two-finger pinch never scans for a hover target', () => {
    const { ctl, camera } = setup();
    ctl.forwardPointerEvent(ev('pointerdown', 1, 0, 'touch'));
    ctl.forwardPointerEvent(ev('pointerdown', 2, 100, 'touch'));
    for (let i = 0; i < 60; i++) {
      ctl.forwardPointerEvent(ev('pointermove', 1, -i, 'touch'));
      ctl.forwardPointerEvent(ev('pointermove', 2, 100 + i, 'touch'));
    }
    expect(camera.onPointerMove).toHaveBeenCalledTimes(120);
    expect(pick.calls).toBe(0);
  });

  it('a mouse move still picks the hover target', () => {
    const { ctl } = setup();
    ctl.forwardPointerEvent(ev('pointermove', 1, 50, 'mouse'));
    expect(pick.calls).toBe(1);
    expect(ctl._hoveredId).toBe('other');
  });

  it('a pen move still picks the hover target', () => {
    const { ctl } = setup();
    ctl.forwardPointerEvent(ev('pointermove', 1, 50, 'pen'));
    expect(pick.calls).toBe(1);
  });
});
