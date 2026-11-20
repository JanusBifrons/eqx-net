/**
 * The placement ghost turns red BEFORE the click where the server would refuse
 * it (a rock, another structure, a landing pad) and green where it would
 * accept it; the reason rides `RendererFeedback.placementPreviewRejection` for
 * the hint under the ghost. The sent (pending) ghost keeps its own colours.
 */
import { describe, it, expect } from 'vitest';
import type { Graphics } from 'pixi.js';
import { createPlacementGhostCtx, updatePlacementGhost } from './placementGhostUpdater.js';
import { PREVIEW_BLOCKED_COLOR, PREVIEW_OK_COLOR } from './connectorVisual.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
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
  // A stand-in for the built ghost (kind matches the preview ⇒ no rebuild).
  ctx.placementGhost = { tint: 0xffffff, alpha: 1, visible: false, x: 0, y: 0, rotation: 0 } as unknown as Graphics;
  ctx.placementGhostKind = 'connector';
  ctx.camera = { center: { x: 0, y: 0 }, toScreen: (x: number, y: number) => ({ x, y }) } as unknown as Camera;
  ctx.shipContainer = {} as never;
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
    expect(ctx.placementGhost!.tint).toBe(PREVIEW_BLOCKED_COLOR);
  });

  it('ghost is green clear of the rock', () => {
    const { ctx, feedback, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(5000, 0), ctx);
    expect(feedback.placementPreviewRejection).toBeNull();
    expect(ctx.placementGhost!.tint).toBe(PREVIEW_OK_COLOR);
  });

  it('ghost is red over another structure', () => {
    const { ctx, feedback, mirror } = harness([], [['connector', 0, 0]]);
    updatePlacementGhost(mirror(10, 0), ctx);
    expect(feedback.placementPreviewRejection).toBe('overlap-structure');
    expect(ctx.placementGhost!.tint).toBe(PREVIEW_BLOCKED_COLOR);
  });

  it('the sent (pending) ghost is not judged and keeps its colours', () => {
    const { ctx, feedback, mirror } = harness([{ x: 0, y: 0, radius: 120 }]);
    updatePlacementGhost(mirror(0, 0, true), ctx);
    expect(feedback.placementPreviewRejection).toBeNull();
    expect(ctx.placementGhost!.tint).toBe(0xffffff);
  });
});
