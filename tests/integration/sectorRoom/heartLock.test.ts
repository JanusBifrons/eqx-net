/**
 * Sector control — a region power's heart starts locked (owner 2026-11-17:
 * "NPC powers have locks? Yes, at their hearts"). Through a real SectorRoom
 * with its galaxy NPC bases and the real control meter (`RobotTerritory`):
 *  1. the heart's garrison builds a real Territory Lock, owned by the power;
 *  2. an overwhelming robot force can't take the heart while it stands;
 *  3. destroy the lock and the robots take it;
 *  4. a held sector that is not a heart (the rest of the core) has no lock and
 *     falls to the same force;
 *  5. the Crimson Expanse heart, held alone by a big trade hub, is the power's
 *     hub (owner: "hand hub to Crimson"), so it carries Crimson's lock.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { RobotTerritory } from '../../../src/server/livingworld/RobotTerritory.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';
import { regionHeart, sectorController } from '../../../src/core/galaxy/control.js';
import { GALAXY_SECTORS } from '../../../src/core/galaxy/galaxy.js';
import { parseOwner } from '../../../src/shared-types/relations.js';

const HEART = regionHeart('azure-deep');
const CORE_NON_HEART = GALAXY_SECTORS.find((s) => s.region === 'core' && s.key !== regionHeart('core'))!.key;
/** Far more robot pressure than a whole base and its patrols push. */
const ROBOT_HORDE = 400;

describe('SectorRoom integration — a power heart is locked (sector control)', () => {
  let harness: SectorTestHarness | undefined;
  let territory: RobotTerritory | undefined;
  afterEach(async () => {
    territory?.stop();
    territory = undefined;
    if (harness) await harness.cleanup();
    harness = undefined;
  });

  async function boot(key: string) {
    harness = await bootSectorTestServer({ sectorKey: key, galaxyBases: true, asteroidConfig: [] });
    await harness.connectAs('player-1'); // the room exists once someone joins
    const internals = harness.getServerRoom()!._internals;
    const robots = new Map<string, number>();
    const clock = { now: 0 };
    territory = new RobotTerritory(
      new Map([[key, harness.getServerRoom() as unknown as LivingWorldRoom]]),
      () => robots,
      { nowMs: () => clock.now, nexusSector: '__none__' },
    );
    territory.start();
    const run = (s: number): void => { for (let i = 0; i < s; i++) { clock.now += 1000; territory!.tick(clock.now); } };
    const locks = () => [...internals.structureRegistry.all()].filter((s) => s.kind === 'territory_lock');
    return { internals, robots, run, locks };
  }

  it("the heart holds against a robot horde until the power's lock is destroyed", async () => {
    const { internals, robots, run, locks } = await boot(HEART);
    const power = sectorController(HEART)!;
    expect(power).toBe('azure-deep');

    // 1. One built lock, the power's own.
    expect(locks()).toHaveLength(1);
    const lock = locks()[0]!;
    expect(lock.isConstructed).toBe(true);
    expect(parseOwner(lock.owner).faction).toBe(power);
    expect(territory!.controlState(HEART)!.holder).toBe(power);

    // 2. The horde can't take it.
    robots.set(HEART, ROBOT_HORDE);
    run(300);
    expect(territory!.sectorOwner(HEART)?.factionId).toBe(power);

    // 3. Destroy the lock: the robots take the heart.
    internals.applyDamage(lock.id, 'swarm-99', 999_999);
    expect(locks()).toHaveLength(0);
    run(300);
    expect(territory!.sectorOwner(HEART)?.factionId).toBe('robots');
  }, 60_000);

  it("the Crimson Expanse heart's trade hub is Crimson's and builds its lock", async () => {
    const heart = regionHeart('crimson-expanse');
    const { internals, locks } = await boot(heart);
    expect(locks()).toHaveLength(1);
    expect(locks()[0]!.isConstructed).toBe(true);
    expect(parseOwner(locks()[0]!.owner).faction).toBe('crimson-expanse');
    const owners = new Set([...internals.structureRegistry.all()].map((s) => parseOwner(s.owner).faction));
    expect(owners.has('traders'), 'no Traders base in the heart').toBe(false);
    expect(territory!.controlState(heart)!.holder).toBe('crimson-expanse');
  }, 60_000);

  it('a held sector that is not a heart has no lock and falls to the same horde', async () => {
    const { robots, run, locks } = await boot(CORE_NON_HEART);
    expect(sectorController(CORE_NON_HEART)).toBe('core');
    expect(locks()).toHaveLength(0);
    robots.set(CORE_NON_HEART, ROBOT_HORDE);
    run(300);
    expect(territory!.sectorOwner(CORE_NON_HEART)?.factionId).toBe('robots');
  }, 60_000);
});
