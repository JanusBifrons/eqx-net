/**
 * Capital fixes S14 (owner: "most lasers tunnel very badly"). The server hits
 * thin hulls (`ProjectilePipeline.noTunnel.test.ts`); the client drew every
 * bolt flying on THROUGH the hull until a later snapshot dropped it. Each
 * frame a bolt now ends at the first drawn hull its step crosses, for every
 * bolt weapon in the catalogue and every ship kind, ghosts included, and a
 * later snapshot that still lists it never draws it again.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld } from '../../core/physics/World.js';
import type { ProjectileRenderState, RenderMirror, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { WEAPON_IDS, getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { NAVAL_SHELL_WEAPON_IDS } from '../../core/combat/shellFlight.js';
import { shipHitBound } from '../../core/combat/shipHitShape.js';
import { shipCollisionParts } from '../../core/geometry/shipHullDecomp.js';
import { SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { DisplayPoseHitscan } from './displayPoseHitscan.js';
import { GhostManager } from './GhostProjectile.js';
import { updateProjectilesMirror } from '../net/mirror/worldPasses.js';
import { syncProjectiles } from '../net/SnapshotSyncHelpers.js';
import type { MirrorPassCtx } from '../net/mirror/mirrorPassCtx.js';

/** Bolts drawn from snapshots and ghosts: projectile weapons that are not event shells. */
const BOLT_WEAPONS = WEAPON_IDS.filter((id) => getWeapon(id).mode === 'projectile' && !NAVAL_SHELL_WEAPON_IDS.has(id));
const FRAME_MS = 1000 / 90; // a phone's frame

let world: PhysicsWorld;
beforeAll(async () => {
  await RAPIER.init();
  world = await PhysicsWorld.create();
  world.spawnShip('me', -5000, -5000);
  world.tick(1 / 60);
});

function drone(kindId: string, x: number, y: number, angle: number): SwarmRenderState {
  return {
    x, y, vx: 0, vy: 0, angle, angvel: 0, radius: 12, kind: 1, shipKind: kindId, shieldDown: true,
    sleeping: false, lastUpdateTick: 0, prevX: x, prevY: y, prevAngle: angle, prevArrivalMs: 0,
    latestArrivalMs: 0, poseRing: [], ringHead: 0,
  } as unknown as SwarmRenderState;
}

function scene(swarm: Map<number, SwarmRenderState>) {
  const moving = new Set<string>();
  const keys = new Map<number, string>();
  for (const id of swarm.keys()) { moving.add(`swarm-${id}`); keys.set(id, `swarm-${id}`); }
  const h = new DisplayPoseHitscan(moving, keys);
  h.world = world;
  h.swarm = swarm;
  const ghosts = new GhostManager();
  const mirror = { projectiles: new Map<string, ProjectileRenderState>(), swarm, ships: new Map() } as unknown as RenderMirror;
  const ctx = {
    mirror, clock: { now: () => 0 }, shellEvents: false, ghostManager: ghosts,
    placeShells: () => {}, gameFrameMs: () => FRAME_MS, predWorld: world, displayHitscan: () => h,
  } as unknown as MirrorPassCtx;
  return { mirror, ctx, ghosts };
}

/** Run frames; return the farthest +x the bolt was drawn at (or -Infinity) and whether it is gone. */
function fly(ctx: MirrorPassCtx, mirror: RenderMirror, id: string, frames: number): { maxX: number; gone: boolean } {
  let maxX = -Infinity;
  for (let f = 0; f < frames; f++) {
    updateProjectilesMirror(ctx, 0);
    const p = mirror.projectiles!.get(id);
    if (p === undefined) return { maxX, gone: true };
    if (p.x > maxX) maxX = p.x;
  }
  return { maxX, gone: false };
}

