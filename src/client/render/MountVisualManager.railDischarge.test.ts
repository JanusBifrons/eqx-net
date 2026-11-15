/**
 * Hostile review (2026-11-15, rail fire tile 4.10-4.22 s): the railgun's slot
 * charge went out ~6 frames before its muzzle flash. The charge mask clears on
 * the newest snapshot (the fire tick) but the flash shows when the display
 * clock reaches the slug, DISPLAY_DELAY_MS later. Through the real
 * MountVisualManager: the slot stays lit until noteShotNear kicks that gun,
 * then goes out (the telegraph reads lastShotsMs).
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';
import { getWeapon } from '../../core/combat/WeaponCatalogue';
import { shipTurrets, muzzleReach } from './art/turretLayout.js';
import { buildChargeTelegraph, updateChargeTelegraph } from './pixi/chargeTelegraph.js';
import { DISPLAY_DELAY_MS } from '../net/swarmInterpolation.js';

const TICK_MS = 1000 / 60;
const frames = Array.from({ length: 16 }, () => Texture.WHITE);
const art = (): ShipArt => ({ frames, w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

describe('railgun: the slot charge discharges into the shot', () => {
  it('stays lit from the mask clear until that gun is kicked, then goes out', () => {
    const ready = (job: BakeJob): ArtHandle => ({
      key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null,
      fx: { tex: Texture.WHITE, frames: [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE], w: 1, h: 1 },
    });
    const mvm = new MountVisualManager();
    mvm.setArt({ art: { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService, handles: new Map(), sunAz: 0, turrets: true });
    const hull = new MachinedShipSprite(art());
    mvm.ensureForShip('bs', 'battleship-rail', hull);
    const mounts = getShipKind('battleship-rail').mounts!;
    const i = mounts.findIndex((m) => m.weaponId === 'railgun');
    const tele = buildChargeTelegraph('battleship-rail', 200)!;
    const chargeTicks = getWeapon('railgun').chargeTicks!;
    let fx = 60_000;
    const frame = (mask: number, nowTick: number): void => {
      mvm.setFrame(fx, 'high');
      mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
      mvm.lastShotsMs('bs', tele.mountIds, tele.shotMs);
      updateChargeTelegraph(tele, mask, 1000, nowTick, fx, undefined, undefined, tele.shotMs);
    };
    frame(1 << i, 1000 + chargeTicks); // full
    expect(tele.rails[i]!.fill.scale.y).toBeCloseTo(1, 5);
    // The server fires: the mask clears now; the flash is DISPLAY_DELAY_MS off.
    let dark = 0;
    for (let ms = 0; ms < DISPLAY_DELAY_MS; ms += TICK_MS) {
      fx += TICK_MS;
      frame(0, 1000 + chargeTicks + 3);
      if (!tele.root.visible || !tele.glows[i]!.visible) dark++;
    }
    expect(dark, 'frames the slot was dark before the flash').toBe(0);
    // The slug is first drawn at the muzzle: noteShotNear kicks the railgun.
    const t = shipTurrets('battleship-rail')[i]!;
    const r = -t.mount.baseAngle;
    const d = muzzleReach(t);
    mvm.noteShotNear('bs', t.px + Math.sin(r) * d, t.py - Math.cos(r) * d, 'railgun');
    expect(mvm.lastShotMountId()).toBe(mounts[i]!.id);
    fx += TICK_MS;
    frame(0, 1000 + chargeTicks + 6);
    expect(tele.root.visible, 'out once the shot shows').toBe(false);
  });
});
