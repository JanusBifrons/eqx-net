/**
 * Regression lock — a remote heavy beam's drawn length comes from a client
 * ray down the shooter's LIVE barrel, stopping at the first thing it meets.
 *
 * Film review (2026-11-16, PR #698 "still jumps"): each heavy pulse was
 * drawn frozen on its fired line (muzzle to `laser_fired.to`), so while the
 * turret turned, consecutive pulses sat on different lines and the beam
 * jumped. The renderer now draws a styled pulse down the live barrel for
 * `remoteLasers[shooter][mount].dist`, which `updateMirror` writes each frame
 * with the local beam's own hitscan (`combat/remoteBeamRay.ts`): it must stop
 * at a ship in its path, skip the shooter's own hull, and stay unset when the
 * turret's live angle is unknown (the renderer then aims at the wire end).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ColyseusGameClient } from './ColyseusClient.js';
import { PhysicsWorld } from '../../core/physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipShotMuzzle } from '../../core/combat/muzzle.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { beamMaxDist } from '../combat/beamBands.js';
import { mountMuzzleRay } from '../render/beamStyles.js';

interface LaserEntry {
  range: number; hit: boolean; expiresAt: number;
  fromX: number; fromY: number; toX: number; toY: number; dist?: number;
}
interface Internals {
  updateMirror(frameNowMs?: number): void;
  predWorld: PhysicsWorld | null;
  mirror: {
    ships: Map<string, { x: number; y: number; vx: number; vy: number; angle: number; kind?: string; mountAngles?: number[]; shieldDown?: boolean }>;
    remoteLasers?: Map<string, Map<string, LaserEntry>>;
    localPlayerId: string | null;
  };
}
const asInternals = (c: ColyseusGameClient): Internals => c as unknown as Internals;

describe('remote heavy beam: client ray down the live barrel', () => {
  const SHOOTER = 'p-lance';
  const KIND = 'battlecruiser-lance';
  const kind = getShipKind(KIND);
  const mountIdx = kind.mounts!.findIndex((m) => m.id === 'main-1');
  const mount = kind.mounts![mountIdx]!;
  const beamMax = beamMaxDist(getWeapon(mount.weaponId));
  let client: ColyseusGameClient;
  let internals: Internals;

  /** The live barrel ray for a turret angle (the shared muzzle maths). */
  const ray = (turret: number) => mountMuzzleRay(0, 0, 0, mount, turret, shipShotMuzzle(kind, mount), { fromX: 0, fromY: 0, fwdX: 0, fwdY: 0 });

  const fire = (): LaserEntry => {
    const e: LaserEntry = { range: 8000, hit: true, expiresAt: Number.MAX_SAFE_INTEGER, fromX: 0, fromY: 0, toX: 0, toY: 8000 };
    internals.mirror.remoteLasers = new Map([[SHOOTER, new Map([['main-1', e]])]]);
    return e;
  };

  beforeEach(async () => {
    client = new ColyseusGameClient();
    internals = asInternals(client);
    internals.predWorld = await PhysicsWorld.create();
    // The shooter has its own body in the predWorld: the ray must skip it.
    internals.predWorld.spawnShip(SHOOTER, 0, 0, KIND);
    internals.mirror.ships.set(SHOOTER, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: KIND, mountAngles: [] });
  });

  it('stops at a ship in the barrel\'s path, skipping the shooter', () => {
    const turret = 0.4;
    internals.mirror.ships.get(SHOOTER)!.mountAngles![mountIdx] = turret;
    const r = ray(turret);
    // A shield-down fighter 2 km down the live barrel.
    const tx = r.fromX + r.fwdX * 2000, ty = r.fromY + r.fwdY * 2000;
    internals.predWorld!.spawnShip('p-target', tx, ty, 'fighter');
    internals.mirror.ships.set('p-target', { x: tx, y: ty, vx: 0, vy: 0, angle: 0, kind: 'fighter', shieldDown: true });
    internals.predWorld!.tick(1 / 60);
    const e = fire();

    internals.updateMirror();

    expect(e.dist, 'heavy-beam entry gets a client ray length').toBeDefined();
    expect(e.dist!).toBeLessThan(2000);
    expect(e.dist!).toBeGreaterThan(2000 - 4 * getShipKind('fighter').radius);
  });

  it('with nothing in the way the ray runs the weapon\'s full beam range (never stops on its own hull)', () => {
    internals.mirror.ships.get(SHOOTER)!.mountAngles![mountIdx] = 0.4;
    internals.predWorld!.tick(1 / 60);
    const e = fire();
    internals.updateMirror();
    expect(e.dist).toBeCloseTo(beamMax, 6);
  });

  it('turning the turret moves the ray off the target: the next frame runs past it', () => {
    internals.mirror.ships.get(SHOOTER)!.mountAngles![mountIdx] = 0.4;
    const r = ray(0.4);
    const tx = r.fromX + r.fwdX * 2000, ty = r.fromY + r.fwdY * 2000;
    internals.predWorld!.spawnShip('p-target', tx, ty, 'fighter');
    internals.mirror.ships.set('p-target', { x: tx, y: ty, vx: 0, vy: 0, angle: 0, kind: 'fighter', shieldDown: true });
    internals.predWorld!.tick(1 / 60);
    const e = fire();
    internals.updateMirror();
    expect(e.dist!).toBeLessThan(2000);
    internals.mirror.ships.get(SHOOTER)!.mountAngles![mountIdx] = 0.4 + 0.5;
    internals.updateMirror();
    expect(e.dist).toBeCloseTo(beamMax, 6);
  });

  it('an AI capital out of this viewer\'s interest (no turret angles) gets no dist: the renderer aims at the wire end', () => {
    const swarm = new Map<number, unknown>([[77, { x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: kind.radius, kind: 1, shipKind: KIND, sleeping: true }]]);
    (internals.mirror as unknown as { swarm: Map<number, unknown> }).swarm = swarm;
    const e: LaserEntry = { range: 8000, hit: true, expiresAt: Number.MAX_SAFE_INTEGER, fromX: 0, fromY: 0, toX: 0, toY: 8000, dist: 123 };
    internals.mirror.remoteLasers = new Map([['swarm-77', new Map([['main-1', e]])]]);
    internals.updateMirror();
    expect(e.dist).toBeUndefined();
  });
});
