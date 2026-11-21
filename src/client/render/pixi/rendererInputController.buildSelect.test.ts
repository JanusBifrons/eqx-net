/**
 * Build mode runs in the Command view. Ships still selected from Command turn
 * a touch tap on your own building into a fleet order; entering Build clears
 * that selection (`buildModeView` → `selectFleetShips([])`), after which the
 * same tap selects the building (its card + management actions).
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
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: true })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const feedback = { helmCourseSeq: 0, orderSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0 } as unknown as RendererFeedback;
  const deps = {
    camera: camera as unknown as Camera,
    lastMirror: null as RenderMirror | null,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  };
  const ctl = new RendererInputController(deps);
  ctl.setCommandView(true); // Build runs in the Command view
  return { ctl, deps, feedback };
}

/** My own Solar at game (100, -100) = screen (100, 100); no ships in view. */
const MIRROR = {
  localPlayerId: 'me-123',
  ships: new Map(),
  swarm: new Map([[9, { kind: 2, shipKind: 'solar', radius: 40, x: 100, y: -100 }]]),
} as unknown as RenderMirror;

const ev = (type: string, x: number, y: number, stamp: number) =>
  ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch' });

function tapBuilding(ctl: RendererInputController): void {
  ctl.forwardPointerEvent(ev('pointerdown', 100, 100, 0));
  ctl.forwardPointerEvent(ev('pointerup', 100, 100, 30));
}

describe('RendererInputController: a tap on your building in Build selects it', () => {
  it('with ships carried over from Command, a touch tap orders them (the gap)', () => {
    const { ctl, deps, feedback } = setup();
    ctl.selectFleetShips(['ship-2']); // no mirror yet: kept as-is
    deps.lastMirror = MIRROR;
    tapBuilding(ctl);
    expect(feedback.orderSeq).toBe(1);
    expect(ctl._focusId).toBeNull();
  });

  it('after Build clears the ship selection, the same tap selects the building', () => {
    const { ctl, deps, feedback } = setup();
    ctl.selectFleetShips(['ship-2']);
    deps.lastMirror = MIRROR;
    ctl.selectFleetShips([]); // what entering Build sends
    expect(ctl._selShips.size).toBe(0);
    tapBuilding(ctl);
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-9');
    expect(ctl._focusKind).toBe('structure');
  });
});
