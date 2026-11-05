/**
 * Machined turret firing reactions (plan T2): a bolt first seen near a gun
 * tip kicks THAT gun (recoil, flash, heat); a held beam lights its emitter;
 * low / minimal quality drop the flash and heat but keep the recoil.
 */
import { describe, it, expect } from 'vitest';
import { Container, Sprite, Texture } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';
import { shipTurrets, muzzleReach } from './art/turretLayout.js';

const frames = Array.from({ length: 16 }, () => Texture.WHITE);
const art = (): ShipArt => ({ frames, w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

function setup(): { mvm: MountVisualManager; hull: MachinedShipSprite } {
  const ready = (job: BakeJob): ArtHandle => ({
    key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null,
    fx: { tex: Texture.WHITE, frames: [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE], w: 1, h: 1 },
  });
  const service = { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService;
  const mvm = new MountVisualManager();
  mvm.setArt({ art: service, handles: new Map(), sunAz: 0, turrets: true });
  const hull = new MachinedShipSprite(art());
  mvm.ensureForShip('p1', 'gunship', hull);
  return { mvm, hull };
}

const MOUNTS = getShipKind('gunship').mounts!;
/** The gun pivots of the cluster (the cluster is the hull's last child). */
const pivots = (hull: Container): Container[] =>
  ((hull.children[hull.children.length - 1] as Container).children.filter((c) => !(c instanceof Sprite) && (c as Container).children.length > 0)) as Container[];
const frame = (mvm: MountVisualManager, t: number, q: 'high' | 'low' = 'high'): void => {
  mvm.setFrame(t * 1000, q);
  mvm.applyMountAngles('p1', MOUNTS, [0, 0]);
};

describe('MountVisualManager — firing reactions', () => {
  it('a bolt near a gun tip kicks that gun, flashes, then settles', () => {
    const { mvm, hull } = setup();
    frame(mvm, 1); // build the guns
    const [front, back] = pivots(hull);
    const t0 = shipTurrets('gunship')[0]!;
    // The first gun's tip at rotation 0: (px, py - reach) in hull space = world here.
    mvm.noteShotNear('p1', t0.px, t0.py - muzzleReach(t0));
    expect(mvm.turretShotCount()).toBe(1);
    frame(mvm, 1.02);
    const gunA = front!.children[0] as Sprite, otherA = back!.children[0] as Sprite;
    expect(gunA.y).toBeGreaterThan(0); // kicked back
    expect(otherA.y).toBe(0); // the other gun didn't move
    expect(front!.children.some((c) => c.visible && (c as Sprite).blendMode === 'add')).toBe(true); // flash / heat
    frame(mvm, 1.6);
    expect(Math.abs(gunA.y)).toBeLessThan(0.05);
  });

  it('a shot far from every tip matches nothing', () => {
    const { mvm } = setup();
    frame(mvm, 1);
    mvm.noteShotNear('p1', 5000, 5000);
    expect(mvm.turretShotCount()).toBe(0);
  });

  it('low quality keeps the recoil and drops the flash', () => {
    const { mvm, hull } = setup();
    frame(mvm, 1, 'low');
    const t0 = shipTurrets('gunship')[0]!;
    mvm.noteShotNear('p1', t0.px, t0.py - muzzleReach(t0));
    frame(mvm, 1.02, 'low');
    const front = pivots(hull)[0]!;
    expect((front.children[0] as Sprite).y).toBeGreaterThan(0);
    expect(front.children.some((c) => c.visible && (c as Sprite).blendMode === 'add')).toBe(false);
  });

  it('a held beam lights its emitter', () => {
    const ready = (job: BakeJob): ArtHandle => ({ key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null, fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
    const mvm = new MountVisualManager();
    mvm.setArt({ art: { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService, handles: new Map(), sunAz: 0, turrets: true });
    const hull = new MachinedShipSprite(art());
    mvm.ensureForShip('i1', 'interceptor', hull);
    const mounts = getShipKind('interceptor').mounts!;
    mvm.setFrame(1000, 'high'); mvm.applyMountAngles('i1', mounts, undefined);
    mvm.noteBeam('i1', 'wing-r');
    mvm.setFrame(1016, 'high'); mvm.applyMountAngles('i1', mounts, undefined);
    const [left, right] = pivots(hull);
    const lit = (p: Container): boolean => p.children.some((c) => c.visible && (c as Sprite).blendMode === 'add');
    expect(lit(right!)).toBe(true);
    expect(lit(left!)).toBe(false);
  });
});
