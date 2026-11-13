/**
 * NPC line of fire (friendly fire slice 2, owner decision 2026-11-10: "Fire
 * hits all, but we need NPCs to be aware of this and not fire when blocked").
 *
 * Every shot hits the first thing in its path (slice 1, friendlyFire.test.ts),
 * so an NPC must hold fire while a FRIENDLY body sits on its line of fire: a
 * same-allegiance NPC ship, or a structure of its own faction or base. A
 * player-owned turret holds fire on its owner's own ship and structures. A
 * hostile in the way does NOT block: the NPC shoots it.
 *
 * These run the real room paths (`handleAiFire` → AiFireResolver, the
 * structure turret tick) and record every `applyDamage` call. The capital
 * turret case lives in `tests/unit/capitalLineOfFire.test.ts` (the real
 * WeaponMountTicker + the real LineOfFireGate): in a live room a capital's
 * turrets need tens of seconds of traverse before they bear.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';

type Hit = { target: string; shooter: string };

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

async function bootDrones(peacefulDrones = true): Promise<SectorTestHarness> {
  return bootSectorTestServer({
    sectorKey: null,
    droneCount: 0,
    asteroidConfig: [],
    testMode: true,
    peacefulDrones,
    defaultSpawnX: -4000,
    defaultSpawnY: -4000,
  });
}

describe('SectorRoom integration — NPC line of fire', () => {
  let harness: SectorTestHarness;
  afterEach(async () => { if (harness) await harness.cleanup(); });

  it('a drone holds fire while an ally is between it and its target, and fires once the ally moves', { timeout: 30_000 }, async () => {
    harness = await bootDrones();
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('lof-shooter', 0, 0, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('lof-ally', 0, 150, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('lof-target', 0, 300, 'heavy')).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    const checks0 = internals.lineOfFireCounts().checks;

    internals.aiFire('lof-shooter', 0, 1, 'lof-target');
    await harness.advance(600); // a bolt would have crossed the 150 u gap
    expect(internals.lineOfFireCounts().checks, 'the shot was checked').toBeGreaterThan(checks0);
    expect(hits.filter((h) => h.shooter === 'lof-shooter'), 'held fire: nothing was hit').toEqual([]);

    // The ally moves off the line: the next trigger fires (holding spent no cooldown).
    internals.postToWorker({ type: 'SET_POSITION', entityId: 'lof-ally', x: 600, y: 150, angle: 0, vx: 0, vy: 0, angvel: 0 });
    await harness.advance(150);
    internals.aiFire('lof-shooter', 0, 1, 'lof-target');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hits.some((h) => h.shooter === 'lof-shooter')) await harness.advance(50);
    const mine = hits.filter((h) => h.shooter === 'lof-shooter');
    expect(mine.length, 'fired once clear').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === 'lof-target'), 'the bolt reached the target: ' + JSON.stringify(mine)).toBe(true);
  });

  it('a blocked drone tells its brain which ally was in the way (line-of-fire feedback)', { timeout: 30_000 }, async () => {
    harness = await bootDrones(false);
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('lof-shooter', 0, 0, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('lof-ally', 0, 150, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('lof-target', 0, 300, 'heavy')).toBe(true);
    await harness.advance(100);
    const brain = (room as unknown as {
      aiController: { getBehaviour(id: string): unknown };
    }).aiController.getBehaviour('lof-shooter') as {
      getRecentBlocks(tick: number): number;
      getLastBlockedTick(): number;
      getLastBlockerX(): number;
      getLastBlockerY(): number;
    };
    expect(typeof brain.getRecentBlocks, 'the drone runs a brain with the hook').toBe('function');
    expect(brain.getLastBlockedTick(), 'never blocked yet').toBe(-1_000_000);

    internals.aiFire('lof-shooter', 0, 1, 'lof-target');
    await harness.advance(100);
    const at = brain.getLastBlockedTick();
    expect(at, 'the brain heard about the block').toBeGreaterThanOrEqual(0);
    expect(brain.getRecentBlocks(at)).toBeGreaterThan(0);
    expect(Math.abs(brain.getLastBlockerX()), 'blocker x is the ally').toBeLessThan(40);
    expect(Math.abs(brain.getLastBlockerY() - 150), 'blocker y is the ally').toBeLessThan(40);
  });

  it('a hostile in the way does not block: the drone shoots it',{ timeout: 30_000 }, async () => {
    harness = await bootDrones();
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    expect(internals.spawnTestDrone('lof-shooter', 0, 0, 'fighter')).toBe(true);
    expect(internals.spawnTestDrone('lof-robot', 0, 150, 'robot-square')).toBe(true);
    expect(internals.spawnTestDrone('lof-target', 0, 300, 'heavy')).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    internals.aiFire('lof-shooter', 0, 1, 'lof-target');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !hits.some((h) => h.shooter === 'lof-shooter')) await harness.advance(50);
    const mine = hits.filter((h) => h.shooter === 'lof-shooter');
    expect(mine.length, 'the drone fired').toBeGreaterThan(0);
    expect(mine[0]!.target, 'the bolt hit the robot in the way').toBe('lof-robot');
  });

  // Robot base: Capital (0,0) → Connector (0,-350) → Turret (0,-650), range
  // 600. A pilot at (500,-650) is due east of the turret; a second connector
  // of the same base either sits on that line (170,-650) or off it.
  async function bootRobotBase(extraConnector: { x: number; y: number }) {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: [
        { kind: 'capital', x: 0, y: 0 },
        { kind: 'connector', x: 0, y: -350 },
        { kind: 'turret', x: 0, y: -650 },
        { kind: 'connector', ...extraConnector },
      ],
      prebuiltStructuresOwner: 'npc:robots:r1',
      defaultSpawnX: 500,
      defaultSpawnY: -650,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const turret = [...internals.structureRegistry.all()].find((r) => r.kind === 'turret')!;
    internals.pulseStructureGrid();
    const pilot = randomUUID();
    await harness.connectActive(pilot, { instantLock: true, initialHull: 1_000_000 });
    await harness.advance(300);
    const hits = recordHits(room);
    let engaged = false;
    for (let i = 0; i < 5 && !hits.some((h) => h.shooter === turret.id); i++) {
      internals.tickStructureTurrets();
      if (turret.turretTargetPlayer === pilot) engaged = true;
      await new Promise((r) => setTimeout(r, 650)); // past the beam cadence
    }
    return { pilot, engaged, mine: hits.filter((h) => h.shooter === turret.id) };
  }

  it('an NPC base turret holds fire over its own structure', { timeout: 40_000 }, async () => {
    const { engaged, mine } = await bootRobotBase({ x: 170, y: -650 });
    expect(engaged, 'the turret engaged the pilot').toBe(true);
    expect(mine, 'held fire: its own connector is on the line').toEqual([]);
  });

  it('control: with its connector off the line the same turret fires', { timeout: 40_000 }, async () => {
    const { pilot, engaged, mine } = await bootRobotBase({ x: 170, y: -900 });
    expect(engaged).toBe(true);
    expect(mine.length, 'the turret fired').toBeGreaterThan(0);
    expect(mine.every((h) => h.target === pilot)).toBe(true);
  });

  it("a player's turret holds fire while its owner's ship is on the line", { timeout: 40_000 }, async () => {
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
      defaultSpawnX: 600,
      defaultSpawnY: 250,
    });
    await harness.connectActive(owner);
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const turret = [...internals.structureRegistry.all()].find((r) => r.kind === 'turret')!;
    turret.owner = owner;
    for (let i = 0; i < 3; i++) internals.pulseStructureGrid();
    expect(internals.spawnTestDrone('lof-raider', 800, 250)).toBe(true);
    await harness.advance(100);
    const hits = recordHits(room);
    let engaged = false;
    for (let i = 0; i < 4; i++) {
      internals.tickStructureTurrets();
      if (turret.turretTargetEntityId !== undefined) engaged = true;
      await new Promise((r) => setTimeout(r, 650));
    }
    expect(engaged, 'the turret engaged the drone').toBe(true);
    expect(hits.filter((h) => h.shooter === turret.id), 'held fire over its owner').toEqual([]);
  });
});
