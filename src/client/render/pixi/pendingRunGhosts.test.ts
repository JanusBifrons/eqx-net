/**
 * The fence run's ghosts (sent + hover) share one look: pooled placement
 * ghosts and fence beam bodies, drawn by the placement ghost pass.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { PlacementGhostVerdict } from '../../structures/placementGhostVerdict.js';
import { HOVER_ALPHA, HOVER_BEAM_ALPHA, PendingRunGhosts, PLANNED_GHOST_CAP, RUN_GHOST_CAP, addPlanFootprints, type RunGhostFrame } from './pendingRunGhosts.js';
import { PLACE_STRUCTURES_MAX } from '../../../shared-types/messages.js';
import { structureKindToIndex } from '../../../shared-types/structureKinds.js';
import { GHOST_BLOCKED_COLOR, GHOST_PLANNED_COLOR } from './structureHologram.js';
import { BatchPlacementChecker, batchPlacementRejections, type BatchPlacementItem } from '../../../core/structures/batchPlacement.js';
import type { PlacementDeck, PlacementRejection } from '../../../core/structures/placementRules.js';
import { PlateSet } from '../../../core/hex/plateSet.js';
import { deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../../../core/hex/plates.js';

/** A stride-5 `preview.plan` of `n` solars in a row (`refused` indices flagged). */
function plan(n: number, refused: number[] = []): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i * 1000, 0, 0, structureKindToIndex('solar'), refused.includes(i) ? 2 : 0);
  return out;
}

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
    // Beams read stronger than the posts (owner): their own Graphics, at the beam alpha.
    const beams = parent.children.find((c) => c.label !== 'hologram' && c.visible && c.alpha === HOVER_BEAM_ALPHA);
    expect(beams).toBeDefined();
    expect(HOVER_BEAM_ALPHA).toBeGreaterThan(HOVER_ALPHA);
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

describe('planned ghosts (plan then Build)', () => {
  it('draws every planned building, the refused ones red, the rest the planned tint', () => {
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    rg.update(frame({ plan: plan(3, [1]) }));
    expect(rg.plannedDrawn).toBe(3);
    expect(rg.plannedRefused).toBe(1);
    const tints = (visiblePosts(parent) as unknown as Array<{ tint: number; x: number }>).sort((a, b) => a.x - b.x).map((g) => g.tint);
    expect(tints).toEqual([GHOST_PLANNED_COLOR, GHOST_BLOCKED_COLOR, GHOST_PLANNED_COLOR]);
  });

  it('a full plan (32) draws whole and steals no sent / hover run slot', () => {
    expect(PLANNED_GHOST_CAP).toBe(PLACE_STRUCTURES_MAX);
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    const run: number[] = [];
    for (let i = 0; i < 40; i++) run.push(i * 100, 5000);
    rg.update(frame({ plan: plan(PLACE_STRUCTURES_MAX), run, runHover: [0, -5000, 100, -5000], runHoverMark: [0, 1] }));
    expect(rg.plannedDrawn).toBe(PLACE_STRUCTURES_MAX);
    expect(rg.sentPosts + rg.hoverPosts).toBe(RUN_GHOST_CAP);
    expect(visiblePosts(parent).length).toBe(PLACE_STRUCTURES_MAX + RUN_GHOST_CAP);
  });

  it('a shorter plan hides the rest; hide() hides all; the pool is reused', () => {
    const parent = new Container();
    const rg = new PendingRunGhosts(parent, undefined);
    rg.update(frame({ plan: plan(5) }));
    rg.update(frame({ plan: plan(2) }));
    expect(visiblePosts(parent).length).toBe(2);
    rg.hide();
    expect(visiblePosts(parent).length).toBe(0);
    rg.update(frame({ plan: plan(5) }));
    expect(parent.children.filter((c) => c.label === 'hologram').length).toBe(5);
  });

  it('addPlanFootprints: the live ghost verdict reads the plan as placed', () => {
    const f = frame({});
    addPlanFootprints(f.verdict, plan(1));
    expect(f.verdict.check({ kind: 'solar', x: 10, y: 0, angle: 0 }, new Map(), new Map(), null)).toBe('overlap-structure');
    addPlanFootprints(f.verdict, undefined);
    expect(f.verdict.check({ kind: 'solar', x: 10, y: 0, angle: 0 }, new Map(), new Map(), null)).toBeNull();
  });

  it('a planned plate-laying connector makes its plate deck for the live ghost; the batch check agrees (parity)', () => {
    const ps = new PlateSet<string>();
    const home = plateCentreWorldInto(0, 0, { x: 0, y: 0 });
    ps.upsert('me-plate', 'me', 'connector', home.x, home.y);
    const deck: PlacementDeck = { plates: ps, owner: 'me' };
    const plate = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    const h = plateHexes(1, 0)[2]!;
    const on = deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
    const kind = 'solar';
    const f = frame({});
    const judge = (d: PlacementDeck | null): PlacementRejection | null =>
      f.verdict.check({ kind, x: on.x, y: on.y, angle: 0 }, new Map(), new Map(), null, d);
    // No plan: the new plate is open space, off the deck.
    expect(judge(addPlanFootprints(f.verdict, undefined, deck))).toBe('off-deck');
    // The connector that lays it is planned: the plate is deck, the ghost is green.
    const p = [plate.x, plate.y, 0, structureKindToIndex('connector'), 0];
    expect(judge(addPlanFootprints(f.verdict, p, deck))).toBeNull();
    // The batch check (server's place_structures) agrees on the same plan.
    const items: BatchPlacementItem[] = [{ kind: 'connector', x: plate.x, y: plate.y, rot: 0 }, { kind, x: on.x, y: on.y, rot: 0 }];
    const idx: number[] = [], code: PlacementRejection[] = [];
    batchPlacementRejections(new BatchPlacementChecker(), items, [], deck, idx, code);
    expect(idx).toEqual([]);
    // No deck room: stays null (no deck rule at all).
    expect(addPlanFootprints(f.verdict, p, null)).toBeNull();
  });
});
