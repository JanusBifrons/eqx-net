/**
 * Capital beam fits (plan section 9) through a real SectorRoom: a spawned beam
 * cruiser (`heavy-cruiser-beam`, heavy beams on its secondary battery) fires
 * its heavy beams through the ordinary AI capital fire path (per-turret fire
 * control → `AiFireResolver.fireMount` → hitscan sink → `laser_fired`), one
 * beam per turret per trigger, and its beam kill slices the wreck.
 *
 * The pilot sits square off the cruiser's starboard beam, so the starboard
 * secondaries bear at once while the 8" main turrets still have a quarter turn
 * to make: the beam (instant) lands before any shell. The pilot's hull is one
 * beam's worth, so the first heavy-beam hit is the kill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { DamageEvent } from '../../../src/shared-types/messages.js';
import { getWeapon } from '../../../src/core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../../src/shared-types/shipKinds.js';

interface LaserFired { shooterId: string; mountId?: string; fromX: number; fromY: number; toX: number; toY: number; hit: boolean; targetId?: string }

describe('SectorRoom integration — capital beam fits (plan section 9)', () => {
  let harness: SectorTestHarness | undefined;
  afterEach(async () => {
    if (harness) await harness.cleanup();
    harness = undefined;
  }, 10_000);

  it('a beam cruiser fires laser_fired from its heavy_beam secondaries and its kill slices', { timeout: 15_000 }, async () => {
    const kind = getShipKind('heavy-cruiser-beam');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    expect([...beamMounts].every((id) => id.startsWith('sec-'))).toBe(true);
    const beam = getWeapon('heavy_beam');
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], capitalWrecks: true, traverseTicksCap: 0,
      // Heading π: bow along −y, starboard (+x mount side) faces −x, at the pilot.
      dronePoses: [{ kind: 'heavy-cruiser-beam', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const beams: LaserFired[] = [];
    cr.onMessage('laser_fired', (m: LaserFired) => { if (m.mountId && beamMounts.has(m.mountId)) beams.push(m); });
    const beamHits: DamageEvent[] = [];
    cr.onMessage('damage', (e: DamageEvent) => { if (e.targetId === pid && e.damage === beam.damage) beamHits.push(e); });

    // First: the heavy beams fire and hit the pilot at full damage (one
    // emitter per beam turret: `capitalShips.test.ts`).
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && beamHits.length < 4) await new Promise((r) => setTimeout(r, 50));
    expect(beams.length, 'a heavy_beam mount fired laser_fired').toBeGreaterThan(0);
    expect(beams[0]!.shooterId.startsWith('swarm-')).toBe(true);
    expect(beams.some((b) => b.hit && b.targetId === pid), 'a heavy beam hit the pilot').toBe(true);
    expect(beamHits.length, 'heavy-beam damage reached the pilot').toBeGreaterThan(0);
    for (const b of beams) expect(Math.hypot(b.toX - b.fromX, b.toY - b.fromY)).toBeLessThanOrEqual(beam.mode === 'hitscan' ? beam.range + 1 : 0);

    // Then the kill: one beam's worth of hull left, so the next beam hit kills.
    const room = harness.getServerRoom() as unknown as SectorRoom;
    const internal = room._internals;
    const before = internal.wreckDescriptors().length;
    for (const [, s] of room.state.ships) if (s.playerId === pid && s.isActive) s.health = beam.damage / 2;
    const deadline2 = Date.now() + 8_000;
    while (Date.now() < deadline2 && internal.wreckDescriptors().length === before) await harness.advance(50);
    const fresh = internal.wreckDescriptors().slice(before);
    expect(fresh.length, 'the pilot heavy cruiser broke up').toBe(1);
    expect(fresh[0]!.parentKind).toBe('heavy-cruiser');
    expect(fresh[0]!.cutKind, 'a heavy-beam kill slices').toBe('slice');
  });

  it('a lance battlecruiser fires laser_fired from its heavy_beam main turrets', { timeout: 15_000 }, async () => {
    const kind = getShipKind('battlecruiser-lance');
    const beamMounts = new Set(kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id));
    expect(beamMounts.size).toBeGreaterThan(0);
    expect([...beamMounts].every((id) => id.startsWith('main-'))).toBe(true);
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], lockTimeCapS: 0, traverseTicksCap: 0,
      // Heading π: broadside to the pilot. traverseTicksCap: 0 snaps the
      // main turrets onto their bearing (real 16" training takes ~10 s).
      dronePoses: [{ kind: 'battlecruiser-lance', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const beams: LaserFired[] = [];
    cr.onMessage('laser_fired', (m: LaserFired) => { if (m.mountId && beamMounts.has(m.mountId) && m.targetId === pid) beams.push(m); });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && beams.length === 0) await new Promise((r) => setTimeout(r, 50));
    expect(beams.length, 'a heavy_beam main turret hit the pilot').toBeGreaterThan(0);
  });

  // No fire gate holds the forward pair back: hull line, lock and line of fire
  // all pass, and the capital turret path spends no ship energy. On film the
  // forward turrets stay quiet only because they are still training (16"-class
  // traverse 0.087 rad/s ≈ 5°/s; the AI helm swings the target ~20° abaft the
  // beam, so they need ~108° to the aft turret's ~88°), and the aft beam kills
  // the target in its ~3.5 s head start. traverseTicksCap: 0 takes the
  // training out, so this proves every bearing turret is free to fire.
  it('every lance main turret that bears from a broadside fires, the forward pair too', { timeout: 15_000 }, async () => {
    const kind = getShipKind('battlecruiser-lance');
    const mains = kind.mounts.filter((m) => m.weaponId === 'heavy_beam').map((m) => m.id);
    expect(mains).toEqual(['main-1', 'main-2', 'main-3']);
    harness = await bootSectorTestServer({
      sectorKey: null, droneCount: 0, testMode: true, asteroidConfig: [], lockTimeCapS: 0, traverseTicksCap: 0,
      // Heading π, the pilot square off the starboard beam abreast the ship's
      // middle: all three main turrets (arc ±135°) bear on it.
      dronePoses: [{ kind: 'battlecruiser-lance', x: 5000, y: 0, angle: Math.PI }],
    });
    const pid = randomUUID();
    const cr = await harness.connectActive(pid, {
      shipKind: 'heavy-cruiser', initialHull: 1_000_000_000, initialShield: 0, startHostile: true, instantLock: true,
    });
    const fired = new Map<string, number>();
    cr.onMessage('laser_fired', (m: LaserFired) => {
      if (m.mountId && mains.includes(m.mountId)) fired.set(m.mountId, (fired.get(m.mountId) ?? 0) + 1);
    });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !mains.every((id) => (fired.get(id) ?? 0) >= 3)) await new Promise((r) => setTimeout(r, 50));
    for (const id of mains) expect(fired.get(id) ?? 0, `${id} fired its heavy beam (repeatedly)`).toBeGreaterThanOrEqual(3);
  });
});
