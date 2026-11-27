/**
 * The placement ghost turns red BEFORE the click where the server would refuse
 * it (a rock, another structure, a landing pad) and green where it would
 * accept it; the reason rides `RendererFeedback.placementPreviewRejection` for
 * the hint under the ghost. The sent (pending) ghost keeps its own colours.
 *
 * The ghost is the unbuilt-blueprint HOLOGRAM art (owner: "a bright cyan
 * hologram ... turning red where it's blocked"): cyan when clear, red when
 * blocked, recoloured by tint only (no art rebuild per frame).
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import { createPlacementGhostCtx, updatePlacementGhost } from './placementGhostUpdater.js';
import { GHOST_BLOCKED_COLOR, GHOST_CLEAR_COLOR, HOLOGRAM_LABEL, StructureHologram } from './structureHologram.js';
import { getStructureKind, structureKindToIndex } from '../../../shared-types/structureKinds.js';
import type { RenderMirror, RendererFeedback, SwarmRenderState, StructureRenderState } from '../../../core/contracts/IRenderer.js';
import type { GridObstacle } from '../../../core/structures/Grid.js';
import type { RendererInputController } from './rendererInputController.js';
import type { Camera } from '../worker/Camera.js';

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: [], ringHead: 0,
    radius: getStructureKind(shipKind).radius,
    kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}
const builtState = (): StructureRenderState =>
  ({ powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0 }) as StructureRenderState;

function harness(obstacles: GridObstacle[], structures: Array<[string, number, number]> = []) {
  const swarm = new Map<number, SwarmRenderState>();
  const sts = new Map<number, StructureRenderState>();
  structures.forEach(([k, x, y], i) => { swarm.set(i + 1, structureEntry(k, x, y)); sts.set(i + 1, builtState()); });
  const input = { _placementActive: false, _placementChosenX: null, _placementChosenY: null, _placementFollowing: true } as unknown as RendererInputController;
  const feedback = { placementPreviewRejection: null } as unknown as RendererFeedback;
  const ctx = createPlacementGhostCtx({ isTouch: false, input, feedback });
  ctx.camera = { center: { x: 0, y: 0 }, toScreen: (x: number, y: number) => ({ x, y }) } as unknown as Camera;
  ctx.shipContainer = new Container();
  ctx.obstacles = obstacles;
  const mirror = (x: number, y: number, pending = false): RenderMirror => ({
    swarm, structures: sts,
    pendingPlacementPreview: { kind: 'connector', x, y, angle: 0, ...(pending ? { pending: true } : {}) },
  }) as unknown as RenderMirror;
  return { ctx, feedback, mirror };
}

describe('placement ghost: red or green by the server rule', () => {
  it('ghost is red over a rock, with the server\'s reason', () => {
    const { ctx, feedback, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(0, 0), ctx);
    expect(feedback.placementPreviewRejection).toBe('overlap-obstacle');
    expect(ctx.placementGhost!.tint).toBe(GHOST_BLOCKED_COLOR);
  });

  it('ghost is green clear of the rock', () => {
    const { ctx, feedback, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(5000, 0), ctx);
    expect(feedback.placementPreviewRejection).toBeNull();
    expect(ctx.placementGhost!.tint).toBe(GHOST_CLEAR_COLOR);
  });

  it('ghost is red on top of a PLANNED building (preview.plan), with the batch reason', () => {
    const { ctx, feedback, mirror } = harness([]);
    const m = mirror(10, 0);
    m.pendingPlacementPreview!.plan = [0, 0, 0, structureKindToIndex('connector'), 0];
    updatePlacementGhost(m, ctx);
    expect(feedback.placementPreviewRejection).toBe('overlap-structure');
    expect(ctx.placementGhost!.tint).toBe(GHOST_BLOCKED_COLOR);
    expect(ctx.runGhosts!.plannedDrawn).toBe(1);
  });

  it('ghost is red over another structure', () => {
    const { ctx, feedback, mirror } = harness([], [['connector', 0, 0]]);
    updatePlacementGhost(mirror(10, 0), ctx);
    expect(feedback.placementPreviewRejection).toBe('overlap-structure');
    expect(ctx.placementGhost!.tint).toBe(GHOST_BLOCKED_COLOR);
  });

  it('the sent (pending) ghost is not judged: a dim, still cyan hologram', () => {
    const { ctx, feedback, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(0, 0, true), ctx);
    expect(feedback.placementPreviewRejection).toBeNull();
    expect(ctx.placementGhost!.tint).toBe(GHOST_CLEAR_COLOR);
    expect(ctx.placementGhost!.alpha).toBeLessThan(0.6);
    expect(ctx.placementGhost!.line.visible).toBe(false);
  });
  it('right after Place the held ghost on its own new structure is dim, not red, and keeps the pointer', () => {
    const { ctx, feedback, mirror } = harness([], [['connector', 0, 0]]);
    const m = mirror(0, 0);
    m.pendingPlacementPreview!.held = true;
    updatePlacementGhost(m, ctx);
    expect(feedback.placementPreviewRejection).toBeNull();
    expect(ctx.placementGhost!.tint).toBe(GHOST_CLEAR_COLOR);
    expect(ctx.placementGhost!.alpha).toBeLessThan(0.6);
    expect(ctx.input._placementActive).toBe(true); // still the live ghost
    // Moved off the spot (held cleared): the real verdict is back.
    m.pendingPlacementPreview!.held = false;
    updatePlacementGhost(m, ctx);
    expect(feedback.placementPreviewRejection).toBe('overlap-structure');
  });
});

describe('placement ghost: the bright hologram', () => {
  it('the placement ghost uses the hologram art', () => {
    const { ctx, mirror } = harness([]);
    updatePlacementGhost(mirror(5000, 0), ctx);
    const g = ctx.placementGhost!;
    expect(g).toBeInstanceOf(StructureHologram);
    expect(g.label).toBe(HOLOGRAM_LABEL);
    expect(g.parent).toBe(ctx.shipContainer);
    // The plan's footprint, the whole plan shown (no build mask), and bright.
    expect(g.halfW).toBe(getStructureKind('connector').footprint.w / 2);
    expect(g.ahead.mask ?? null).toBeNull();
    expect(g.ahead.visible).toBe(true);
    expect(g.alpha).toBeGreaterThan(0.75);
  });

  it('a blocked ghost is red, a clear one cyan', () => {
    const { ctx, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(0, 0), ctx);
    expect(ctx.placementGhost!.tint).toBe(GHOST_BLOCKED_COLOR);
    updatePlacementGhost(mirror(5000, 0), ctx);
    expect(ctx.placementGhost!.tint).toBe(GHOST_CLEAR_COLOR);
    expect(GHOST_CLEAR_COLOR).not.toBe(GHOST_BLOCKED_COLOR);
  });

  it('switching valid↔blocked recolours without rebuilding the art (no allocation per frame)', () => {
    const { ctx, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    const clear = mirror(5000, 0), blocked = mirror(0, 0);
    updatePlacementGhost(clear, ctx);
    const g = ctx.placementGhost!;
    const art = g.ahead.context, line = g.line.context, children = g.children.length;
    for (let i = 0; i < 6; i++) {
      ctx.nowMs = i * 250;
      updatePlacementGhost(i % 2 ? blocked : clear, ctx);
      expect(ctx.placementGhost).toBe(g);
      expect(g.ahead.context).toBe(art);
      expect(g.line.context).toBe(line);
      expect(g.children.length).toBe(children);
      expect(g.tint).toBe(i % 2 ? GHOST_BLOCKED_COLOR : GHOST_CLEAR_COLOR);
    }
    expect(ctx.shipContainer!.children.length).toBe(1);
  });

  it('the scanner sweeps and the ghost pulses on the game clock', () => {
    const { ctx, mirror } = harness([]);
    const m = mirror(5000, 0);
    ctx.nowMs = 0; updatePlacementGhost(m, ctx);
    const g = ctx.placementGhost!;
    const x0 = g.line.x, a0 = g.alpha;
    ctx.nowMs = 400; updatePlacementGhost(m, ctx);
    expect(g.line.visible).toBe(true);
    expect(g.line.x).toBeGreaterThan(x0);
    expect(g.line.x).toBeLessThanOrEqual(g.halfW);
    expect(g.alpha).not.toBe(a0);
    expect(g.alpha).toBeGreaterThan(0.75);
  });
});
