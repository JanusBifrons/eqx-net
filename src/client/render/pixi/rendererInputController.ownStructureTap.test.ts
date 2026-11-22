/**
 * Command view, S3b: with ships selected, a finger tap (or right-click) on MY
 * OWN structure is a move order there, never an attack on it; an enemy
 * structure is still attacked. Zoomed out, the finger's reach is a fixed
 * screen size (`fingerSlopWorld`), so a tap a few pixels off a structure
 * still lands on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';
import { getStructureKind } from '@shared-types/structureKinds';
import { TAP_SLOP } from '../pickEntity.js';

/** `scale` = screen px per world unit; screen (x, y) = game (x/scale, -y/scale). */
function setup(mirror: RenderMirror, scale = 1) {
  const camera = {
    scale: { x: scale, y: scale },
    screenToWorld: vi.fn((x: number, y: number) => ({ x: x / scale, y: y / scale })),
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
  deps.lastMirror = mirror;
  return { ctl, feedback };
}

/** Two turrets: mine (entity 7) at game (100, -100) and an enemy's (entity 8)
 *  at game (400, -100). */
function mirror(): RenderMirror {
  return {
    localPlayerId: 'me-123',
    ships: new Map(),
    swarm: new Map([
      [7, { kind: 2, shipKind: 'turret', radius: 20, x: 100, y: -100, angle: 0 }],
      [8, { kind: 2, shipKind: 'turret', radius: 20, x: 400, y: -100, angle: 0 }],
    ]),
    structures: new Map([[7, { owner: 'me-123' }], [8, { owner: 'enemy-9' }]]),
  } as unknown as RenderMirror;
}

function press(ctl: RendererInputController, x: number, y: number, pointerType: string, button = 0): void {
  const ev = (type: string, stamp: number) => ({
    type, pointerId: 1, offsetX: x, offsetY: y, stamp, button,
    buttons: type === 'pointerup' ? 0 : button === 2 ? 2 : 1, pointerType,
  });
  ctl.forwardPointerEvent(ev('pointerdown', 0));
  ctl.forwardPointerEvent(ev('pointerup', 30));
}

describe('Command view: own structure under the finger / cursor', () => {
  it('a touch tap on my own structure moves there (no attack on it)', () => {
    const { ctl, feedback } = setup(mirror());
    press(ctl, 100, 100, 'touch');
    expect(feedback.orderSeq).toBe(1);
    expect(feedback.orderKind).toBe('move');
    expect(feedback.orderTargetId).toBeNull();
    expect(feedback.orderX).toBe(100);
    expect(feedback.orderY).toBe(-100);
  });

  it('a touch tap on an enemy structure still attacks it', () => {
    const { ctl, feedback } = setup(mirror());
    press(ctl, 400, 100, 'touch');
    expect(feedback.orderKind).toBe('attack');
    expect(feedback.orderTargetId).toBe('swarm-8');
  });

  it('a right-click on my own structure moves; on an enemy one attacks', () => {
    const own = setup(mirror());
    press(own.ctl, 100, 100, 'mouse', 2);
    expect(own.feedback.orderSeq).toBe(1);
    expect(own.feedback.orderKind).toBe('move');
    expect(own.feedback.orderTargetId).toBeNull();
    const foe = setup(mirror());
    press(foe.ctl, 400, 100, 'mouse', 2);
    expect(foe.feedback.orderKind).toBe('attack');
    expect(foe.feedback.orderTargetId).toBe('swarm-8');
  });
});

describe('Command view zoomed out: finger slop is screen-sized', () => {
  // scale 0.1: the enemy turret (game 400, -100) sits at screen (40, 10). A
  // tap 15 px right of its footprint edge is 150 world units off: outside the
  // 24-unit mouse slop, inside the 24 px finger (240 world units).
  it('a touch tap a few pixels off the enemy structure attacks it', () => {
    const { ctl, feedback } = setup(mirror(), 0.1);
    const edgeWorld = 400 + getStructureKind('turret').footprint.w / 2;
    const tapWorld = edgeWorld + 150;
    expect(tapWorld - edgeWorld).toBeGreaterThan(TAP_SLOP); // a mouse would miss
    press(ctl, tapWorld * 0.1, 10, 'touch');
    expect(feedback.orderKind).toBe('attack');
    expect(feedback.orderTargetId).toBe('swarm-8');
  });
});
