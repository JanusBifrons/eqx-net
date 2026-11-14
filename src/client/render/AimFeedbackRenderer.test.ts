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

describe('AimFeedbackRenderer.hide', () => {
  it('draws the threat marks in update() and clears them in hide()', () => {
    const children: Array<{ visible: boolean }> = [];
    const r = new AimFeedbackRenderer({ addChild: (c: { visible: boolean }) => children.push(c) } as never);
    r.update(mirror([{ t: 'p:npc', s: 2, p: 100 }]), 1);
    expect(r.lastThreats).toBe(1);
    expect(children.some((c) => c.visible)).toBe(true);

    r.hide();
    expect(r.lastThreats).toBe(0);
    expect(r.lastFcLocks).toBe(0);
    expect(children.every((c) => !c.visible)).toBe(true);
  });
});

// Fight-clip review 2026-11-13: "LOCKING n%" showed DOUBLED over one target.
// Each weapon group building a lock on the same ship drew its own ring + tag,
// so two groups locking one fighter put two tags (at slightly different
// heights, as the tag rides the closing ticks) over it. One target, one tag:
// the furthest-along lock's progress.
describe('AimFeedbackRenderer own-lock tags', () => {
  type Tag = { visible: boolean; text: string };
  const tagsOf = (r: AimFeedbackRenderer): Tag[] => (r as unknown as { tags: Tag[] }).tags.filter((t) => t.visible);
  function own(groups: RenderMirror['localGroups']): RenderMirror {
    return { ...mirror(undefined), localGroups: groups } as RenderMirror;
  }

  it('two groups locking the same target: one tag, showing the furthest-along lock', () => {
    const { r, g } = setup();
    r.update(own([
      { id: 'fore', m: 0, l: [{ t: 'p:npc', s: 1, p: 30 }] },
      { id: 'aft', m: 0, l: [{ t: 'p:npc', s: 1, p: 62 }] },
    ] as RenderMirror['localGroups']), 1);
    const tags = tagsOf(r);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.text).toBe('LOCKING 62%');
    // One progress ring (track circle) on the target, not one per group.
    const NX = SX + 400;
    expect(g.circle.mock.calls.filter((c) => c[0] === NX)).toHaveLength(1);
  });

  it('a building lock beats a draining one on the same target', () => {
    const { r } = setup();
    r.update(own([
      { id: 'fore', m: 0, l: [{ t: 'p:npc', s: 1, p: 70, r: 1 }] },
      { id: 'aft', m: 0, l: [{ t: 'p:npc', s: 1, p: 20 }] },
    ] as RenderMirror['localGroups']), 1);
    const tags = tagsOf(r);
    expect(tags).toHaveLength(1);
    expect(tags[0]!.text).toBe('LOCKING 20%');
  });

  it('two different targets still get a tag each', () => {
    const { r } = setup();
    const m = own([
      { id: 'fore', m: 0, l: [{ t: 'p:npc', s: 1, p: 30 }, { t: 'p:npc2', s: 1, p: 50 }] },
    ] as RenderMirror['localGroups']);
    m.ships.set('npc2', { x: SX - 400, y: SY, angle: 0, vx: 0, vy: 0, kind: 'fighter' } as never);
    r.update(m, 1);
    expect(tagsOf(r).map((t) => t.text).sort()).toEqual(['LOCKING 30%', 'LOCKING 50%']);
  });
});
