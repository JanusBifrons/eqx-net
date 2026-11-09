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
import { isChinMount, shipMountMuzzle, structureMountMuzzle } from '../../src/core/combat/muzzle.js';
import { shipTuning } from '../../src/shared-types/shipScale/tuning.js';
import { muzzleReach, shipTurrets, structureTurrets } from '../../src/client/render/art/turretLayout.js';

describe('muzzle parity (turrets T3, #15)', () => {
  it('every ship turret\'s drawn tip is its fire point (chin guns keep the 20 u clearance)', () => {
    for (const kind of SHIP_KINDS_LIST) {
      const places = shipTurrets(kind.id);
      (kind.mounts ?? []).forEach((m, i) => {
        const t = places[i]!;
        if (isChinMount(m)) {
          expect(shipMountMuzzle(kind, m), `${kind.id}/${m.id}`).toBeNull();
          // The chin gun's tip, measured from the mount, is the kind's chin clearance.
          expect(-t.py + muzzleReach(t), `${kind.id}/${m.id}`).toBeCloseTo(shipTuning(kind).muzzleClearance, 6);
        } else {
          expect(muzzleReach(t), `${kind.id}/${m.id}`).toBeCloseTo(shipMountMuzzle(kind, m)!, 6);
          if (t.naval) {
            // Capital naval turrets are sized by calibre to the hull beam
            // (CAPITAL_TURRETS): the barrel tip stays within one beam of the pivot.
            const hull = (kind.shape as { hull: Array<[number, number]> }).hull;
            let beam = 0;
            for (const [x] of hull) beam = Math.max(beam, Math.abs(x) * 2);
            expect(muzzleReach(t), `${kind.id}/${m.id}`).toBeLessThanOrEqual(beam * (m.turretScale ?? 1));
          } else {
            // Turrets stay within the kind's caps (no giant cannons on big hulls).
            expect(muzzleReach(t), `${kind.id}/${m.id}`).toBeLessThanOrEqual(shipTuning(kind).barrelLenMax);
          }
        }
      });
    }
  });

  it('every structure turret\'s drawn tip is its fire point', () => {
    for (const sk of STRUCTURE_KINDS_LIST) {
      for (const t of structureTurrets(sk.id)) {
        // Coastal defences: naval guns' tip is gunhouse front + barrel (structureMountMuzzle).
        expect(muzzleReach(t), `${sk.id}/${t.mount.id}`).toBeCloseTo(structureMountMuzzle(sk.id, t.mount), 6);
      }
    }
  });

  it('every fire site, server and client, calls the shared muzzle', () => {
    const src = (p: string): string => readFileSync(p, 'utf8');
    expect(src('src/server/rooms/PlayerFireResolver.ts')).toMatch(/shipShotMuzzle\(shipKind, mount\)/);
    expect(src('src/server/rooms/AiFireResolver.ts')).toMatch(/shipShotMuzzle\(droneKind, mount, true\)/);
    const grid = src('src/server/structures/StructureGridSubsystem.ts');
    // Coastal defences: one shared muzzle for every structure mount's fire (beam, shells, missile).
    expect(grid).toMatch(/const muzzle = structureMountMuzzle\(rec\.kind, mount\)/);
    expect(grid).not.toMatch(/structureTurretMuzzle\(/);
    expect(grid).not.toMatch(/radius \+ 8/);
    const client = src('src/client/net/ColyseusClient.ts');
    expect(client).toMatch(/shipShotMuzzle\(kind, mount\)/);
    expect(client.match(/this\.localMuzzle\(mount\)/g)?.length).toBe(2); // live beam + ghosts
    expect(src('src/client/render/PixiRenderer.ts').match(/shipShotMuzzle\(shooterKind, mount/g)?.length).toBe(2); // player + drone beams
    // No fire site hardcodes a muzzle distance any more (ship scale).
    for (const f of ['src/server/rooms/PlayerFireResolver.ts', 'src/server/rooms/AiFireResolver.ts', 'src/client/render/PixiRenderer.ts']) {
      expect(src(f), f).not.toMatch(/\?\? (16|20|MUZZLE_CLEARANCE)\b/);
    }
  });
});
