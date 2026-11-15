/**
 * The railgun shot, frame by frame, through the real MountVisualManager (the
 * muzzle flash) and the real FxProjectiles (the slug and its ion trail).
 *
 * The look is the owner's pick from five filmed versions (2026-11-15): "V6 I
 * think is the best, except it should have a longer tail like v4". So the
 * flash is v6's long white-blue JET down the line of fire (the naval flash at
 * the railgun heft, 22 gun widths long), the slug is v6's long white streak,
 * and the violet ion trail is v4's: drawn from the muzzle to the slug and
 * lingering ~1.6 s where the slug passed, fading and spreading as it goes.
 * (Rail takes 6-7 had tried a burst flash and a short tail flying off with a
 * compact head; the owner preferred the long look.)
 *
 * The timing fix stays: the flash shows in the frame the slug is first drawn.
 */
import { describe, expect, it } from 'vitest';
import { Texture, type Sprite } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';
import { shipTurrets, muzzleReach } from './art/turretLayout.js';
import { FxProjectiles } from './art/fx/FxWeapons.js';
import { RAILGUN_BALLISTICS } from '../../shared-types/combat/navalGuns.js';

const FRAME_MS = 1000 / 60;
/** The muzzle-flash flipbook (`muzzleFlashFlipbook`): four frames. */
const flashFrames = [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE];
const shipArt = (): ShipArt => ({ frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

type S = { visible: boolean; x: number; scale: { x: number; y: number }; anchor: { x: number }; alpha: number };
/** A wake / head sprite's [back, front] along +x (Texture.WHITE: scale = length). */
const span = (s: S): [number, number] => [s.x - s.anchor.x * s.scale.x, s.x + (1 - s.anchor.x) * s.scale.x];

function railFlash(): { mvm: MountVisualManager; flash: () => Sprite; shoot: () => void } {
  const ready = (job: BakeJob): ArtHandle => ({
    key: 'k', job, rig: undefined as never, state: 'ready', ship: shipArt(), struct: null,
    fx: { tex: Texture.WHITE, frames: flashFrames, w: 1, h: 1 },
  });
  const mvm = new MountVisualManager();
  mvm.setArt({ art: { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService, handles: new Map(), sunAz: 0, turrets: true });
  mvm.ensureForShip('bs', 'battleship-rail', new MachinedShipSprite(shipArt()));
  const mounts = getShipKind('battleship-rail').mounts!;
  const i = mounts.findIndex((m) => m.weaponId === 'railgun');
  const t = shipTurrets('battleship-rail')[i]!;
  const internals = mvm as unknown as { clusters: Map<string, { perMount: Map<string, { gun: { barrelFlashes: Sprite[] | null } | null }> }> };
  return {
    mvm,
    flash: () => internals.clusters.get('bs')!.perMount.get(mounts[i]!.id)!.gun!.barrelFlashes![0]!,
    shoot: () => {
      const r = -t.mount.baseAngle;
      const d = muzzleReach(t);
      mvm.noteShotNear('bs', t.px + Math.sin(r) * d, t.py - Math.cos(r) * d, 'railgun');
    },
  };
}

/**
 * Hostile review of rail take 7 (f253): one frame BEFORE the muzzle flash a
 * dim pellet showed just past the muzzle while the barrel still showed its
 * charge. It was the slug's first drawn frame: `PixiRenderer.update` turns
 * and animates the guns (`updateSwarmSprites` → `applyMountAngles` →
 * `animateGun`: flash, recoil) BEFORE it notes the frame's new shots
 * (`noteTurretShots` → `noteShotNear`) and draws them
 * (`updateProjectileSprites`), so a gun's flash came a frame after its
 * slug. In that order (the renderer's), the gun matched to a new shot shows
 * its flash in the same frame.
 */
describe('railgun shot frames: the slug never shows before its flash', () => {
  it('the gun noted for a shot after the frame animated its guns flashes in that same frame', () => {
    const { mvm, flash, shoot } = railFlash();
    const mounts = getShipKind('battleship-rail').mounts!;
    mvm.setFrame(50_000, 'high');
    mvm.applyMountAngles('bs', mounts, mounts.map(() => 0)); // the swarm sprites
    expect(flash().visible, 'no flash before the shot').toBe(false);
    shoot(); // noteTurretShots: the slug is first in the mirror this frame
    expect(flash().visible, 'the flash shows with the slug, not a frame later').toBe(true);
  });
});


describe("railgun shot frames: the owner's look (v6 with v4's trail)", () => {
  it('the rail flash is the long jet down the line of fire, at the railgun heft', () => {
    const { mvm, flash, shoot } = railFlash();
    const mounts = getShipKind('battleship-rail').mounts!;
    let fx = 50_000;
    mvm.setFrame(fx, 'high');
    mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
    shoot();
    fx += FRAME_MS;
    mvm.setFrame(fx, 'high');
    mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
    const f = flash();
    expect(f.visible).toBe(true);
    // Forward (along the barrel) vs across, in flipbook cells: 22 to 7.
    expect(f.scale.y, 'reaches forward three times as far as it is wide').toBeGreaterThanOrEqual(f.scale.x * 3);
  });

  it('frame by frame: the trail runs from the muzzle to the slug and lingers there', () => {
    const SP = RAILGUN_BALLISTICS.speed;
    const size = 5; // a capital-zoom size floor, as on film
    let fx = 50_000;
    const p = new FxProjectiles((() => {
      const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
        fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
      return { fx: () => h() } as unknown as ArtService;
    })(), () => 'high', () => fx);
    const trailSpan = (): [number, number] => {
      let back = Infinity, front = -Infinity;
      for (const s of p.wakeLayer.children as unknown as S[]) {
        if (!s.visible || s.alpha <= 0.01) continue;
        const [b, f] = span(s);
        back = Math.min(back, b); front = Math.max(front, f);
      }
      return [back, front];
    };
    let flown = 0;
    for (let f = 1; f <= 60; f++) {
      fx += FRAME_MS;
      flown = (SP * f) / 60;
      p.beginFrame(); p.draw('slug', 'slug', flown, 0, SP, 0, 1, size, flown); p.endFrame();
      const [back, front] = trailSpan();
      if (back === Infinity) continue;
      // Within its life the trail still reaches back to the muzzle (one
      // wake piece of slack), and never runs ahead of the slug.
      expect(back, `frame ${f}: the trail reaches back toward the muzzle`).toBeLessThanOrEqual(flown / 10 + 1e-6);
      expect(front, `frame ${f}: nothing ahead of the slug`).toBeLessThanOrEqual(flown * 1.05 + 1e-6);
    }
    // The slug hits: its trail lingers a second, then is gone by ~1.6 s.
    fx += 1_000;
    p.beginFrame(); p.endFrame();
    expect(trailSpan()[0], 'still showing 1 s after the hit').toBeLessThan(Infinity);
    fx += 700;
    p.beginFrame(); p.endFrame();
    expect(trailSpan()[0], 'gone ~1.6 s after the slug passed').toBe(Infinity);
  });
});