describe('bolts end at the first drawn hull (no visual tunnelling)', () => {
  it('covers every bolt weapon', () => {
    expect(BOLT_WEAPONS).toEqual(expect.arrayContaining(['laser', 'autocannon']));
  });

  for (const weaponId of BOLT_WEAPONS) {
    it(`${weaponId}: never drawn past any ship kind's hull, side-on, and a later snapshot keeps it gone`, () => {
      const def = getWeapon(weaponId);
      if (def.mode !== 'projectile') throw new Error('not a projectile');
      const through: string[] = [];
      for (const kind of SHIP_KINDS_LIST) {
        if (shipCollisionParts(kind.id).length === 0) continue;
        const bound = shipHitBound(kind.id);
        // Drawn at the origin, side-on to the bolt (nose along ±y).
        const { mirror, ctx, ghosts } = scene(new Map([[7, drone(kind.id, 0, 0, Math.PI / 2)]]));
        const startX = -bound - 40;
        mirror.projectiles!.set('proj-1', { x: startX, y: 0, vx: def.speed, vy: 0, ownerId: 'enemy', isGhost: false, weaponId });
        const frames = Math.ceil(((2 * bound + 80) / def.speed) * 90) + 5;
        const { maxX, gone } = fly(ctx, mirror, 'proj-1', frames);
        // Never drawn beyond the hull's near half (its far side is ≤ +bound).
        if (!gone || maxX > 0) through.push(`${kind.id}: gone=${gone} maxX=${maxX.toFixed(1)}`);
        // The next snapshot still lists it (the server's hit is on its way):
        // not drawn again; once the server drops it, it is forgotten.
        syncProjectiles(mirror, [{ id: 'proj-1', x: 0, y: 0, vx: def.speed, vy: 0, ownerId: 'enemy', weaponId }], new Set(), ghosts.stoppedBolts);
        expect(mirror.projectiles!.has('proj-1'), kind.id).toBe(false);
        syncProjectiles(mirror, [], new Set(), ghosts.stoppedBolts);
        expect(ghosts.stoppedBolts.size).toBe(0);
      }
      expect(through).toEqual([]);
    });

    it(`${weaponId}: a ghost bolt stops on the drawn hull too`, () => {
      const { mirror, ctx } = scene(new Map([[7, drone('fighter', 300, 0, Math.PI / 2)]]));
      const ghosts = ctx.ghostManager;
      ghosts.spawn('shot-1', 'me', 0, 0, 1, 0, weaponId);
      const { maxX, gone } = fly(ctx, mirror, 'shot-1', 60);
      expect(gone).toBe(true);
      expect(maxX).toBeLessThan(300);
      // The GhostManager forgot it: the next frame does not redraw it.
      updateProjectilesMirror(ctx, 0);
      expect(mirror.projectiles!.has('shot-1')).toBe(false);
    });
  }

  it('a bolt that misses keeps flying, and never stops on its own shooter', () => {
    const { mirror, ctx } = scene(new Map([[7, drone('fighter', 0, 0, 0)], [8, drone('fighter', 300, 200, 0)]]));
    // Fired by drone 7 from inside its own hull, along a line clear of drone 8.
    mirror.projectiles!.set('proj-2', { x: 0, y: 0, vx: 1600, vy: 0, ownerId: 'swarm-7', isGhost: false, weaponId: 'laser' });
    const { maxX, gone } = fly(ctx, mirror, 'proj-2', 30);
    expect(gone).toBe(false);
    expect(maxX).toBeGreaterThan(500);
  });

  it('a remote ship (predWorld body) stops the bolt', async () => {
    const w = await PhysicsWorld.create();
    w.spawnShip('enemy', 300, 0, 'fighter');
    w.tick(1 / 60);
    const { mirror, ctx } = scene(new Map());
    (ctx as unknown as { displayHitscan: () => DisplayPoseHitscan }).displayHitscan().world = w;
    mirror.projectiles!.set('proj-3', { x: 0, y: 0, vx: 1600, vy: 0, ownerId: 'someone', isGhost: false, weaponId: 'laser' });
    const { maxX, gone } = fly(ctx, mirror, 'proj-3', 60);
    expect(gone).toBe(true);
    expect(maxX).toBeLessThan(300);
    w.dispose();
  });
});
