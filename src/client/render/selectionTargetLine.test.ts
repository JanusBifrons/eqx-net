import { describe, expect, it } from 'vitest';
import type { Graphics } from 'pixi.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { resolveEntityPos } from './FleetOverlay.js';
import {
  TARGET_LINE_HOSTILE,
  TARGET_LINE_NEUTRAL,
  drawTargetLine,
  lockKeyNamesPick,
  lockLinkShowing,
  targetLineHostile,
  targetLineWanted,
} from './selectionTargetLine.js';

const groups = (...keys: string[]) => [{ id: 'g0', m: 0, l: keys.map((t) => ({ t, s: 2, p: 100 })) }];

describe('lockKeyNamesPick', () => {
  it('matches swarm and ship ids by their lock key', () => {
    expect(lockKeyNamesPick('s:42', 'swarm-42')).toBe(true);
    expect(lockKeyNamesPick('s:42', 'swarm-4')).toBe(false);
    expect(lockKeyNamesPick('s:42', 'swarm-43')).toBe(false);
    expect(lockKeyNamesPick('p:abc', 'abc')).toBe(true);
    expect(lockKeyNamesPick('p:abc', 'xabc')).toBe(false);
    expect(lockKeyNamesPick('p:42', 'swarm-42')).toBe(false);
  });
});

describe('the line-skip rule', () => {
  const sel = new Set(['a', 'b']);

  it('draws to a focus outside the selection', () => {
    expect(targetLineWanted(sel, 'swarm-7', undefined)).toBe(true);
    expect(targetLineWanted(sel, 'swarm-7', groups('s:8'))).toBe(true);
  });

  it('skips while the lock link to that target is showing (held or building)', () => {
    expect(lockLinkShowing(groups('s:7'), 'swarm-7')).toBe(true);
    expect(targetLineWanted(sel, 'swarm-7', groups('s:7'))).toBe(false);
    const building = [{ id: 'g0', m: 0, l: [{ t: 'p:enemy', s: 1, p: 40 }] }];
    expect(targetLineWanted(sel, 'enemy', building)).toBe(false);
  });

  it('no line without a selection, without a focus, or to a selected ship', () => {
    expect(targetLineWanted(new Set(), 'swarm-7', undefined)).toBe(false);
    expect(targetLineWanted(sel, null, undefined)).toBe(false);
    expect(targetLineWanted(sel, 'a', undefined)).toBe(false);
  });
});

function mirrorWith(extra: Partial<RenderMirror>): RenderMirror {
  const ships = new Map([
    ['a', { x: 0, y: 0 }],
    ['b', { x: 200, y: 0 }],
  ]);
  return { ships, swarm: new Map([[7, { x: 100, y: 300, isHostileToLocal: false }]]), ...extra } as unknown as RenderMirror;
}

describe('targetLineHostile', () => {
  it('a drone hunting you, or anything locking you, is hostile', () => {
    const m = mirrorWith({});
    expect(targetLineHostile(m, 'swarm-7')).toBe(false);
    (m.swarm!.get(7) as { isHostileToLocal: boolean }).isHostileToLocal = true;
    expect(targetLineHostile(m, 'swarm-7')).toBe(true);
    const locking = mirrorWith({ localLockedBy: [{ t: 'p:enemy', s: 2, p: 100 }] } as Partial<RenderMirror>);
    expect(targetLineHostile(locking, 'enemy')).toBe(true);
    expect(targetLineHostile(locking, 'other')).toBe(false);
  });
});

describe('drawTargetLine', () => {
  function fakeG() {
    const circles: [number, number][] = [];
    const fills: { color: number }[] = [];
    const g = {
      circle(x: number, y: number) { circles.push([x, y]); return g; },
      fill(f: { color: number }) { fills.push(f); return g; },
    };
    return { g: g as unknown as Graphics, circles, fills };
  }
  const project = (x: number, y: number, out: { x: number; y: number }) => { out.x = x; out.y = y; };

  it('dots from the selection centroid to the target, neutral colour, none on either end', () => {
    const { g, circles, fills } = fakeG();
    const n = drawTargetLine(g, mirrorWith({}), new Set(['a', 'b']), 'swarm-7', resolveEntityPos, project, { x: 0, y: 0 });
    // centroid (100, 0) → target (100, 300): 300 px / 10 px gap = 30 slots, 29 interior dots.
    expect(n).toBe(29);
    expect(circles.length).toBe(29);
    expect(circles[0]).toEqual([100, -10]);
    expect(circles[28]![1]).toBeCloseTo(-290);
    expect(fills).toEqual([expect.objectContaining({ color: TARGET_LINE_NEUTRAL })]);
  });

  it('red for a hostile; nothing when the target is gone', () => {
    const m = mirrorWith({});
    (m.swarm!.get(7) as { isHostileToLocal: boolean }).isHostileToLocal = true;
    const a = fakeG();
    drawTargetLine(a.g, m, new Set(['a']), 'swarm-7', resolveEntityPos, project, { x: 0, y: 0 });
    expect(a.fills[0]!.color).toBe(TARGET_LINE_HOSTILE);
    const b = fakeG();
    expect(drawTargetLine(b.g, m, new Set(['a']), 'swarm-9', resolveEntityPos, project, { x: 0, y: 0 })).toBe(0);
    expect(b.circles.length).toBe(0);
  });
});
