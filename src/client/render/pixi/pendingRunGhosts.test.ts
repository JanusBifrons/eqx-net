/**
 * The fence run's ghosts (sent + hover) share one look: pooled placement
 * ghosts and fence beam bodies, drawn by the placement ghost pass.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { PlacementGhostVerdict } from '../../structures/placementGhostVerdict.js';
import { HOVER_ALPHA, PendingRunGhosts, RUN_GHOST_CAP, type RunGhostFrame } from './pendingRunGhosts.js';

function frame(preview: Record<string, unknown>, ghostX = 1e6, ghostY = 1e6): RunGhostFrame {
  const pv = { kind: 'shield_pylon', x: 0, y: 0, angle: 0, ...preview };
  const mirror = { swarm: new Map(), structures: new Map(), pendingPlacementPreview: pv } as unknown as RenderMirror;
  return {
    mirror, preview: pv as RunGhostFrame['preview'], verdict: new PlacementGhostVerdict(), obstacles: null, deck: null,
    ghostX, ghostY, scale: 1, nowMs: 0,
  };
}

function visiblePosts(parent: Container): Container[] {
  return parent.children.filter((c) => c.label === 'hologram' && c.visible) as Container[];
}

describe('fence run ghosts', () => {
  it('the sent run: a solid ghost per corner, a NaN pair breaks the beams', () => {
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    rg.update(frame({ run: [0, 0, 100, 0, NaN, NaN, 100, 0, 100, 100] }));
    expect(rg.sentPosts).toBe(4);
    expect(visiblePosts(parent).length).toBe(4);
    expect(visiblePosts(parent)[0]!.alpha).toBeCloseTo(0.45);
  });

  it('the hover run: faint ghosts at new corners only, beams between all corners', () => {
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    rg.update(frame({ runHover: [0, 0, 100, 0, 200, 0, 300, 0], runHoverMark: [0, 0, 1, 1] }));
    expect(rg.hoverPosts).toBe(2);
    expect(rg.hoverBeams).toBe(3);
    expect(rg.hoverStop).toBe(-1);
    for (const p of visiblePosts(parent)) expect(p.alpha).toBeLessThanOrEqual(HOVER_ALPHA + 1e-9);
  });

  it('the refused corner ends the hover run there (red, nothing past it)', () => {
    const rg = new PendingRunGhosts(new Container(), undefined);
    rg.update(frame({ runHover: [0, 0, 100, 0, 200, 0, 300, 0], runHoverMark: [0, 1, 2, 1] }));
    expect(rg.hoverStop).toBe(2);
    expect(rg.hoverPosts).toBe(2);
    expect(rg.hoverBeams).toBe(2);
  });

  it('the hovered corner is the single ghost: not drawn twice', () => {
    const rg = new PendingRunGhosts(new Container(), undefined);
    rg.update(frame({ runHover: [0, 0, 100, 0], runHoverMark: [0, 1] }, 100, 0));
    expect(rg.hoverPosts).toBe(0);
    expect(rg.hoverBeams).toBe(1);
  });

  it('the pool is capped, reused, and hides with no preview', () => {
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    const run: number[] = [];
    for (let i = 0; i < 40; i++) run.push(i * 100, 0);
    rg.update(frame({ run }));
    expect(visiblePosts(parent).length).toBe(RUN_GHOST_CAP);
    rg.hide();
    expect(visiblePosts(parent).length).toBe(0);
    rg.update(frame({ run }));
    expect(parent.children.filter((c) => c.label === 'hologram').length).toBe(RUN_GHOST_CAP);
  });
});
