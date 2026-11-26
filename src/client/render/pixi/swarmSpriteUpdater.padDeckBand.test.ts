/**
 * Teleporter chamber vs ships (invariant #13 — failing test first).
 *
 * Seen filming the teleporterRide shot: a heavy flying into the chamber was
 * hidden under its floor plating and floor lights. Structure and hull sprites
 * share zIndex 0 on `shipContainer` and stack by add order, so a chamber built
 * (or re-built on an art swap) after the ship drew its whole floor over it.
 * The chamber is a pad deck ships fly into: it rides the pad-deck band
 * (`RIG_UNDER_Z`, the freight dock apron's) below every hull, whatever the
 * add order. Other structures keep the hull band.
 */
import { describe, it, expect } from 'vitest';
import { Container } from 'pixi.js';
import type { Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { RIG_UNDER_Z } from './structureRigs.js';
import type { RenderMirror, SwarmRenderState, StructureRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 });
  return ring;
}

function structureEntry(shipKind: string): SwarmRenderState {
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: emptyPoseRing(), ringHead: 0,
    radius: 400, kind: 2, shipKind, sleeping: true, lastUpdateTick: 0,
  };
}

function makeCtx(): SwarmSpriteCtx {
  const shipContainer = new Container();
  shipContainer.sortableChildren = true;
  return {
    shipContainer,
    sprites: new Map<string, Graphics>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art: null, handles: new Map(), sunAz: 0 },
    slewDtSec: 0.016,
    cameraScale: 0.5,
  };
}

/** Spawn a ship hull first, then structure `kind` on top of it; return the
 *  draw order (index after the z sort) of the hull and the structure. */
function drawOrder(kind: string): { hull: number; structure: number; z: number } {
  const ctx = makeCtx();
  const hull = new Container(); // a ship sprite: hull band, zIndex 0
  hull.label = 'hull';
  ctx.shipContainer.addChild(hull);
  const swarm = new Map<number, SwarmRenderState>([[7, structureEntry(kind)]]);
  const structures = new Map<number, StructureRenderState>([[7, {
    powered: true, netPower: 0, connTo: [], built: true, buildPct: 1, deconstructPct: 0,
  } as StructureRenderState]]);
  updateSwarmSprites({ swarm, structures } as unknown as RenderMirror, ctx);
  const sprite = [...ctx.sprites.values()][0]!;
  ctx.shipContainer.sortChildren();
  return {
    hull: ctx.shipContainer.getChildIndex(hull),
    structure: ctx.shipContainer.getChildIndex(sprite),
    z: sprite.zIndex,
  };
}

describe('updateSwarmSprites — a teleporter chamber draws under the ships in it', () => {
  it.each(['teleporter', 'pocket_pad'])('%s: built after a hull, still drawn below it (pad-deck band)', (kind) => {
    const o = drawOrder(kind);
    expect(o.z).toBe(RIG_UNDER_Z);
    expect(o.structure).toBeLessThan(o.hull);
  });

  it('other structures keep the hull band (add order unchanged)', () => {
    const o = drawOrder('solar');
    expect(o.z).toBe(0);
    expect(o.structure).toBeGreaterThan(o.hull);
  });
});
