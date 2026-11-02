/**
 * v4 T1 — teleporters in a real room (the teleport-test layout): a powered
 * Capital with a teleporter on each side, paired at seed.
 *
 *  - Spare power fills each capacitor up to the jump's charge (it depends on
 *    distance only), and no further.
 *  - Loading a pad moves goods out of base storage onto the pad hold.
 *  - Firing runs one cycle on BOTH pads; at the swap the pad holds trade
 *    places, only the firing end spends its charge, and the arrivals unload
 *    into base storage on the next pulse.
 *  - A late joiner sees the pair and the charge in room state (#16).
 *  - Messages are owner-gated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { jumpCharge, TOLL_DODGE_STANDING, TP_PHASE, tollFor } from '../../../src/shared-types/teleport.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector, type TradeRoom } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import { getHoldStore, getPersistence, getWallet } from '../../../src/server/db/PersistenceWorker.js';

const OWNER = 'face0000-0000-4000-8000-000000000002';
const LAYOUT = [
  { kind: 'capital', x: 0, y: 0 },
  { kind: 'connector', x: -600, y: 0 },
  { kind: 'connector', x: 600, y: 0 },
  { kind: 'teleporter', x: -1300, y: 0 },
  { kind: 'teleporter', x: 1300, y: 0 },
];

describe('SectorRoom integration — teleporters (v4 T1)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  async function boot() {
    harness = await bootSectorTestServer({
      sectorKey: 'teleport-test',
      droneCount: 0,
      testMode: true,
      asteroidConfig: [],
      prebuiltStructures: LAYOUT,
      prebuiltStructuresOwner: OWNER,
      prebuiltStorageGoods: { alloy: 50 },
      pairTeleporters: true,
      teleportCycleScale: 0.01,
      defaultSpawnX: 0,
      defaultSpawnY: 900,
    } as never);
    const client = await harness.connectActive(OWNER);
    const internals = harness.getServerRoom()!._internals;
    const all = [...internals.structureRegistry.all()];
    const [a, b] = all.filter((r) => r.kind === 'teleporter');
    const capital = all.find((r) => r.kind === 'capital')!;
    const eid = (id: string): number => internals.swarmRegistry.get(id)!.entityId;
    return { client, internals, a: a!, b: b!, capital, eid };
  }

  async function pulses(n: number, internals: { pulseStructureGrid(): void }): Promise<void> {
    for (let i = 0; i < n; i++) internals.pulseStructureGrid();
    await harness.advance(20);
  }

  it('charges to the jump’s charge, loads a pad, and a fired jump swaps the pads', { timeout: 30_000 }, async () => {
    const { client, internals, a, b, capital, eid } = await boot();
    expect(a.tpPartner?.uid).toBe(b.uid);
    expect(b.tpPartner?.uid).toBe(a.uid);
    const need = jumpCharge(Math.hypot(a.x - b.x, a.y - b.y));

    // Spare power fills the capacitors, capped at the jump's charge.
    await pulses(400, internals);
    expect(a.tpCharge).toBe(need);
    expect(b.tpCharge).toBe(need);

    // Load 10 alloy onto A's pad from the Capital.
    client.send('teleport_pad_load', { type: 'teleport_pad_load', entityId: eid(a.id), good: 'alloy', qty: 10 });
    await harness.advance(150);
    expect(a.padHold?.goods.alloy).toBe(10);
    expect(capital.hold?.goods.alloy).toBe(40);

    // Fire A. Both pads run the cycle; A spends its charge, B keeps its own.
    client.send('teleport_fire', { type: 'teleport_fire', entityId: eid(a.id) });
    await harness.advance(100);
    expect(a.tpPhase).not.toBe(TP_PHASE.IDLE);
    expect(b.tpPhase).toBe(a.tpPhase);
    for (let i = 0; i < 40 && a.tpPhase !== TP_PHASE.IDLE; i++) {
      internals.tickStructureTurrets();
      await harness.advance(30);
    }
    expect(a.tpPhase).toBe(TP_PHASE.IDLE);
    expect(b.tpPhase).toBe(TP_PHASE.IDLE);
    // A spent its charge (the room's own 1 Hz pulse may already have put a
    // little spare power back, so not exactly 0); B kept all of its own.
    expect(a.tpCharge ?? 0).toBeLessThan(need / 4);
    expect(b.tpCharge).toBe(need);
    // The pad holds traded places: the alloy is on B's pad…
    expect(a.padHold?.goods.alloy ?? 0).toBe(0);
    expect(b.padHold?.goods.alloy).toBe(10);
    // …and unloads into B's base storage (the same Capital here) next pulse.
    internals.pulseStructureGrid();
    expect(b.padHold?.goods.alloy ?? 0).toBe(0);
    expect(capital.hold?.goods.alloy).toBe(50);
  });

  it('a late joiner sees the pair and the charge in room state', { timeout: 30_000 }, async () => {
    const { internals, a, b, eid } = await boot();
    await pulses(50, internals);
    const late = await harness.connectActive(randomUUID());
    await harness.advance(200);
    const st = (late as unknown as { state: { structures: Map<string, { tpPartner?: number; tpChargePct?: number }> } }).state.structures;
    const row = st.get(String(eid(a.id)));
    expect(row?.tpPartner).toBe(eid(b.id));
    expect(row?.tpChargePct ?? 0).toBeGreaterThan(0);
  });

  it('another player cannot fire, pair or unload someone else’s teleporter', { timeout: 30_000 }, async () => {
    const { internals, a, eid } = await boot();
    await pulses(400, internals);
    const stranger = await harness.connectActive(randomUUID());
    stranger.send('teleport_fire', { type: 'teleport_fire', entityId: eid(a.id) });
    stranger.send('teleport_unpair', { type: 'teleport_unpair', entityId: eid(a.id) });
    await harness.advance(150);
    expect(a.tpPhase ?? TP_PHASE.IDLE).toBe(TP_PHASE.IDLE);
    expect(a.tpPartner).toBeDefined();
  });
});

describe('SectorRoom integration — ships ride the swap (v4 T2)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('a pilot on pad A and a drone on pad B trade places; the pilot’s epoch bumps', { timeout: 30_000 }, async () => {
    harness = await bootSectorTestServer({
      sectorKey: 'teleport-test', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: LAYOUT, prebuiltStructuresOwner: OWNER, pairTeleporters: true,
      teleportCycleScale: 0.01, peacefulDrones: true,
      scenarioDrones: [{ x: 1300, y: 100 }],
      defaultSpawnX: 0, defaultSpawnY: 900,
    } as never);
    const client = await harness.connectActive(OWNER, { shipKind: 'fighter', spawnX: -1300, spawnY: -50 });
    const internals = harness.getServerRoom()!._internals;
    const [a] = [...internals.structureRegistry.all()].filter((r) => r.kind === 'teleporter');
    const drone = [...internals.swarmRegistry.all()].find((r) => r.kind === 1)!;
    for (let i = 0; i < 400; i++) internals.pulseStructureGrid();
    await harness.advance(50);
    const before = internals.playerPose(OWNER)!;
    expect(Math.abs(before.x - -1300)).toBeLessThan(300); // on pad A
    expect(before.poseEpoch).toBe(0);

    client.send('teleport_fire', { type: 'teleport_fire', entityId: internals.swarmRegistry.get(a!.id)!.entityId });
    for (let i = 0; i < 60 && (a!.tpPhase ?? 0) !== 0 || i < 2; i++) {
      internals.tickStructureTurrets();
      await harness.advance(30);
    }
    const after = internals.playerPose(OWNER)!;
    expect(after.poseEpoch).toBe(1);
    expect(after.x).toBeGreaterThan(900); // now on pad B (x 1300)
    const dronePose = internals.swarmPose(drone.id)!;
    expect(dronePose.x).toBeLessThan(-900); // the drone came the other way
  });
});

describe('SectorRoom integration — teleporter tolls (v4 T4)', () => {
  let harness: SectorTestHarness;
  afterEach(async () => {
    setTradeSink(null);
    if (harness) await harness.cleanup();
  });

  async function bootToll(nonPayer: 'standing' | 'hostile' = 'standing') {
    harness = await bootSectorTestServer({
      sectorKey: 'teleport-test', droneCount: 0, testMode: true, asteroidConfig: [],
      prebuiltStructures: LAYOUT, prebuiltStructuresOwner: OWNER, pairTeleporters: true,
      teleportCycleScale: 0.01, defaultSpawnX: 0, defaultSpawnY: 900,
    } as never);
    const owner = await harness.connectActive(OWNER, { shipKind: 'fighter', initialWallet: 0 });
    const internals = harness.getServerRoom()!._internals;
    const store = new EconomyStore({ persistence: getPersistence });
    setTradeSink(new TradeDirector(new Map<string, TradeRoom>(), store, getHoldStore(), { wallet: getWallet() }));
    const [a, b] = [...internals.structureRegistry.all()].filter((r) => r.kind === 'teleporter');
    const eid = internals.swarmRegistry.get(a!.id)!.entityId;
    // A toll on both pads (a rider pays the pad they board).
    for (const t of [a!, b!]) {
      owner.send('set_teleport_toll', { type: 'set_teleport_toll', entityId: internals.swarmRegistry.get(t.id)!.entityId, toll: { per1000: 100, nonPayer } });
    }
    for (let i = 0; i < 400; i++) internals.pulseStructureGrid();
    await harness.advance(100);
    expect(a!.tpToll).toEqual({ per1000: 100, nonPayer });
    const credits = tollFor(jumpCharge(2600), 100);
    return { owner, internals, a: a!, eid, store, credits };
  }

  async function runJump(owner: { send(t: string, m: unknown): void }, internals: { tickStructureTurrets(): void }, a: { tpPhase?: number }, eid: number): Promise<void> {
    owner.send('teleport_fire', { type: 'teleport_fire', entityId: eid });
    await harness.advance(60);
    for (let i = 0; i < 60 && (a.tpPhase ?? 0) !== 0; i++) {
      internals.tickStructureTurrets();
      await harness.advance(30);
    }
  }

  it('a rider is offered the toll, pays it, and the owner is paid', { timeout: 30_000 }, async () => {
    const { owner, internals, a, eid, credits } = await bootToll();
    const RIDER = randomUUID();
    const rider = await harness.connectActive(RIDER, { shipKind: 'fighter', spawnX: -1300, spawnY: -50, initialWallet: 1000 });
    const prompts: Array<{ padId: number; credits: number }> = [];
    rider.onMessage('teleport_toll', (m: { padId: number; credits: number }) => {
      prompts.push(m);
      rider.send('teleport_toll_answer', { type: 'teleport_toll_answer', padId: m.padId, answer: 'pay' });
    });
    await runJump(owner, internals, a, eid);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.credits).toBe(credits);
    expect(getWallet().balance(RIDER)).toBe(1000 - credits);
    expect(getWallet().balance(OWNER)).toBe(credits);
  });

  it('a rider who declines still rides and loses the owner’s standing', { timeout: 30_000 }, async () => {
    const { owner, internals, a, eid, store } = await bootToll();
    const RIDER = randomUUID();
    const rider = await harness.connectActive(RIDER, { shipKind: 'fighter', spawnX: -1300, spawnY: -50, initialWallet: 1000 });
    rider.onMessage('teleport_toll', (m: { padId: number }) => {
      rider.send('teleport_toll_answer', { type: 'teleport_toll_answer', padId: m.padId, answer: 'decline' });
    });
    await runJump(owner, internals, a, eid);
    expect(getWallet().balance(RIDER)).toBe(1000);
    expect(store.standing(OWNER, RIDER)).toBe(TOLL_DODGE_STANDING);
    expect(internals.playerPose(RIDER)!.x).toBeGreaterThan(900); // rode anyway
  });

  it('“Always pay” is remembered: the next jump pays without asking', { timeout: 40_000 }, async () => {
    const { owner, internals, a, eid, credits } = await bootToll();
    const RIDER = randomUUID();
    const rider = await harness.connectActive(RIDER, { shipKind: 'fighter', spawnX: -1300, spawnY: -50, initialWallet: 1000 });
    let prompts = 0;
    rider.onMessage('teleport_toll', (m: { padId: number }) => {
      prompts++;
      rider.send('teleport_toll_answer', { type: 'teleport_toll_answer', padId: m.padId, answer: 'always' });
    });
    await runJump(owner, internals, a, eid);
    // The rider is on the other pad now; recharge and jump back.
    for (let i = 0; i < 400; i++) internals.pulseStructureGrid();
    await harness.advance(50);
    await runJump(owner, internals, a, eid);
    expect(prompts).toBe(1);
    expect(getWallet().balance(RIDER)).toBe(1000 - 2 * credits);
  });
});
