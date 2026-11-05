/**
 * Turrets T3 — a shot leaves the barrel tip, one contract on both sides of the
 * wire (invariant #15). The shared `core/combat/muzzle.ts` gives the muzzle
 * distance; the drawn barrel (client `turretLayout`) ends there, the server
 * fires from there (`PlayerFireResolver`, `AiFireResolver`,
 * `StructureGridSubsystem`) and the client predicts from there
 * (`ColyseusClient` ghosts + live beam, `PixiRenderer` remote beams). Fails if
 * the drawn tip and the fire point disagree for any turret, or if any of those
 * sites stops calling the shared function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SHIP_KINDS_LIST } from '../../src/shared-types/shipKinds.js';
import { STRUCTURE_KINDS_LIST } from '../../src/shared-types/structureKinds.js';
import { MUZZLE_CLEARANCE } from '../../src/core/combat/Weapons.js';
import { isChinMount, shipMountMuzzle, structureTurretMuzzle } from '../../src/core/combat/muzzle.js';
import { muzzleReach, shipTurrets, structureTurrets } from '../../src/client/render/art/turretLayout.js';

describe('muzzle parity (turrets T3, #15)', () => {
  it('every ship turret\'s drawn tip is its fire point (chin guns keep the 20 u clearance)', () => {
    for (const kind of SHIP_KINDS_LIST) {
      const places = shipTurrets(kind.id);
      (kind.mounts ?? []).forEach((m, i) => {
        const t = places[i]!;
        if (isChinMount(m)) {
          expect(shipMountMuzzle(kind, m), `${kind.id}/${m.id}`).toBeNull();
          // The chin gun's tip, measured from the mount, is today's clearance.
          expect(-t.py + muzzleReach(t), `${kind.id}/${m.id}`).toBeCloseTo(MUZZLE_CLEARANCE, 6);
        } else {
          expect(muzzleReach(t), `${kind.id}/${m.id}`).toBeCloseTo(shipMountMuzzle(kind, m)!, 6);
          // Capital hulls get turrets, not giant cannons.
          expect(muzzleReach(t), `${kind.id}/${m.id}`).toBeLessThanOrEqual(40);
        }
      });
    }
  });

  it('every structure turret\'s drawn tip is its fire point', () => {
    for (const sk of STRUCTURE_KINDS_LIST) {
      for (const t of structureTurrets(sk.id)) {
        expect(muzzleReach(t), `${sk.id}/${t.mount.id}`).toBeCloseTo(structureTurretMuzzle(sk.id, t.mount.weaponId), 6);
      }
    }
  });

  it('every fire site, server and client, calls the shared muzzle', () => {
    const src = (p: string): string => readFileSync(p, 'utf8');
    expect(src('src/server/rooms/PlayerFireResolver.ts')).toMatch(/shipMountMuzzle\(shipKind, mount\)/);
    expect(src('src/server/rooms/AiFireResolver.ts')).toMatch(/shipMountMuzzle\(droneKind, mount\)/);
    const grid = src('src/server/structures/StructureGridSubsystem.ts');
    expect(grid.match(/structureTurretMuzzle\(rec\.kind, def\.id\)/g)?.length).toBe(3); // beam, bolt, missile
    expect(grid).not.toMatch(/radius \+ 8/);
    const client = src('src/client/net/ColyseusClient.ts');
    expect(client).toMatch(/shipMountMuzzle\(kind, mount\)/);
    expect(client.match(/this\.localMuzzle\(mount\)/g)?.length).toBe(2); // live beam + ghosts
    expect(src('src/client/render/PixiRenderer.ts').match(/shipMountMuzzle\(shooterKind, mount\)/g)?.length).toBe(2); // player + drone beams
  });
});
