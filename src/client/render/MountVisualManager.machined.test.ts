/**
 * Machined turrets (new effects, plan T1): on a Machined hull each mount gets
 * a baked gun on a pivot at turretLayout's spot, lit by its own world
 * rotation; today's bar draws until the gun is baked. In the new look aim
 * guides show only for the local ship's active weapon while a hostile is in
 * range (`setLocalAim`); classic keeps them always on.
 */
import { describe, it, expect } from 'vitest';
import { Container, Texture } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import { MachinedFlatSprite } from './art/MachinedFlatSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { ShipArtCtx } from './art/shipArtSprites.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';
import { getStructureKind } from '../../shared-types/structureKinds';

const frames = Array.from({ length: 16 }, () => Texture.WHITE);
const art = (): ShipArt => ({ frames, w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

/** A fake art service: every acquire returns a pending handle we can complete. */
function fakeCtx(turrets = true): { ctx: ShipArtCtx; acquired: ArtHandle[] } {
  const acquired: ArtHandle[] = [];
  const service = {
    acquire: (job: BakeJob): ArtHandle => {
      const h: ArtHandle = { key: String(acquired.length), job, rig: undefined as never, state: 'pending', ship: null, struct: null };
      acquired.push(h);
      return h;
    },
    fx: (): ArtHandle => ({ key: 'fx', job: { type: 'fx', id: 'glow' }, rig: undefined as never, state: 'pending', ship: null, struct: null }),
  } as unknown as ArtService;
  return { ctx: { art: service, handles: new Map(), sunAz: 0, turrets }, acquired };
}
const ready = (hs: ArtHandle[]): void => { for (const h of hs) { h.state = 'ready'; h.ship = art(); } };

describe('MountVisualManager — Machined turrets', () => {
  it('keeps today\'s bar until the gun is baked, then swaps it for the gun', () => {
    const { ctx, acquired } = fakeCtx();
    const mvm = new MountVisualManager();
    mvm.setArt(ctx);
    const hull = new MachinedShipSprite(art());
    mvm.ensureForShip('p1', 'gunship', hull);
    const mounts = getShipKind('gunship').mounts!;
    expect(acquired).toHaveLength(2); // one gun per mount
    expect(acquired[0]!.job.type).toBe('turret');
    mvm.applyMountAngles('p1', mounts, [0, 0]);
    expect(mvm.machinedGunCount()).toBe(0);
    ready(acquired);
    mvm.applyMountAngles('p1', mounts, [0.3, 0]);
    expect(mvm.machinedGunCount()).toBe(2);
    mvm.removeShip('p1');
    expect(mvm.machinedGunCount()).toBe(0);
  });

  it('a classic (vector) hull never gets a gun, and with the new look off the count is -1', () => {
    const { ctx, acquired } = fakeCtx();
    const mvm = new MountVisualManager();
    mvm.setArt(ctx);
    mvm.ensureForShip('p1', 'gunship', new Container());
    expect(acquired).toHaveLength(0);
    const off = new MountVisualManager();
    off.setArt(fakeCtx(false).ctx);
    off.ensureForShip('p2', 'gunship', new MachinedShipSprite(art()));
    expect(off.machinedGunCount()).toBe(-1);
  });

  it('structure turrets get a gun; miner drills keep their drill line', () => {
    const { ctx, acquired } = fakeCtx();
    const mvm = new MountVisualManager();
    mvm.setArt(ctx);
    const flat = (): MachinedFlatSprite => new MachinedFlatSprite({ tex: Texture.WHITE, albedo: Texture.WHITE, w: 32, h: 32, density: 2, navLights: [] });
    mvm.ensureForMounts('s1', 'turret', getStructureKind('turret').mounts!, 0xffffff, flat());
    mvm.ensureForMounts('s2', 'miner', getStructureKind('miner').mounts!, 0xffffff, flat());
    expect(acquired).toHaveLength(1);
  });

  it('aim guides show only for the local ship\'s active mounts while in range', () => {
    const { ctx } = fakeCtx();
    const mvm = new MountVisualManager();
    mvm.setArt(ctx);
    const local = new MachinedShipSprite(art()), remote = new MachinedShipSprite(art());
    mvm.ensureForShip('me', 'interceptor', local);
    mvm.ensureForShip('them', 'interceptor', remote);
    const mounts = getShipKind('interceptor').mounts!;
    const guides = (c: Container): boolean[] => (c.children[c.children.length - 1] as Container).children.filter((_, i) => i % 3 === 0).map((g) => g.visible);
    mvm.setLocalAim('me', []);
    mvm.applyMountAngles('me', mounts, undefined);
    expect(guides(local)).toEqual([false, false]);
    const ids = ['wing-l', 'wing-r'];
    mvm.setLocalAim('me', ids);
    mvm.applyMountAngles('me', mounts, undefined);
    mvm.applyMountAngles('them', mounts, undefined);
    expect(guides(local)).toEqual([true, true]);
    expect(guides(remote)).toEqual([false, false]);
  });
});
