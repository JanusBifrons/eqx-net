/**
 * The tap rule (Command, Fly and Build alike): with ships selected, a tap on a
 * ship or structure that is NOT mine keeps the ships selected and FOCUSES it
 * (the left strip shows it; its Lock button orders the attack). A tap on free
 * space deselects, on touch too: a touch tap is never a move or attack order
 * (right-click still is). A focused entity that vanishes is dropped; the ships
 * stay.
 */
import { describe, it, expect, vi } from 'vitest';
import { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera';
import type { RendererFeedback } from '@core/contracts/IRenderer';
import type { RenderMirror } from '@core/contracts/render/RenderMirror';
import type { SelectionBracket } from '../SelectionBracket';

function setup(pointerScale = 1) {
  const camera = {
    // `pointerScale` px per world unit; screen (x, y) = game (x, -y) at 1.
    scale: { x: pointerScale, y: pointerScale },
    screenToWorld: vi.fn((x: number, y: number) => ({ x: x / pointerScale, y: y / pointerScale })),
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
  const mirror = MIRROR();
  // The focus resolves while its entity is still in the mirror's swarm.
  const selectionBracket = {
    resolveFocus: (m: RenderMirror, id: string | null) => id !== null && m.swarm.has(Number(id.slice(6))),
  } as unknown as SelectionBracket;
  const deps = {
    camera: camera as unknown as Camera,
    lastMirror: null as RenderMirror | null,
    galaxyLayer: null, feedback, selectionBracket, fleetOverlay: null,
  };
  const ctl = new RendererInputController(deps);
  ctl.setCommandView(true);
  ctl.selectFleetShips(['ship-2']); // no mirror yet: kept as-is
  deps.lastMirror = mirror;
  return { ctl, feedback, mirror };
}

/** An enemy turret at game (100, -100) = screen (100, 100); my selected
 *  parked hull far away, out of every tap's reach. */
const MIRROR = (): RenderMirror => ({
  localPlayerId: 'me-123',
  ships: new Map([['ship-2', { kind: 'fighter', x: 5000, y: -5000, ownerPlayerId: 'me-123', isActive: false }]]),
  swarm: new Map([[7, { kind: 2, shipKind: 'turret', radius: 20, x: 100, y: -100, angle: 0 }]]),
  structures: new Map([[7, { owner: 'enemy-9' }]]),
} as unknown as RenderMirror);

function tap(ctl: RendererInputController, x: number, y: number, pointerType = 'touch'): void {
  const ev = (type: string, stamp: number) =>
    ({ type, pointerId: 1, offsetX: x, offsetY: y, stamp, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType });
  ctl.forwardPointerEvent(ev('pointerdown', 0));
  ctl.forwardPointerEvent(ev('pointerup', 30));
}

describe('Command view: a tap on an enemy with ships selected focuses it', () => {
  it('touch: focuses the enemy structure, keeps the ships, gives no order', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 100, 100);
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-7');
    expect(ctl._focusKind).toBe('structure');
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });

  it('mouse left-click: the same (ships kept, enemy focused)', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 100, 100, 'mouse');
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._focusId).toBe('swarm-7');
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });

  it('touch zoomed out: a tap a few pixels off the enemy still focuses it (finger slop)', () => {
    // scale 0.1: the turret (game 100, -100) is at screen (10, 10); a tap 12 px
    // right is 120 world units off, beyond the mouse slop, inside the finger's.
    const { ctl } = setup(0.1);
    tap(ctl, 22, 10);
    expect(ctl._focusId).toBe('swarm-7');
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });

  it('a re-tap on the focused enemy drops the focus; the ships stay', () => {
    const { ctl } = setup();
    tap(ctl, 100, 100);
    tap(ctl, 100, 100);
    expect(ctl._focusId).toBeNull();
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });
});

describe('Command view: a tap on free space deselects', () => {
  it('touch: clears the ships and the focus, gives no move order', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 100, 100); // focus the enemy first
    tap(ctl, 600, 600);
    expect(feedback.orderSeq).toBe(0);
    expect(ctl._selShips.size).toBe(0);
    expect(ctl._focusId).toBeNull();
  });
});

describe('a focused enemy that vanishes is dropped; the ships stay', () => {
  it('per frame, after the enemy leaves the mirror', () => {
    const { ctl, mirror } = setup();
    tap(ctl, 100, 100);
    expect(ctl._focusId).toBe('swarm-7');
    // A frame with the enemy still there keeps both.
    ctl.updateSelectionBrackets(mirror, null, true);
    ctl.updateFleetSelection(mirror);
    expect(ctl._focusId).toBe('swarm-7');
    expect([...ctl._selShips]).toEqual(['ship-2']);
    mirror.swarm.delete(7);
    ctl.updateSelectionBrackets(mirror, null, true);
    ctl.updateFleetSelection(mirror);
    expect(ctl._focusId).toBeNull();
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });
});

/**
 * Tap rule T2: the strip's Lock (and the T key) with ships selected and a
 * not-mine focus calls `attackFocus`, which publishes the SAME attack order a
 * right-click gives (`publishOrder`: feedback seq + order flash; gameRafLoop
 * sends it as `sendFleetOrder(ids, { kind: 'attack', targetId })`).
 */
describe('attackFocus (the strip Lock)', () => {
  it('orders the selected ships to attack the focused enemy, at its position', () => {
    const { ctl, feedback } = setup();
    tap(ctl, 100, 100);
    ctl.attackFocus();
    expect(feedback.orderSeq).toBe(1);
    expect(feedback.orderKind).toBe('attack');
    expect(feedback.orderTargetId).toBe('swarm-7');
    expect(feedback.orderX).toBe(100);
    expect(feedback.orderY).toBe(-100);
    expect([...ctl._selShips]).toEqual(['ship-2']);
  });

  it('no order without ships, without a focus, or for a focus of mine', () => {
    const { ctl, feedback, mirror } = setup();
    ctl.attackFocus(); // no focus
    tap(ctl, 100, 100);
    (mirror.structures as Map<number, { owner: string }>).set(7, { owner: 'me-123' });
    ctl.attackFocus(); // now my own structure
    expect(feedback.orderSeq).toBe(0);
    (mirror.structures as Map<number, { owner: string }>).set(7, { owner: 'enemy-9' });
    ctl.selectFleetShips([]);
    ctl.attackFocus(); // no ships
    expect(feedback.orderSeq).toBe(0);
  });
});

/**
 * Tap rule T4: Fly (no Command view) goes through the same pick -> focus. A
 * finger gets the same fingertip slop there as in Command (worker path).
 */
describe('Fly: a touch tap uses the same pick as Command', () => {
  it('zoomed out, a finger a few pixels off the enemy focuses it; a mouse there does not', () => {
    for (const [pointerType, want] of [['touch', 'swarm-7'], ['mouse', null]] as const) {
      const { ctl } = setup(0.1);
      ctl.setCommandView(false);
      ctl.selectFleetShips([]);
      tap(ctl, 22, 10, pointerType);
      expect(ctl._focusId, pointerType).toBe(want);
    }
  });
});
