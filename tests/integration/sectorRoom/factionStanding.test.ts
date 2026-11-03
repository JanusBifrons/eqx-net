/**
 * Factions F3 (plan soft-leaping-truffle v4) in a real room:
 *  - a hit lowers the victim faction's view of the attacker, once per window;
 *  - a player's own policy makes their turret fire on a pilot they rate low,
 *    and does nothing while it's off;
 *  - `set_faction_policy` sets the policy for the sending player only.
 *
 * Layout (as npcOwnership.test.ts): Capital (0,0) → Connector (0,-350) →
 * Turret (0,-650); pilots spawn at (0,-1000), inside the turret's range.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector, type TradeRoom } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import { getHoldStore, getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';
import { MINOR_FACTIONS, STANDING_HIT_DELTA } from '../../../src/shared-types/factions.js';
import { clearConvoyHaulers, registerConvoyHauler } from '../../../src/server/economy/convoyCarriers.js';

const OWNER = '6a7e0000-0000-4000-8000-0000000000a1';
const LAYOUT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: 0, y: -350 },
  { kind: 'turret', x: 0, y: -650 },
];

describe('SectorRoom integration — faction standing and policy (F3)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    setTradeSink(null);
    if (harness) await harness.cleanup();
  });

  async function boot(owner: string) {
    harness = await bootSectorTestServer({
      sectorKey: 'sol-prime',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: LAYOUT,
      prebuiltStructuresOwner: owner,
      defaultSpawnX: 0,
      defaultSpawnY: -1000,
    });
    await harness.connectAs(randomUUID());
    const room = harness.getServerRoom()!;
    const internals = room._internals;
    const all = [...internals.structureRegistry.all()];
    const turret = all.find((r) => r.kind === 'turret')!;
    const capital = all.find((r) => r.kind === 'capital')!;
    internals.pulseStructureGrid();
    const store = new EconomyStore({ persistence: getPersistence });
    const dir = new TradeDirector(new Map<string, TradeRoom>(), store, getHoldStore(), { wallet: getWallet() });
    setTradeSink(dir);
    const aim = () => {
      internals.tickStructureTurrets();
      return turret.turretTargetPlayer;
    };
    return { internals, turret, capital, store, aim };
  }

  it('hitting an NPC base lowers that faction’s view of the pilot, once per window', async () => {
    const { internals, capital, store } = await boot('npc:traders:t1');
    const pilot = randomUUID();
    await harness.connectActive(pilot);
    internals.applyDamage(capital.id, pilot, 1);
    internals.applyDamage(capital.id, pilot, 1);
    expect(store.standing('traders', pilot)).toBe(STANDING_HIT_DELTA);
    expect(store.standing(pilot, 'traders'), 'the attacker’s own view is untouched').toBe(0);
  });

  it('v4 C: raiding a contracted convoy costs standing with its owner AND its carrier', async () => {
    const { internals, store } = await boot('npc:traders:t1');
    const pilot = randomUUID();
    await harness.connectActive(pilot);
    const owner = MINOR_FACTIONS.find((f) => f.specialty === 'mining')!.id;
    const carrier = MINOR_FACTIONS.find((f) => f.specialty === 'freight')!.id;
    const haulerId = 'hauler-convoy-test1';
    const room = harness.getServerRoom()!;
    expect(room.spawnLivingWorldBot({ botId: haulerId, kind: 'trader-hauler', x: 400, y: -1000 })).toBe(true);
    registerConvoyHauler(haulerId, { owner, carrier });
    try {
      internals.applyDamage(haulerId, pilot, 1);
      internals.applyDamage(haulerId, pilot, 1);
      expect(store.standing(owner, pilot), 'the owner minds').toBe(STANDING_HIT_DELTA);
      expect(store.standing(carrier, pilot), 'and so does the carrier').toBe(STANDING_HIT_DELTA);
    } finally {
      clearConvoyHaulers();
    }
  });

  it('a player hitting another player’s base lowers the owner’s view of them', async () => {
    const { internals, capital, store } = await boot(OWNER);
    const pilot = randomUUID();
    await harness.connectActive(pilot);
    internals.applyDamage(capital.id, pilot, 1);
    expect(store.standing(OWNER, pilot)).toBe(STANDING_HIT_DELTA);
  });

  it('a player’s policy makes their turret fire on a pilot they rate low', async () => {
    const { store, aim } = await boot(OWNER);
    const pilot = randomUUID();
    await harness.connectActive(pilot);
    await harness.advance(300);
    store.adjustStanding(OWNER, pilot, -20);
    expect(aim(), 'policy off: a disliked pilot is still left alone').toBeUndefined();
    store.setPlayerPolicy(OWNER, { hostileBelow: -10, alliedAbove: null });
    expect(aim(), 'below the line: the turret engages').toBe(pilot);
    store.adjustStanding(OWNER, pilot, 15); // now −5, above −10
    expect(aim(), 'back above the line: it stops').toBeUndefined();
  });

  it('set_faction_policy sets the sender’s own policy', async () => {
    const { store } = await boot(OWNER);
    const me = randomUUID();
    const client = await harness.connectActive(me);
    client.send('set_faction_policy', { type: 'set_faction_policy', policy: { hostileBelow: -50, alliedAbove: 75 } });
    // A malformed policy (out of range) is dropped.
    client.send('set_faction_policy', { type: 'set_faction_policy', policy: { hostileBelow: 30, alliedAbove: null } });
    await harness.advance(200);
    expect(store.playerPolicy(me)).toEqual({ hostileBelow: -50, alliedAbove: 75 });
    expect(store.policyOf(me).hostileBelow).toBe(-50);
    expect(store.playerPolicy(OWNER), 'nobody else’s').toEqual({ hostileBelow: null, alliedAbove: null });
  });
});
