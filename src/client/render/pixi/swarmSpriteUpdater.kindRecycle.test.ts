/**
 * Entity-kind-recycle regression lock (Equinox Phase 3 WS-E #20, plan:
 * i-d-like-you-to-magical-summit; Invariant #13 — failing test FIRST).
 *
 * On-device smoke: drones sometimes render AS the last-destroyed entity — a
 * connector or a defence turret. Root cause (confirmed): the SERVER swarm
 * registry recycles the dense u16 `entityId` (a destroyed structure's id is
 * pushed onto a free-list and handed to the next spawn), and the client caches
 * sprites by `swarm-${entityId}`. `updateSwarmSprites` only built a sprite on
 * the FIRST sighting (`if (!sprite)`) and NEVER rebuilt it when the cached
 * entityId's `kind` byte flipped — so when a structure (kind 2) was destroyed
 * and a drone (kind 1) reused that entityId, the stale STRUCTURE sprite was
 * reused for the drone.
 *
 * The reaper sweep that despawns sprites (PixiRenderer.update) only fires for
 * entities ABSENT from the frame's `seen` set — a recycled entityId stays
 * present (its `kind` merely changes), so the sweep never catches it. The fix
 * lives in `updateSwarmSprites`: track each cached sprite's kind and REBUILD
 * (destroy + recreate, tearing down the structure's barrel cluster + slew
 * state) when it changes.
 *
 * This reads the REAL drawn artifact — the cached sprite identity + the
 * structure-only `buildEta` child + the structure slew-state map — NOT a
 * recompute. Before the fix it FAILS: the cached structure sprite is reused, so
 * the recycled drone's sprite is byte-identical to the structure's and still
 * carries the structure `buildEta` child.
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

function structureEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 36, kind: 2, shipKind,
    sleeping: true, lastUpdateTick: 0,
  };
}

function droneEntry(shipKind: string, x: number, y: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius: 12, kind: 1, shipKind,
    sleeping: true, lastUpdateTick: 0,
  };
}

function structureState(over: Partial<StructureRenderState>): StructureRenderState {
  return { powered: true, netPower: 10, connTo: [], built: true, buildPct: 1, deconstructPct: 0, ...over };
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
    slewDtSec: 1 / 60,
  };
}

describe('updateSwarmSprites — entityId recycle across kinds (#20)', () => {
  let ctx: SwarmSpriteCtx;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it('REBUILDS the sprite when a recycled entityId flips structure (kind 2) → drone (kind 1)', () => {
    const entityId = 5;
    const key = `swarm-${entityId}`;

    // Frame 1: entityId 5 is a TURRET (kind 2). A structure sprite is built +
    // cached; it carries the structure-only `buildEta` child + slew state.
    let mirror: RenderMirror = {
      swarm: new Map<number, SwarmRenderState>([[entityId, structureEntry('turret', 0, 0)]]),
      structures: new Map<number, StructureRenderState>([[entityId, structureState({ turretTargetId: undefined })]]),
    } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);

    const structureSprite = ctx.sprites.get(key)!;
    expect(structureSprite).toBeDefined();
    expect(structureSprite.getChildByLabel('buildEta'), 'structure has a buildEta child').not.toBeNull();
    expect(ctx.structureMountAngles.has(key), 'structure seeded slew state').toBe(true);

    // entityId 5 is destroyed + RECYCLED for a drone: the next frame's mirror
    // carries the SAME entityId with kind 1 (decoder mutates the entry in place;
    // here we install the drone entry under the same key, the same net effect).
    mirror = {
      swarm: new Map<number, SwarmRenderState>([[entityId, droneEntry('fighter', 0, 0)]]),
      structures: new Map<number, StructureRenderState>(),
    } as unknown as RenderMirror;
    updateSwarmSprites(mirror, ctx);

    const droneSprite = ctx.sprites.get(key)!;
    // (1) the sprite was REBUILT — a fresh object, not the recycled structure.
    expect(droneSprite, 'drone sprite is a NEW object, not the recycled structure').not.toBe(structureSprite);
    // (2) it no longer carries the structure-only buildEta child.
    expect(droneSprite.getChildByLabel('buildEta'), 'rebuilt drone has no buildEta child').toBeNull();
    // (3) the stale structure slew-state was torn down (no leak / mismatch).
    expect(ctx.structureMountAngles.has(key), 'structure slew state cleared on rebuild').toBe(false);
    // (4) the kind tracker reflects the new kind.
    expect(ctx.spriteKinds.get(key)).toBe(1);
  });
});
