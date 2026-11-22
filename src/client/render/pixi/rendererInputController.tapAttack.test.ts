/**
 * Command view, phone: with ships selected, a finger tap on an enemy structure
 * (a turret) is an ATTACK order on it, same as desktop right-click
 * (`commandOrder`). A real capture had every tap sent as a bare `move`. A tap
 * on empty space still moves.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';

function setup() {
  const camera = {
    // 1 px = 1 world unit; screen (x, y) = game (x, -y).
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
  } as unknown as RendererFeedback;
  const deps = {
    camera: camera as unknown as Camera,
    lastMirror: null as RenderMirror | null,
    galaxyLayer: null, feedback, selectionBracket: null, fleetOverlay: null,
  };
  const ctl = new RendererInputController(deps);
  ctl.setCommandView(true);
  ctl.selectFleetShips(['ship-2']); // no mirror yet: kept as-is
  deps.lastMirror = MIRROR;
  return { ctl, feedback };
}

/** An enemy turret at game (100, -100) = screen (100, 100); no ships in view. */
const MIRROR = {
  localPlayerId: 'me-123',
  ships: new Map(),
  swarm: new Map([[7, { kind: 2, shipKind: 'turret', radius: 20, x: 100, y: -100, angle: 0 }]]),
} as unknown as RenderMirror;

function tap(ctl: RendererInputController, x: number, y: number): void {
  const ev = (type: string, stamp: number) =>
    ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch' });
  ctl.forwardPointerEvent(ev('pointerdown', 0));
  ctl.forwardPointerEvent(ev('pointerup', 30));
}

describe('Command view: a touch tap on an enemy structure with ships selected', () => {
  it('publishes an attack order on that structure (move mode, the default)', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 100, 100);
    expect(feedback.orderSeq).toBe(1);
    expect(feedback.orderKind).toBe('attack');
    expect(feedback.orderTargetId).toBe('swarm-7');
  });

  it('a tap on empty space still moves there', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 600, 600);
    expect(feedback.orderSeq).toBe(1);
    expect(feedback.orderKind).toBe('move');
    expect(feedback.orderTargetId).toBeNull();
    expect(feedback.orderX).toBe(600);
    expect(feedback.orderY).toBe(-600);
  });
});
