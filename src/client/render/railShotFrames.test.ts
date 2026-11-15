/**
 * The railgun shot, frame by frame, through the real MountVisualManager (the
 * muzzle flash) and the real FxProjectiles (the slug and its tail): what a
 * viewer sees between the muzzle and the slug (hostile review of rail take 7,
 * 2026-11-15, f254-f264): "the slug's tail is still tied to the muzzle for
 * ~0.17 s before separating; it must never draw from the muzzle".
 *
 * Why it survived the FxWeapons tail test (#13, a level up): that test drew
 * the slug alone, and its tail's back end did leave the muzzle, at HALF the
 * slug's speed (`SLUG_WAKE_GROW` 0.5). In the game the railgun's flash is
 * the naval flash at 1.8× heft, 22 gun widths long: a ~1.4 km jet down the
 * line of fire for its ~0.4 s life. The slow tail's back end stayed inside
 * that jet, so muzzle → jet → tail → slug read as one line for ~10 frames.
 *
 * Contract: the rail flash is a BURST at the muzzle (it reaches forward no
 * further than it is wide), and the tail exists only behind the head: from
 * zero length at the muzzle, its back end flies off at most a fifth slower
 * than the slug, so once the slug is clear of the flash there is dark space
 * between the flash and the tail on every frame.
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
import { flashFrameAt, muzzleHeft, NAVAL_FLASH_LIFE_S } from './art/fx/turretFx.js';

const FRAME_MS = 1000 / 60;
/** The muzzle-flash flipbook (`muzzleFlashFlipbook`): its cell (px; the
 *  sprite scale is per cell), frame count, and how far its forward cone
 *  reaches up the cell at frame `fr` (`py < 0.9 k`, k = 1 − fr / frames). */
const FLASH_CELL = 64;
const FLASH_FRAMES = 4;
const coneReach = (fr: number): number => 0.9 * (1 - fr / FLASH_FRAMES);
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

describe('railgun shot frames: nothing links the muzzle to the slug', () => {
  it('the rail flash is a burst at the muzzle, not a jet down the line of fire', () => {
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
    // Forward (along the barrel) vs across, in flipbook cells.
    expect(f.scale.y, 'reaches forward no further than it is wide').toBeLessThanOrEqual(f.scale.x * 1.0001);
  });

  it('frame by frame: the tail grows from the muzzle behind the head, and once the slug clears the flash dark space separates them', () => {
    const { mvm, flash, shoot } = railFlash();
    const mounts = getShipKind('battleship-rail').mounts!;
    const SP = RAILGUN_BALLISTICS.speed;
    const size = 5; // a capital-zoom size floor, as on film
    let fx = 50_000;
    const p = new FxProjectiles((() => {
      const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
        fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
      return { fx: () => h() } as unknown as ArtService;
    })(), () => 'high', () => fx);
    mvm.setFrame(fx, 'high');
    mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
    shoot();
    let separated = 0;
    for (let f = 1; f <= 30; f++) {
      fx += FRAME_MS;
      mvm.setFrame(fx, 'high');
      mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
      const fl = flash();
      const fr = flashFrameAt(f / 60, FLASH_FRAMES, NAVAL_FLASH_LIFE_S * muzzleHeft('railgun'));
      const flashReach = fl.visible && fr >= 0 ? fl.scale.y * FLASH_CELL * coneReach(fr) : 0;
      // The slug, `flown` from the muzzle (x = 0) along +x.
      const flown = (SP * f) / 60;
      p.beginFrame(); p.draw('slug', 'slug', flown, 0, SP, 0, 1, size, flown); p.endFrame();
      const [headBack] = span(p.container.children[0] as unknown as S);
      let tailBack = Infinity;
      for (const s of p.wakeLayer.children as unknown as S[]) {
        if (!s.visible || s.alpha <= 0.01) continue;
        tailBack = Math.min(tailBack, span(s)[0]);
      }
      if (tailBack === Infinity) continue;
      expect(tailBack, `frame ${f}: the tail's back end flies off with the slug`).toBeGreaterThanOrEqual(0.75 * headBack - 1e-6);
      if (headBack > flashReach) {
        expect(tailBack, `frame ${f}: the tail bridges the slug to the flash (${flashReach.toFixed(0)} u)`).toBeGreaterThan(flashReach);
        separated++;
      }
    }
    expect(separated, 'the slug clears the flash within the trace').toBeGreaterThan(20);
  });
});
