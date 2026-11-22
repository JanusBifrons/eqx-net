/**
 * Command view, S3b + the tap rule: with ships selected, a right-click on MY
 * OWN structure is a move order there, never an attack on it; on an enemy
 * structure it attacks. A finger tap is never an order: on my own structure
 * it selects that structure (the ships end, as for any focus that is mine);
 * on an enemy one it focuses it and the ships stay. Zoomed out, the finger's
 * reach is a fixed screen size (`fingerSlopWorld`), so a tap a few pixels off
 * a structure still lands on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';
import { getStructureKind } from '@shared-types/structureKinds';
import { getShipKind } from '@shared-types/shipKinds';
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
  it('a touch tap on my own structure selects it, no order (never an attack)', () => {
    const { ctl, feedback } = setup(mirror());
    press(ctl, 100, 100, 'touch');
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-7');
    expect(ctl._selShips.size).toBe(0);
  });

  it('a touch tap on an enemy structure focuses it, ships kept, no order', () => {
    const { ctl, feedback } = setup(mirror());
    press(ctl, 400, 100, 'touch');
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-8');
    expect([...ctl._selShips]).toEqual(['ship-2']);
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
  it('a touch tap a few pixels off the enemy structure focuses it', () => {
    const { ctl, feedback } = setup(mirror(), 0.1);
    const edgeWorld = 400 + getStructureKind('turret').footprint.w / 2;
    const tapWorld = edgeWorld + 150;
    expect(tapWorld - edgeWorld).toBeGreaterThan(TAP_SLOP); // a mouse would miss
    press(ctl, tapWorld * 0.1, 10, 'touch');
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-8');
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });
});

describe('Command view zoomed out: own ships get the finger slop too (T1b)', () => {
  // A parked hull of mine at game (2000, -100), far from both turrets. At
  // scale 0.1 a tap 150 world units past its edge is 15 screen px: outside
  // the 24-unit mouse slop, inside the 24 px finger.
  function withOwnHull(): RenderMirror {
    const m = mirror();
    (m.ships as Map<string, unknown>).set('hull-5', {
      x: 2000, y: -100, angle: 0, kind: 'fighter', ownerPlayerId: 'me-123', isActive: false,
    });
    return m;
  }
  const hullEdge = (): number => 2000 + getShipKind('fighter')!.radius;

  it('a touch tap a few pixels off my own ship selects it', () => {
    const { ctl, feedback } = setup(withOwnHull(), 0.1);
    const tapWorld = hullEdge() + 150;
    expect(tapWorld - hullEdge()).toBeGreaterThan(TAP_SLOP);
    press(ctl, tapWorld * 0.1, 10, 'touch');
    expect(feedback.orderSeq).toBe(0);
    expect([...ctl._selShips]).toEqual(['hull-5']);
    expect(ctl._focusId).toBe('hull-5');
  });

  it('a mouse click at the same spot keeps the world-unit slop (misses)', () => {
    const { ctl } = setup(withOwnHull(), 0.1);
    press(ctl, (hullEdge() + 150) * 0.1, 10, 'mouse');
    expect(ctl._selShips.has('hull-5')).toBe(false);
  });

  it('an escort pick takes a touch a few pixels off my own ship', () => {
    const { ctl, feedback } = setup(withOwnHull(), 0.1);
    ctl.setFleetPick('escort');
    press(ctl, (hullEdge() + 150) * 0.1, 10, 'touch');
    expect(feedback.fleetPickResult).toEqual({ kind: 'escort', escortId: 'hull-5' });
  });
});
