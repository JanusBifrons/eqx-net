/**
 * Capital destruction S2b — wreck pieces are drawn plainly: each piece a
 * filled polygon in the parent hull's base colour, darkened, with a thin dark
 * outline, built ONCE from the geometry the renderer rebuilds off
 * `mirror.wrecks` (the same `wreckPieceGeometry` the server's bodies use).
 *
 * Count budget: ONE display object per piece (a plain Graphics: no children,
 * no texture, no filter), so the batcher draws a whole wreck in one call and
 * a 768-piece cap adds at most 768 objects to CLIENT_COUNT_BUDGETS'
 * thousands.
 */
import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { WRECK_DISPLAY_OBJECTS_PER_PIECE, wreckPieceColors } from './spriteBuilders.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { shipPrimaryColor } from '../../../core/geometry/shipHullOutline.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

function makeCtx(): SwarmSpriteCtx {
  return {
    shipContainer: new Container(),
    sprites: new Map<string, Container>(),
    mountVisuals: new MountVisualManager(),
    swarmPoseScratch: { x: 0, y: 0, angle: 0 },
    remoteHitTargets: new Set<string>(),
    localHitTargets: new Set<string>(),
    seenScratch: new Set<string>(),
    structureMountAngles: new Map<string, number[]>(),
    spriteKinds: new Map<string, number>(),
    spriteBuildSigs: new Map(),
    art: { art: null, handles: new Map(), sunAz: 0 },
    slewDtSec: 1 / 60,
    wrecks: new WreckGeometryStore(),
  } as SwarmSpriteCtx;
}

const DESC: WreckDescriptor = {
  wreckId: 3, parentKind: 'battleship', seed: 11, killX: 0, killY: -400,
  killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
};

function piece(index: number, x: number, y: number, radius: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle: 0.3, angvel: 0,
    prevX: x, prevY: y, prevAngle: 0.3, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    radius, kind: 4, shipKind: 'battleship', componentIndex: index, wreckId: DESC.wreckId,
    sleeping: false, lastUpdateTick: 0,
  } as SwarmRenderState;
}

describe('updateSwarmSprites — capital wreck pieces (S2b)', () => {
  it('draws every piece once, as one plain Graphics each, within the count budget', () => {
    const geom = rebuildWreckPieces(DESC);
    expect(geom.length).toBeGreaterThanOrEqual(3);
    const swarm = new Map<number, SwarmRenderState>();
    geom.forEach((g, i) => swarm.set(100 + i, piece(i, g.cx, g.cy, g.radius)));
    const mirror = { swarm, wrecks: new Map([[DESC.wreckId, DESC]]) } as unknown as RenderMirror;
    const ctx = makeCtx();
    updateSwarmSprites(mirror, ctx);

    expect(ctx.shipContainer.children.length).toBe(geom.length * WRECK_DISPLAY_OBJECTS_PER_PIECE);
    for (let i = 0; i < geom.length; i++) {
      const s = ctx.sprites.get(`swarm-${100 + i}`)!;
      expect(s, `piece ${i} drawn`).toBeInstanceOf(Graphics);
      expect(s.children.length, 'no child objects per piece').toBe(0);
      expect(s.filters ?? null).toBeNull();
      // Its drawn extent is the piece's own (body-local, Y flipped).
      const b = (s as Graphics).getLocalBounds();
      const r = geom[i]!.radius;
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeLessThanOrEqual(r + 10); // + the outline's miter
      expect(Math.max(-b.minX, b.maxX, -b.minY, b.maxY)).toBeGreaterThan(r * 0.5);
      // Pose: the swarm pose, Pixi-up.
      expect(s.x).toBeCloseTo(geom[i]!.cx, 5);
      expect(s.y).toBeCloseTo(-geom[i]!.cy, 5);
    }

    // A second frame builds nothing new (built once, never per frame).
    const before = ctx.shipContainer.children.slice();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.shipContainer.children).toEqual(before);
  });

  it('a piece whose wreck descriptor has not arrived yet is not drawn (no placeholder)', () => {
    const mirror = { swarm: new Map([[7, piece(0, 0, 0, 100)]]) } as unknown as RenderMirror;
    const ctx = makeCtx();
    updateSwarmSprites(mirror, ctx);
    expect(ctx.sprites.has('swarm-7')).toBe(false);
    expect(ctx.shipContainer.children.length).toBe(0);
  });

  it('colours: the parent hull base colour, darkened, with a darker outline', () => {
    const base = shipPrimaryColor(getShipKind('battleship'));
    const { fill, stroke } = wreckPieceColors('battleship');
    const lum = (c: number): number => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    expect(lum(fill)).toBeLessThan(lum(base));
    expect(lum(fill)).toBeGreaterThan(0);
    expect(lum(stroke)).toBeLessThan(lum(fill));
  });
});
