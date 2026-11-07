/**
 * Smoke report (2026-11-07, capital-guns-fighter clip): "Why are the main
 * cannons firing like a gattling cannon?!" The server fires a 16" turret once
 * per 30 s (tests/unit/capitalFireCadence.test.ts), but the client matched
 * every new shot to the NEAREST gun tip within that gun's reach — and a 16"
 * gun's reach is hundreds of units, so the quick AA / 5" shots appearing near
 * it kicked the main guns at AA cadence. A shot must only kick a gun that
 * fires its weapon.
 */
import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import { MountVisualManager } from './MountVisualManager.js';
import { MachinedShipSprite } from './art/MachinedShipSprite.js';
import type { ArtHandle, ArtService, ShipArt } from './art/ArtService.js';
import type { BakeJob } from './art/bake.js';
import { getShipKind } from '../../shared-types/shipKinds';
import { NAVAL_BARREL_SPAN } from '../../core/combat/muzzle';
import { Container, Sprite } from 'pixi.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue';
import { shipTurrets, muzzleReach } from './art/turretLayout.js';

const frames = Array.from({ length: 16 }, () => Texture.WHITE);
const art = (): ShipArt => ({ frames, w: 32, h: 32, density: 4, nozzles: [], navLights: [] });

describe('capital shots kick only their own gun', () => {
  it('a 5" or AA shot first seen a snapshot out never kicks a main turret', () => {
    const ready = (job: BakeJob): ArtHandle => ({
      key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null,
      fx: { tex: Texture.WHITE, frames: [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE], w: 1, h: 1 },
    });
    const mvm = new MountVisualManager();
    mvm.setArt({ art: { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService, handles: new Map(), sunAz: 0, turrets: true });
    const hull = new MachinedShipSprite(art());
    mvm.ensureForShip('bs', 'battleship', hull);
    const mounts = getShipKind('battleship').mounts!;
    mvm.setFrame(1000, 'high');
    mvm.applyMountAngles('bs', mounts, mounts.map(() => 0));
    const wrong: string[] = [];
    for (const t of shipTurrets('battleship')) {
      if (t.mount.size === 'L' || t.mount.size === 'XL') continue;
      const w = getWeapon(t.mount.weaponId);
      const out = w.mode === 'hitscan' ? 0 : w.speed / 20; // first seen up to one 20 Hz snapshot later
      // Barrel at rest points along the mount's base angle (Pixi y-down: -baseAngle).
      const r = -t.mount.baseAngle;
      const d = muzzleReach(t) + out;
      const x = t.px + Math.sin(r) * d, y = t.py - Math.cos(r) * d;
      mvm.noteShotNear('bs', x, y, t.mount.weaponId);
      const hit = mvm.lastShotMountId();
      const hitMount = mounts.find((m) => m.id === hit);
      if (!hitMount || hitMount.weaponId !== t.mount.weaponId) wrong.push(`${t.mount.id} -> ${hit}`);
    }
    expect(wrong).toEqual([]);
  });

  it('quad AA: each shot recoils and flashes only the barrel it left', () => {
    const ready = (job: BakeJob): ArtHandle => ({
      key: 'k', job, rig: undefined as never, state: 'ready', ship: art(), struct: null,
      fx: { tex: Texture.WHITE, frames: [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE], w: 1, h: 1 },
    });
    const mvm = new MountVisualManager();
    mvm.setArt({ art: { acquire: ready, fx: (id: string) => ready({ type: 'fx', id }) } as unknown as ArtService, handles: new Map(), sunAz: 0, turrets: true });
    const hull = new MachinedShipSprite(art());
    mvm.ensureForShip('bs', 'battleship', hull);
    const mounts = getShipKind('battleship').mounts!;
    const angles = mounts.map(() => 0);
    mvm.setFrame(1000, 'high');
    mvm.applyMountAngles('bs', mounts, angles); // bakes ready: builds house + barrels
    mvm.applyMountAngles('bs', mounts, angles);
    const t = shipTurrets('battleship').find((x) => x.mount.size === 'AA')!;
    const n = t.naval!.barrels;
    const pitch = (t.naval!.houseW * NAVAL_BARREL_SPAN) / (n - 1);
    const r = -t.mount.baseAngle; // barrel at rest (Pixi y-down)
    // The AA pivot's barrel sprites: children at the barrel x positions.
    const cluster = hull.children[hull.children.length - 1] as Container;
    const pivot = cluster.children.find((c) => Math.abs(c.x - t.px) < 1e-6 && Math.abs(c.y - t.py) < 1e-6 && (c as Container).children.length > 4) as Container;
    expect(pivot, 'AA pivot').toBeTruthy();
    const barrelY = (k: number): number => {
      const x = (k - (n - 1) / 2) * pitch;
      const sp = pivot.children.filter((c) => c instanceof Sprite && Math.abs(c.x - x) < 1e-4 && c.blendMode !== 'add');
      return (sp[0] as Sprite).y;
    };
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * pitch;
      const d = muzzleReach(t) + 40;
      // tip of barrel k, 40 u out: forward (sin r, -cos r), right (cos r, sin r)
      const x = t.px + Math.sin(r) * d + Math.cos(r) * off, y = t.py - Math.cos(r) * d + Math.sin(r) * off;
      mvm.setFrame(2000 + k * 1000, 'high');
      mvm.noteShotNear('bs', x, y, t.mount.weaponId);
      expect(mvm.lastShotBarrel()).toBe(k);
      mvm.setFrame(2000 + k * 1000 + 20, 'high');
      mvm.applyMountAngles('bs', mounts, angles);
      for (let b = 0; b < n; b++) {
        if (b === k) expect(barrelY(b), `barrel ${b} kicks`).toBeGreaterThan(0);
        else expect(barrelY(b), `barrel ${b} stays`).toBe(0);
      }
    }
  });
});
