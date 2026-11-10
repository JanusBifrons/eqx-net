/**
 * Friendly fire for every shot (owner decision 2026-11-10: "Fire hits all, but
 * we need NPCs to be aware of this and not fire when blocked ... For now I
 * don't mind them just being dumb and killing each other").
 *
 * Every shot hits the first thing in its path, the shooter's own side
 * included. Before this slice, an NPC's bolts and beams passed through ships
 * of its own allegiance (allegiances rule 6) and a structure turret's beam
 * landed on its target through anything in between. These run the real room
 * paths (`handleAiFire` → AiFireResolver / ProjectilePipeline, the turret
 * tick) and record every `applyDamage` call.
 *
 * Also locks the hostility decision: an NPC hitting its own side by accident
 * does NOT make the victim hostile to the shooter (no civil war after one
 * stray shot).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

type Hit = { target: string; shooter: string };

/** Record every applyDamage on the server room (then apply it as normal). */
function recordHits(room: unknown): Hit[] {
  const hits: Hit[] = [];
  const r = room as { applyDamage: (t: string, s: string, ...rest: unknown[]) => void };
  const orig = r.applyDamage.bind(r);
  r.applyDamage = (t: string, s: string, ...rest: unknown[]) => {
    hits.push({ target: t, shooter: s });
    orig(t, s, ...rest);
  };
  return hits;
}

async function bootDrones(): Promise<SectorTestHarness> {
  return bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    asteroidConfig: [],
    testMode: true,
    peacefulDrones: true,
    defaultSpawnX: -4000,
    defaultSpawnY: -4000,
  });
}

describe('SectorRoom integration — friendly fire', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('(a) an NPC drone\'s bolt hits the allied drone between it and its target', { timeout: 30_000 }, async () => {
    harness = await bootDrones();
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    // Shooter at the origin facing +y; its ally 150 u ahead; the target behind.
    expect(internals.spawnTestDrone('ff-shooter', 0, 0, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('ff-ally', 0, 150, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('ff-target', 0, 300, 'heavy')).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    internals.aiFire('ff-shooter', 0, 1, 'ff-target');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hits.some((h) => h.shooter === 'ff-shooter')) await harness.advance(50);
    const mine = hits.filter((h) => h.shooter === 'ff-shooter');
    expect(mine.length, 'the bolt hit something').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === 'ff-ally'), 'the bolt stopped on the ally: ' + JSON.stringify(mine)).toBe(true);

    // Hostility: one stray shot must not turn the ally on the shooter.
    expect(internals.npcHostileTo('ff-ally', 'ff-shooter'), 'the ally turned hostile to its own side').toBe(false);
  });

  it('(a) an NPC drone\'s BEAM ends on the allied drone between it and its target', { timeout: 30_000 }, async () => {
    harness = await bootDrones();
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('ff-beamer', 0, 0, 'interceptor')).toBe(true);
    expect(internals.spawnTestDrone('ff-ally', 0, 120, 'heavy')).toBe(true);
    expect(internals.spawnTestDrone('ff-target', 0, 220, 'heavy')).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    internals.aiFire('ff-beamer', 0, 1, 'ff-target');
    const mine = hits.filter((h) => h.shooter === 'ff-beamer');
    expect(mine.length, 'the beam hit something').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === 'ff-ally'), 'the beam stopped on the ally: ' + JSON.stringify(mine)).toBe(true);
    expect(internals.npcHostileTo('ff-ally', 'ff-beamer')).toBe(false);
  });

  it('(b) a capital\'s shell hits its own escort in the path', { timeout: 30_000 }, async () => {
    harness = await bootDrones();
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('ff-bb', 0, 0, 'battleship')).toBe(true);
    expect(internals.spawnTestDrone('ff-escort', 0, 1400, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('ff-enemy', 0, 1700, 'heavy')).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    // A real 8" shell leaves the battleship's centre (the owner skip covers
    // its own hull) and flies +y through the escort toward the enemy.
    internals.spawnTestProjectile('ff-bb', 0, 0, 0, 1500, 'naval_m', 50);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !hits.some((h) => h.shooter === 'ff-bb')) await harness.advance(50);
    const mine = hits.filter((h) => h.shooter === 'ff-bb');
    expect(mine.length, 'the shell hit something').toBeGreaterThan(0);
    expect(mine[0]!.target, 'the shell burst on the escort: ' + JSON.stringify(mine)).toBe('ff-escort');
    expect(internals.npcHostileTo('ff-escort', 'ff-bb')).toBe(false);
  });

  it('(c) a structure turret\'s beam hits its owner\'s own ship in the path', { timeout: 40_000 }, async () => {
    const owner = randomUUID();
    harness = await bootSectorTestServer({
      sectorKey: null,
      asteroidConfig: [],
      droneCount: 0,
      testMode: true,
      peacefulDrones: true,
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 400, y: 0 },
        { kind: 'turret', x: 400, y: 250 },
        { kind: 'solar', x: -200, y: 500 },
        { kind: 'connector', x: -200, y: 330 },
      ],
      // The owner's ship parks between the turret (400,250) and the drone (800,250).
      defaultSpawnX: 600,
      defaultSpawnY: 250,
    });
    await harness.connectActive(owner);
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const turret = [...internals.structureRegistry.all()].find((r) => r.kind === 'turret')!;
    turret.owner = owner;
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    const pose = internals.playerPose(owner)!;
    expect(Math.abs(pose.y - 250), 'the owner parked on the line of fire').toBeLessThan(40);
    expect(internals.spawnTestDrone('ff-raider', 800, 250)).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    let engaged = false;
    for (let i = 0; i < 6 && !hits.some((h) => h.shooter === turret.id); i++) {
      internals.tickStructureTurrets();
      if (turret.turretTargetEntityId !== undefined) engaged = true;
      await new Promise((r) => setTimeout(r, 650)); // past the 600 ms beam cadence
    }
    expect(engaged, 'the turret engaged the drone').toBe(true);
    const mine = hits.filter((h) => h.shooter === turret.id);
    expect(mine.length, 'the turret fired').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === owner), 'the beam stopped on its owner\'s ship: ' + JSON.stringify(mine)).toBe(true);
  });
});
