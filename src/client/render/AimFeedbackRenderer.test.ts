/**
 * Lock for the faint threat ring (owner's choice 2026-11-10): whenever at
 * least one ship is locking or has locked the local player, the whole threat
 * ring is drawn faintly under the threat arcs, so a lone arc reads as a
 * pointer on a ring round the ship rather than a reticle floating beside it.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { getShipKind } from '@shared-types/shipKinds';
import { THREAT_COLOUR } from '../hud/groupColours';
import { threatRingRadius } from './lockMarkFrame';
import { AimFeedbackRenderer } from './AimFeedbackRenderer.js';

vi.mock('pixi.js', () => {
  class FakeContainer {
    visible = true;
    children: unknown[] = [];
    addChild(c: unknown): void { this.children.push(c); }
  }
  class FakeGraphics extends FakeContainer {
    clear = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    arc = vi.fn().mockReturnThis();
    circle = vi.fn().mockReturnThis();
    closePath = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
  }
  class FakeText extends FakeContainer {
    text = '';
    tint = 0;
    anchor = { set: vi.fn() };
    position = { set: vi.fn() };
    scale = { set: vi.fn() };
  }
  return { Container: FakeContainer, Graphics: FakeGraphics, Text: FakeText };
});

type FakeGfx = { circle: ReturnType<typeof vi.fn>; stroke: ReturnType<typeof vi.fn>; arc: ReturnType<typeof vi.fn> };

const SX = 100, SY = 200;

function mirror(lockedBy: RenderMirror['localLockedBy']): RenderMirror {
  return {
    ships: new Map([
      ['me', { x: SX, y: SY, angle: 0, vx: 0, vy: 0, kind: 'fighter' }],
      ['npc', { x: SX + 400, y: SY, angle: 0, vx: 0, vy: 0, kind: 'fighter' }],
    ]),
    swarm: new Map(),
    localPlayerId: 'me',
    localLockedBy: lockedBy,
  } as unknown as RenderMirror;
}

function setup(): { r: AimFeedbackRenderer; g: FakeGfx } {
  const r = new AimFeedbackRenderer({ addChild: vi.fn() } as never);
  return { r, g: (r as unknown as { fc: FakeGfx }).fc };
}

describe('AimFeedbackRenderer faint threat ring', () => {
  const zoom = 1;
  const px = 1 / zoom;
  const R = threatRingRadius(getShipKind('fighter').radius, px);

  it('no locks on you: no threat ring', () => {
    const { r, g } = setup();
    r.update(mirror(undefined), zoom);
    r.update(mirror([]), zoom);
    expect(g.circle).not.toHaveBeenCalled();
  });

  it.each([
    ['acquiring', 1],
    ['locked', 2],
  ])('a ship %s you: full ring at threatRingRadius, centred on the ship, faint red', (_l, s) => {
    const { r, g } = setup();
    r.update(mirror([{ t: 'p:npc', s, p: 40 }]), zoom);
    const ring = g.circle.mock.calls.filter((c) => c[0] === SX && c[1] === -SY && c[2] === R);
    expect(ring).toHaveLength(1);
    // The stroke right after the ring is the faint one: thin, low alpha, threat red.
    const idx = g.circle.mock.invocationCallOrder[g.circle.mock.calls.indexOf(ring[0]!)]!;
    const strokeIdx = g.stroke.mock.invocationCallOrder.findIndex((o) => o > idx);
    const style = g.stroke.mock.calls[strokeIdx]![0] as { width: number; color: number; alpha: number };
    expect(style.color).toBe(THREAT_COLOUR);
    expect(style.alpha).toBeLessThan(0.35);
    expect(style.width).toBeLessThan(3 * px);
    // Drawn under the arcs: before any arc in the pass.
    expect(g.arc).toHaveBeenCalled();
    expect(idx).toBeLessThan(Math.min(...g.arc.mock.invocationCallOrder));
  });
});
