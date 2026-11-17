/**
 * Rock cut (salvage stream): a rock's wreck piece draws its own stretch of
 * its parent rock's surface, unmasked (`rockPieceArt.ts`: the field rock
 * shader, else the plain polygon), inside a `WreckPieceSprite` (cut-edge
 * glow, hit flash). A rock's parent kind is `WRECK_ROCK_PARENT_KIND`
 * ('asteroid'), not a ship kind, and its wire shipKind byte decodes to an
 * arbitrary ship kind: neither may reach the art service or a ship-kind lookup.
 */
import { describe, it, expect, vi } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import { updateSwarmSprites, type SwarmSpriteCtx } from './swarmSpriteUpdater.js';
import { MountVisualManager } from '../MountVisualManager.js';
import { WreckGeometryStore, rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { WreckArtState, WreckPieceSprite } from './wreckArt.js';
import type { ArtService } from '../art/ArtService.js';
import { CutFieldLayer, isFieldRockMesh } from '../field/CutFieldLayer.js';
import { RockBatchMember } from '../field/rockBatch.js';
import type { RenderMirror, SwarmRenderState, PoseRingEntry } from '../../../core/contracts/IRenderer.js';
import { POSE_RING_DEPTH } from '../../../core/contracts/IRenderer.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor } from '../../../shared-types/messages/wreckDescriptor.js';

// Any ship-kind lookup of the rock's parent kind ('asteroid', literal: vi.mock is hoisted) is the bug under test.
// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('../field/fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockBatchProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));

vi.mock('../../../shared-types/shipKinds', async (orig) => {
  const m = await orig<typeof import('../../../shared-types/shipKinds')>();
  return {
    ...m,
    getShipKind: (id: string) => {
      if (id === 'asteroid') throw new Error('getShipKind on a rock wreck');
      return m.getShipKind(id as never);
    },
  };
});

function emptyPoseRing(): PoseRingEntry[] {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) ring.push({ empty: true, x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0 } as PoseRingEntry);
  return ring;
}

/** An art service that fails the test on any use (a rock piece draws the
 *  uncut rock's surface, never ship art or a bake). */
function poisonArt(touched: string[]): ArtService {
  return new Proxy({}, {
    get(_t, p) {
      touched.push(String(p));
      throw new Error(`art service touched: ${String(p)}`);
    },
  }) as ArtService;
}

function makeCtx(art: ArtService | null): SwarmSpriteCtx {
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
    art: { art, handles: new Map(), sunAz: 0.4 },
    slewDtSec: 1 / 60,
    wrecks: new WreckGeometryStore(),
    wreckArt: new WreckArtState(null, null),
  } as SwarmSpriteCtx;
}

const DEATH_TICK = 5000;
const ROCK = { id: 'rock-17', shape: 4242, r: 60 };
function rockDesc(cutKind?: 'slice'): WreckDescriptor {
  return {
    wreckId: 9, parentKind: WRECK_ROCK_PARENT_KIND, seed: 1234, killX: 5, killY: -8,
    killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    deathTick: DEATH_TICK, rock: ROCK,
    ...(cutKind !== undefined ? { cutKind, cutAng: 0.3, cutW: 4 } : {}),
  };
}

function mirrorFor(d: WreckDescriptor, tick: number): RenderMirror {
  const geom = rebuildWreckPieces(d);
  const swarm = new Map<number, SwarmRenderState>();
  geom.forEach((g, i) => swarm.set(100 + i, {
    x: g.cx, y: g.cy, vx: 0, vy: 0, angle: 0, angvel: 0,
    prevX: g.cx, prevY: g.cy, prevAngle: 0, prevArrivalMs: 0, latestArrivalMs: 0,
    poseRing: emptyPoseRing(), ringHead: 0,
    // The wire's shipKind byte is 0 for a rock piece: it decodes as ship kind index 0.
    radius: g.radius, kind: 4, shipKind: 'fighter', componentIndex: i, wreckId: d.wreckId,
    sleeping: false, lastUpdateTick: tick,
  } as SwarmRenderState));
  return { swarm, wrecks: new Map([[d.wreckId, d]]) } as unknown as RenderMirror;
}

function pieces(ctx: SwarmSpriteCtx): WreckPieceSprite[] {
  return [...ctx.sprites.values()].filter((s): s is WreckPieceSprite => s instanceof WreckPieceSprite);
}

describe('rock wreck pieces draw the asteroid art (rock cut)', () => {
  for (const cut of [undefined, 'slice'] as const) {
    it(`builds every piece of a ${cut ?? 'natural'} rock break without ship art or a ship-kind lookup`, () => {
      const touched: string[] = [];
      const ctx = makeCtx(poisonArt(touched));
      const d = rockDesc(cut);
      const mirror = mirrorFor(d, DEATH_TICK + 1);
      expect(mirror.swarm!.size).toBeGreaterThan(1);
      expect(() => { updateSwarmSprites(mirror, ctx); updateSwarmSprites(mirror, ctx); }).not.toThrow();
      expect(touched, 'no art service use').toEqual([]);
      const ps = pieces(ctx);
      expect(ps.length).toBe(mirror.swarm!.size);
      for (const p of ps) {
        expect(p.info.profile).toBe('rock');
        expect(p.artMode()).toBe('plain'); // no ship art
        // The rock art: the piece outline in the plain rock look, no mask (a
        // stencil mask per piece breaks the batch).
        const holder = p.children[0] as Container;
        expect(holder.children.length).toBe(1);
        expect(holder.children[0]).toBeInstanceOf(Graphics);
        for (const o of [holder, ...holder.children] as Container[]) expect(o.mask ?? null).toBeNull();
      }
      // The cut edges keep the wreck glow (a slice burns the full style).
      expect(ps.some((p) => p.glowSegments() > 0)).toBe(true);
    });
  }

  it('with the field layer, every piece draws the field rock shader, built once (no bake to wait for)', () => {
    const ctx = { ...makeCtx(null), fieldRocks: new CutFieldLayer() };
    const d: WreckDescriptor = { ...rockDesc('slice'), rock: { ...ROCK, res: 'ice' } };
    const mirror = mirrorFor(d, DEATH_TICK + 1);
    updateSwarmSprites(mirror, ctx);
    updateSwarmSprites(mirror, ctx);
    const first = pieces(ctx);
    expect(first.length).toBe(mirror.swarm!.size);
    for (const p of first) {
      expect(p.rockArt!.shaded).toBe(true);
      expect(p.rockArt!.children[0]).toBeInstanceOf(RockBatchMember);
      expect(isFieldRockMesh(p.rockArt!.children[0]!)).toBe(true);
    }
    updateSwarmSprites(mirror, ctx);
    expect(pieces(ctx)).toEqual(first);
  });

  it('a rock piece whose rock cannot be resolved is not drawn (never a ship fallback)', () => {
    const ctx = makeCtx(null);
    const d = rockDesc();
    const mirror = mirrorFor(d, DEATH_TICK + 1);
    vi.spyOn(ctx.wrecks!, 'rockOf').mockReturnValue(undefined);
    expect(() => updateSwarmSprites(mirror, ctx)).not.toThrow();
    expect(pieces(ctx)).toEqual([]);
  });
});
