/**
 * Tap rule T3: the left strip's Move arms a one-point pick on the fleet-pick
 * path (`setFleetPick('move')`). The next map tap (any pointer) is a MOVE
 * order to that point through the right-click order path (feedback
 * `orderSeq`, never a pick result / set_mode), and the pick ends: the tap
 * after it is an ordinary tap again.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup() {
  const camera = {
    scale: { x: 1, y: 1 },
    screenToWorld: vi.fn((x: number, y: number) => ({ x, y })),
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(() => ({ wasTap: true })),
    onPointerCancel: vi.fn(),
    onWheel: vi.fn(),
  };
  const feedback = {
    orderSeq: 0, orderKind: null, orderTargetId: null, orderX: 0, orderY: 0,
    helmCourseSeq: 0, placementConfirmSeq: 0, fleetSelSeq: 0,
    fleetPickSeq: 0, fleetPickPoints: 0, fleetPickResult: null,
  } as unknown as RendererFeedback;
  const deps = {
    camera: camera as unknown as Camera,
    lastMirror: null as RenderMirror | null,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  };
  const ctl = new RendererInputController(deps);
  ctl.setCommandView(true);
  ctl.selectFleetShips(['ship-2']);
  // An enemy turret at game (300, -100): Move ignores what is under the tap.
  deps.lastMirror = {
    localPlayerId: 'me-123',
    ships: new Map(),
    swarm: new Map([[8, { kind: 2, shipKind: 'turret', radius: 20, x: 300, y: -100, angle: 0 }]]),
    structures: new Map([[8, { owner: 'enemy-9' }]]),
  } as unknown as RenderMirror;
  return { ctl, feedback };
}

function press(ctl: RendererInputController, x: number, y: number, pointerType: string): void {
  const ev = (type: string, stamp: number) => ({
    type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0,
    buttons: type === 'pointerup' ? 0 : 1, pointerType,
  });
  ctl.forwardPointerEvent(ev('pointerdown', 0));
  ctl.forwardPointerEvent(ev('pointerup', 30));
}

describe('Command view: Move pick (tap rule T3)', () => {
  for (const pointerType of ['touch', 'mouse']) {
    it(`a ${pointerType} tap after Move orders a move there and ends the pick`, () => {
      const { ctl, feedback } = setup();
      ctl.setFleetPick('move');
      press(ctl, 120, 80, pointerType);
      expect(feedback.orderSeq).toBe(1);
      expect(feedback.orderKind).toBe('move');
      expect(feedback.orderTargetId).toBeNull();
      expect(feedback.orderX).toBe(120);
      expect(feedback.orderY).toBe(-80);
      expect(feedback.fleetPickSeq, 'never a pick result').toBe(0);
      expect(feedback.fleetPickResult).toBeNull();
      // Disarmed: the next free-space tap is an ordinary tap (no order).
      press(ctl, 50, 50, pointerType);
      expect(feedback.orderSeq).toBe(1);
    });
  }

  it('a tap on an enemy during Move is still a move (never an attack)', () => {
    const { ctl, feedback } = setup();
    ctl.setFleetPick('move');
    press(ctl, 300, 100, 'touch');
    expect(feedback.orderKind).toBe('move');
    expect(feedback.orderTargetId).toBeNull();
  });
});
