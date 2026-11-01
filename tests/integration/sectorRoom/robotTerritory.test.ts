/**
 * Living World P3 (plan peppy-jumping-pinwheel) — the robot NEXUS + territory
 * over real SectorRooms with the robot director.
 *
 *  1. the nexus spawns as a real `robot-nexus` swarm entity;
 *  2. a killed robot respawns AT the nexus (the robots-only ingress exception),
 *     not at the galaxy edge;
 *  3. destroying the nexus drops its rich loot (cores) and it returns after
 *     its respawn delay;
 *  4. the nexus sector is CLAIMED by the robots (with hysteresis) and its
 *     owner reads `robots` — the value the drone director stamps on
 *     `/galaxy/snapshot`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { ROBOT_DIRECTOR_OPTIONS, ROBOT_SQUAD_LAYOUT } from '../../../src/server/livingworld/robotDirector.js';
import { NEXUS_ID, RobotTerritory } from '../../../src/server/livingworld/RobotTerritory.js';
import { getHoldStore } from '../../../src/server/db/PersistenceWorker.js';
import type { LivingWorldRoom } from '../../../src/server/livingworld/LivingWorldRoom.js';

describe('SectorRoom integration — robot nexus + territory (P3)', () => {
  let h: LivingWorldTestHarness | undefined;
  let t: RobotTerritory | undefined;
  afterEach(async () => {
    t?.stop();
    if (h) await h.cleanup();
    h = undefined;
  }, 15_000);

  async function boot(): Promise<{ h: LivingWorldTestHarness; t: RobotTerritory; clock: { now: number } }> {
    const harness = await bootLivingWorldTestServer({
      sectors: ['greenfall', 'emerald-span'],
      botCount: 6,
      seed: 21,
      director: {
        ...ROBOT_DIRECTOR_OPTIONS,
        botCount: 6,
        squadLayout: { ...ROBOT_SQUAD_LAYOUT, squadCount: 1 },
      },
    });
    const clock = { now: 1_000_000 };
    const rooms = new Map<string, LivingWorldRoom>([
      ['greenfall', harness.getRoom('greenfall') as unknown as LivingWorldRoom],
      ['emerald-span', harness.getRoom('emerald-span') as unknown as LivingWorldRoom],
    ]);
    const territory = new RobotTerritory(rooms, () => harness.director.activeBotCountsBySector(), {
      nexusSector: 'greenfall',
      nexusRespawnMs: 200,
      nowMs: () => clock.now,
    });
    harness.director.setHooks({ respawnAnchor: () => territory.respawnAnchor() });
    territory.start();
    return { h: harness, t: territory, clock };
  }

  it('spawns the nexus, and killed robots reinforce AT it', async () => {
    ({ h, t } = await boot());
    const room = h.getRoom('greenfall');
    const nexus = room._internals.swarmRegistry.get(NEXUS_ID);
    expect(nexus?.shipKind).toBe('robot-nexus');
    const anchor = t.respawnAnchor()!;
    expect(anchor.sectorKey).toBe('greenfall');

    await h.waitUntil(() => h!.director.snapshot().active === 6, 8000, 'robots in');
    // Faithful kill of one robot → it must come back next to the nexus.
    room.despawnLivingWorldBot('rbot-3');
    room.eventBus().emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: 'rbot-3' });
    await h.waitUntil(() => h!.director.snapshot().active === 5, 3000, 'kill observed');
    await h.waitUntil(() => h!.director.snapshot().active === 6, 6000, 'reinforced');
    const spawn = h.events.all({ tag: 'bot_spawn' }).filter((e) => e.data['botId'] === 'rbot-3').at(-1)!;
    expect(spawn.data['anchor']).toBe(true);
    const pose = room.getBotPose('rbot-3')!;
    expect(Math.hypot(pose.x - anchor.x, pose.y - anchor.y)).toBeLessThan(400);
  }, 30_000);

  it('a destroyed nexus drops cores and comes back after its respawn delay', async () => {
    let clock: { now: number };
    ({ h, t, clock } = await boot());
    const room = h.getRoom('greenfall');
    for (let i = 0; i < 6 && room._internals.swarmRegistry.get(NEXUS_ID); i++) {
      room._internals.applyDamage(NEXUS_ID, 'some-player', 50_000);
    }
    expect(room._internals.swarmRegistry.get(NEXUS_ID)).toBeFalsy();
    expect(t.nexusState()!.alive).toBe(false);
    expect(t.respawnAnchor()).toBeNull(); // robots fall back to edge ingress
    const pods = getHoldStore().inSector('greenfall', 'pod');
    expect(pods.some((p) => (p.hold.goods.core ?? 0) >= 2)).toBe(true);

    clock.now += 1000; // past nexusRespawnMs
    t.tick(clock.now);
    expect(t.nexusState()!.alive).toBe(true);
  }, 30_000);

  /**
   * P3b — harvesters: spawn at the nexus, scoop a loot pod, bank the cargo into
   * the nexus; destroying the nexus spills the hoard (its hold + its table).
   */
  it('harvesters collect a pod, bank it into the nexus, and the hoard spills when the nexus dies', async () => {
    let clock: { now: number };
    ({ h, t, clock } = await boot());
    const room = h.getRoom('greenfall');
    clock.now += 1000;
    t.tick(clock.now);
    expect(t.liveHarvesters()).toHaveLength(2);
    const hid = t.liveHarvesters()[0]!;
    expect(room._internals.swarmRegistry.get(hid)?.shipKind).toBe('robot-harvester');

    // A pod right under the harvester — the room's collector picks it up.
    const pose = room.getBotPose(hid)!;
    room.tradeDropAt({ goods: { alloy: 10 }, credits: 0, blueprints: [] }, pose.x, pose.y);
    await h.waitUntil(() => room.holdWeight(hid) > 0, 4000, 'harvester scooped the pod');

    // Nothing left to chase + cargo aboard ⇒ it banks at the (adjacent) nexus.
    for (let i = 0; i < 3 && room.holdWeight(hid) > 0; i++) { clock.now += 1000; t.tick(clock.now); }
    expect(room.holdWeight(hid)).toBe(0);
    expect(getHoldStore().get(NEXUS_ID)?.hold.goods.alloy).toBe(10);

    // Destroy the nexus: the hoard spills alongside its loot table.
    for (let i = 0; i < 6 && room._internals.swarmRegistry.get(NEXUS_ID); i++) {
      room._internals.applyDamage(NEXUS_ID, 'some-player', 50_000);
    }
    const alloy = getHoldStore().inSector('greenfall', 'pod').reduce((s, p) => s + (p.hold.goods.alloy ?? 0), 0);
    expect(alloy).toBeGreaterThanOrEqual(10 + 20); // the hoard + the table's 20-40 alloy
    expect(getHoldStore().get(NEXUS_ID)).toBeUndefined();
  }, 30_000);

  it('a killed harvester spills what it carries', async () => {
    let clock: { now: number };
    ({ h, t, clock } = await boot());
    const room = h.getRoom('greenfall');
    clock.now += 1000;
    t.tick(clock.now);
    const hid = t.liveHarvesters()[0]!;
    const pose = room.getBotPose(hid)!;
    room.tradeDropAt({ goods: { core: 3 }, credits: 0, blueprints: [] }, pose.x, pose.y);
    await h.waitUntil(() => room.holdWeight(hid) > 0, 4000, 'scooped');
    for (let i = 0; i < 6 && room._internals.swarmRegistry.get(hid); i++) {
      room._internals.applyDamage(hid, 'some-player', 5_000);
    }
    expect(getHoldStore().get(hid)).toBeUndefined();
    const cores = getHoldStore().inSector('greenfall', 'pod').reduce((s, p) => s + (p.hold.goods.core ?? 0), 0);
    expect(cores).toBeGreaterThanOrEqual(3);
    expect(t.liveHarvesters()).not.toContain(hid);
  }, 30_000);

  it('the nexus sector is claimed by the robots (and held through a dip)', async () => {
    let clock: { now: number };
    ({ h, t, clock } = await boot());
    expect(t.sectorOwner('greenfall')).toBeNull();
    for (let s = 0; s < 120; s++) { clock.now += 1000; t.tick(clock.now); }
    expect(t.sectorOwner('greenfall')).toEqual({ factionId: 'robots', contested: false });
    expect(t.heldSectors()).toContain('greenfall');
    // The neighbour (no robots once they've gathered at home, no nexus) stays free.
    expect(t.sectorOwner('emerald-span')).toBeNull();
  }, 30_000);
});
