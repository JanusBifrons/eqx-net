/**
 * Campaign PR 3.2 (anti-patterns review 2026-07, B4 / C-client 2 / Part D
 * #4) — failing-first lock for SUBTYPE-level entityId recycling.
 *
 * The #20 fix (kindRecycle.test.ts) rebuilds a cached sprite when a recycled
 * entityId flips its pose-core KIND (structure 2 → drone 1). But the sprite
 * is BUILT from `(kind, shipKind, componentIndex, radius)` while the recycle
 * guard compared `kind` ONLY — so a recycled id that keeps the same kind but
 * changes SUBTYPE kept the stale silhouette:
 *   - structure → structure (connector → turret): the "structures render as
 *     the last thing destroyed" playtest family;
 *   - drone → drone (fighter → heavy): a Heavy that reads as a fighter;
 *   - scrap → scrap with a different componentIndex: the wrong debris shape.
 *
 * RED pre-fix: each case below reuses the SAME sprite object. GREEN: the
 * updater tracks the full build signature and rebuilds on any component
 * change. Mirrors the kindRecycle harness.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import type {
  RenderMirror,
  SwarmRenderState,
  StructureRenderState,
  PoseRingEntry,
} from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  }
  return ring;
}

function swarmEntry(over: Partial<SwarmRenderState>): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 12, kind: 1, shipKind: 'fighter',
    sleeping: true, lastUpdateTick: 0,
    ...over,
  } as SwarmRenderState;
}

function structureState(): StructureRenderState {
  return { powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0 } as unknown as StructureRenderState;
}

function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Graphics>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    slewDtSec: 1 / 60,
  } as SwarmSpriteCtx;
}

function frame(ctx: SwarmSpriteCtx, entityId: number, entry: SwarmRenderState, withStructure: boolean): void {
  const mirror = {
    swarm: new Map<number, SwarmRenderState>([[entityId, entry]]),
    structures: withStructure
      ? new Map<number, StructureRenderState>([[entityId, structureState()]])
      : new Map<number, StructureRenderState>(),
  } as unknown as RenderMirror;
  updateSwarmSprites(mirror, ctx);
}

describe('updateSwarmSprites — SUBTYPE-level entityId recycle (campaign 3.2)', () => {
  let ctx: SwarmSpriteCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('rebuilds when a recycled id flips structure SUBTYPE (connector → turret)', () => {
    const key = 'swarm-5';
    frame(ctx, 5, swarmEntry({ kind: 2, shipKind: 'connector', radius: 20 }), true);
    const before = ctx.sprites.get(key)!;
    frame(ctx, 5, swarmEntry({ kind: 2, shipKind: 'turret', radius: 20 }), true);
    expect(ctx.sprites.get(key), 'turret must not reuse the connector silhouette').not.toBe(before);
  });

  it('rebuilds when a recycled id flips drone SHIP KIND (fighter → heavy)', () => {
    const key = 'swarm-6';
    frame(ctx, 6, swarmEntry({ kind: 1, shipKind: 'fighter' }), false);
    const before = ctx.sprites.get(key)!;
    frame(ctx, 6, swarmEntry({ kind: 1, shipKind: 'heavy' }), false);
    expect(ctx.sprites.get(key), 'heavy must not reuse the fighter silhouette').not.toBe(before);
  });

  it('rebuilds when a recycled scrap id changes componentIndex', () => {
    const key = 'swarm-7';
    frame(ctx, 7, swarmEntry({ kind: 3, shipKind: 'crossguard', componentIndex: 0 } as Partial<SwarmRenderState>), false);
    const before = ctx.sprites.get(key)!;
    frame(ctx, 7, swarmEntry({ kind: 3, shipKind: 'crossguard', componentIndex: 1 } as Partial<SwarmRenderState>), false);
    expect(ctx.sprites.get(key), 'a different scrap component must not reuse the old debris shape').not.toBe(before);
  });

  it('does NOT rebuild when nothing changed (cache stays hot)', () => {
    const key = 'swarm-8';
    frame(ctx, 8, swarmEntry({ kind: 1, shipKind: 'fighter' }), false);
    const before = ctx.sprites.get(key)!;
    frame(ctx, 8, swarmEntry({ kind: 1, shipKind: 'fighter' }), false);
    expect(ctx.sprites.get(key)).toBe(before);
  });
});
