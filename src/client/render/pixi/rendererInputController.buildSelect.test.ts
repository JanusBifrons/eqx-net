/**
 * Build mode runs in the Command view. A touch tap on your own building
 * selects it (its card + management actions), whether or not ships are still
 * selected from Command (entering Build clears them: `buildModeView` →
 * `selectFleetShips([])`); a touch tap is never a fleet order.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup() {
  const camera = {
    // 1 px = 1 world unit, origin at the canvas top-left.
    scale: { x: 1, y: 1 },
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

/** My own Solar at game (100, -100) = screen (100, 100); no ships in view. The
 *  pose carries its `angle` like a real mirror entry: the pick tests a 30° deck
 *  turn's real turned box, and a missing angle (NaN) would miss everything. */
const MIRROR = {
  localPlayerId: 'me-123',
  ships: new Map(),
  swarm: new Map([[9, { kind: 2, shipKind: 'solar', radius: 40, x: 100, y: -100, angle: 0 }]]),
  structures: new Map([[9, { owner: 'me-123' }]]),
} as unknown as RenderMirror;

const ev = (type: string, x: number, y: number, stamp: number) =>
  ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch' });

function tapBuilding(ctl: RendererInputController): void {
  ctl.forwardPointerEvent(ev('pointerdown', 100, 100, 0));
  ctl.forwardPointerEvent(ev('pointerup', 100, 100, 30));
}

describe('RendererInputController: a tap on your building in Build selects it', () => {
  it('with ships carried over from Command, a touch tap selects it too (no order)', () => {
    const { ctl, deps, feedback } = setup();
    ctl.selectFleetShips(['ship-2']); // no mirror yet: kept as-is
    deps.lastMirror = MIRROR;
    tapBuilding(ctl);
    expect(feedback.orderSeq).toBe(0); // a touch tap is never an order
    expect(ctl._focusId).toBe('swarm-9');
    expect(ctl._selShips.size).toBe(0); // a focus that is mine ends the ships
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

/** Tap rule T4: Build (not placing) follows the same tap rule as Command and
 *  Fly; while placing, a tap only drives the ghost and never focuses. */
describe('Build: a tap on something that is not mine (tap rule T4)', () => {
  const ENEMY = {
    localPlayerId: 'me-123',
    ships: new Map(),
    swarm: new Map([[7, { kind: 2, shipKind: 'turret', radius: 20, x: 100, y: -100, angle: 0 }]]),
    structures: new Map([[7, { owner: 'enemy-9' }]]),
  } as unknown as RenderMirror;

  it('not placing: a touch tap focuses the enemy structure (no order)', () => {
    const { ctl, deps, feedback } = setup();
    deps.lastMirror = ENEMY;
    tapBuilding(ctl);
    expect(ctl._focusId).toBe('swarm-7');
    expect(ctl._focusKind).toBe('structure');
    expect(feedback.orderSeq).toBe(0);
  });

  it('placing: the same tap moves the ghost there and focuses nothing', () => {
    const { ctl, deps, feedback } = setup();
    deps.lastMirror = { ...ENEMY, pendingPlacementPreview: { kind: 'solar', x: 600, y: -600, angle: 0 } } as unknown as RenderMirror;
    ctl._placementActive = true;
    ctl._placementChosenX = 600;
    ctl._placementChosenY = -600;
    tapBuilding(ctl);
    expect(ctl._focusId).toBeNull();
    expect(ctl._placementChosenX).toBe(100);
    expect(ctl._placementChosenY).toBe(-100);
    expect(feedback.orderSeq).toBe(0);
  });
});
