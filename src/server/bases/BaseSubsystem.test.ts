/**
 * BaseSubsystem destruction locks (plan: soft-leaping-truffle, PR-D).
 */
import { describe, expect, it, vi } from 'vitest';
import { BaseSubsystem, groupSplitPieces } from './BaseSubsystem.js';
import { BASE_GENERATOR_VERSION, LayoutBuilder } from '../../core/procgen/baseLayout.js';
import { basePieceIndex, basePieceKindAt } from '../../shared-types/basePieceKinds.js';
import { isPieceDead } from '../../core/procgen/baseChunkMesh.js';

const SPEC = { archetype: 'warehouse' as const, seed: 42, x: 0, y: 0, size: 6000 };

function make(hpScale = 1) {
  const onDestroyed = vi.fn();
  const sub = new BaseSubsystem({ spawnInWorker: vi.fn(), writeState: vi.fn(), onDestroyed }, { hpScale });
  const layout = sub.add('b0', SPEC);
  return { sub, layout, onDestroyed };
}

/** A ray from outside the base straight at the first rack piece's centre. */
function aimAtRack(layout: ReturnType<typeof make>['layout']) {
  const rack = basePieceIndex('rack_row');
  for (let i = 0; i < layout.count; i++) {
    if (layout.kind[i] !== rack) continue;
    const cx = layout.x[i]! + layout.w[i]! / 2;
    const cy = layout.y[i]! + layout.h[i]! / 2;
    // Fire along +x from 30 u left of the piece's left edge.
    return { i, ox: layout.x[i]! - 30, oy: cy, cx };
  }
  throw new Error('no rack');
}

describe('groupSplitPieces', () => {
  it('groups the halves of a piece the builder split at a chunk line', () => {
    const b = new LayoutBuilder(4096);
    b.addRect(basePieceIndex('rack_row'), -512, 0, 512, 300); // crosses x = 0 (a chunk line)
    b.addRect(basePieceIndex('rack_row'), 2100, 0, 2400, 300); // separate piece (no chunk line inside)
    const l = b.build({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 0, x: 0, y: 0, size: 8192 }, 0);
    expect(l.count).toBe(3);
    const { group, groupCount } = groupSplitPieces(l);
    expect(groupCount).toBe(2);
    expect(group[0]).toBe(group[1]);
    expect(group[2]).not.toBe(group[0]);
  });
});

describe('BaseSubsystem — destruction', () => {
  it('a shot damages the piece it hits; enough damage destroys its whole group', () => {
    const { sub, layout, onDestroyed } = make();
    const t = aimAtRack(layout);
    const hp = basePieceKindAt(layout.kind[t.i]!).hp;
    // Below the hit points: blocked, nothing destroyed.
    expect(sub.shotHit(t.ox, t.oy, 1, 0, 1000, hp / 2)).toBeGreaterThan(0);
    expect(onDestroyed).not.toHaveBeenCalled();
    // Finishing it off destroys the group (every split half).
    sub.shotHit(t.ox, t.oy, 1, 0, 1000, hp);
    expect(onDestroyed).toHaveBeenCalledTimes(1);
    const destroyed = onDestroyed.mock.calls[0]![2] as number[];
    expect(destroyed).toContain(t.i);
    const { group } = groupSplitPieces(layout);
    for (let i = 0; i < layout.count; i++) {
      expect(isPieceDead(sub.deadMask('b0'), i)).toBe(group[i] === group[t.i]);
    }
  });

  it('after the piece is destroyed, the same shot passes through the hole', () => {
    const { sub, layout } = make(0.0001);
    const t = aimAtRack(layout);
    const before = sub.rayFirst(t.ox, t.oy, 1, 0, 1000);
    sub.shotHit(t.ox, t.oy, 1, 0, 1000, 10); // one shot breaks it (hpScale trigger)
    const after = sub.rayFirst(t.ox, t.oy, 1, 0, 1000);
    expect(before).toBeGreaterThan(0);
    expect(after < 0 || after > before + layout.w[t.i]! - 1).toBe(true);
  });

  it('projectiles damage pieces too, and the spawn check sees the hole', () => {
    const { sub, layout, onDestroyed } = make(0.0001);
    const t = aimAtRack(layout);
    const inside = { x: t.cx, y: layout.y[t.i]! + layout.h[t.i]! / 2 };
    expect(sub.isPointClear(inside.x, inside.y, 5)).toBe(false);
    expect(sub.projectileHit(t.ox, t.oy, 60, 0, 10)).toBe(true);
    expect(onDestroyed).toHaveBeenCalled();
    expect(sub.isPointClear(inside.x, inside.y, 5)).toBe(true);
  });

  it('setHpScale only before any base exists', () => {
    const sub = new BaseSubsystem({ spawnInWorker: vi.fn(), writeState: vi.fn() });
    sub.setHpScale(0.5);
    sub.add('b0', SPEC);
    expect(() => sub.setHpScale(1)).toThrow();
  });
});
