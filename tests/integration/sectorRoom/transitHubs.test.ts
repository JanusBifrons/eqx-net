/**
 * v4 H — NPC transit hubs, with the two real rooms at the ends of one transit
 * link, each growing its real NPC bases (galaxyBasePlan).
 *
 *  - Both ends grow a teleporter tagged with the link; the two find each
 *    other at run time (by link id, through the broker).
 *  - They fire when a ship boards and charge the owner's toll.
 *  - A pilot who boards one is asked the toll, pays, and is carried to the
 *    far sector.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { bootLivingWorldTestServer, type LivingWorldTestHarness } from './harness.js';
import { transitNetwork } from '../../../src/core/bases/galaxyBases.js';
import { TRANSIT_HUB_BASE_ID } from '../../../src/core/bases/transitNetwork.js';
import { NPC_LINK_TOLL, TP_PHASE } from '../../../src/shared-types/teleport.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';

const PILOT = 'face0000-0000-4000-8000-000000000006';

describe('SectorRoom integration — transit hubs (v4 H)', () => {
  let harness: LivingWorldTestHarness;
  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it('the two ends of a hub link pair, fire when a ship boards, charge a toll and carry the pilot', { timeout: 60_000 }, async () => {
    const link = transitNetwork().links.find((l) => l.a.baseId === TRANSIT_HUB_BASE_ID || l.b.baseId === TRANSIT_HUB_BASE_ID)!;
    const hubEnd = link.a.baseId === TRANSIT_HUB_BASE_ID ? link.a : link.b;
    const farEnd = hubEnd === link.a ? link.b : link.a;
    harness = await bootLivingWorldTestServer({
      sectors: [hubEnd.sector, farEnd.sector], botCount: 0, galaxyBases: true, teleportCycleScale: 0.05,
    });
    const roomH = harness.getRoom(hubEnd.sector) as SectorRoom;
    const roomF = harness.getRoom(farEnd.sector) as SectorRoom;
    const tpH = [...roomH._internals.structureRegistry.all()].find((r) => r.npcLink === link.id);
    const tpF = [...roomF._internals.structureRegistry.all()].find((r) => r.npcLink === link.id);
    expect(tpH, 'the hub grew its end').toBeDefined();
    expect(tpF, 'the far base grew its end').toBeDefined();

    // They find each other by link id on the first teleporter tick.
    roomH._internals.tickStructureTurrets();
    roomF._internals.tickStructureTurrets();
    expect(tpH!.tpPartner).toEqual({ sectorKey: farEnd.sector, uid: tpF!.uid });
    expect(tpF!.tpPartner).toEqual({ sectorKey: hubEnd.sector, uid: tpH!.uid });
    expect(tpH!.tpRules?.shipBoards).toBe(true);
    expect(tpH!.tpToll).toEqual(NPC_LINK_TOLL);

    // A pilot with credits boards the hub's pad; the capacitor is full.
    tpH!.tpCharge = 1_000_000;
    const client = await harness.connectActive(PILOT, hubEnd.sector, {
      shipKind: 'fighter', spawnX: tpH!.x, spawnY: tpH!.y + 100, initialWallet: 1000,
    });
    const tolls: Array<{ padId: number }> = [];
    client.onMessage('teleport_toll', (m: { padId: number }) => {
      tolls.push(m);
      client.send('teleport_toll_answer', { type: 'teleport_toll_answer', padId: m.padId, answer: 'pay' });
    });
    const transits: Array<{ targetSectorKey?: string }> = [];
    client.onMessage('transit_ready', (m: { targetSectorKey?: string }) => transits.push(m));

    let armed = false;
    for (let i = 0; i < 300 && transits.length === 0; i++) {
      roomH._internals.tickStructureTurrets();
      roomF._internals.tickStructureTurrets();
      if ((tpH!.tpPhase ?? 0) !== TP_PHASE.IDLE) armed = true;
      await harness.advance(40);
    }
    expect(armed, 'a boarded ship fired the hub teleporter').toBe(true);
    expect(tolls.length, 'the pilot was asked the toll').toBeGreaterThan(0);
    expect(transits[0]?.targetSectorKey).toBe(farEnd.sector);
  });
});
