/**
 * Living World P2 — the trade MESSAGE path through a real SectorRoom (the
 * client's route): `place_structure` → `accept_offer { networkEntityId }` →
 * room resolves the owned storage uid → TradeDirector → `trade_notice`.
 *
 * Reproduces the E2E "No storage of yours here." refusal at the level it lives
 * (room ↔ director seam), so a regression fails here in seconds, not in a
 * multi-minute browser run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bootSectorTestServer, type SectorTestHarness } from './harness.js';
import { getHoldStore, getPersistence } from '../../../src/server/db/PersistenceWorker.js';
import { EconomyStore } from '../../../src/server/economy/EconomyStore.js';
import { TradeDirector, type TradeRoom } from '../../../src/server/economy/TradeDirector.js';
import { setTradeSink } from '../../../src/server/economy/tradeSink.js';
import type { SectorRoom } from '../../../src/server/rooms/SectorRoom.js';
import type { TradeNotice } from '../../../src/shared-types/economy.js';

describe('SectorRoom integration — trade messages (P2)', () => {
  let h: SectorTestHarness | undefined;
  let dir: TradeDirector | undefined;
  afterEach(async () => {
    setTradeSink(null);
    dir?.stop();
    if (h) await h.cleanup();
  }, 10_000);

  it('accept_offer from a signed-in owner of a placed Capital is accepted and sends a hauler', { timeout: 30_000 }, async () => {
    // The director exists BEFORE the room (as in production), so the testMode
    // `tradeEnabled` room registers itself at onCreate.
    dir = new TradeDirector(new Map<string, TradeRoom>(), new EconomyStore({ persistence: getPersistence }), getHoldStore(), {
      controlIntervalMs: 50,
    });
    dir.start();
    setTradeSink(dir);
    h = await bootSectorTestServer({
      sectorKey: 'trade-test', testMode: true, droneCount: 0, asteroidConfig: [],
      tradeEnabled: true, seedStorageHold: { goods: { salvage: 120 }, credits: 3000 },
    } as never);
    const pid = randomUUID();
    const cr = await h.connectActive(pid);
    const room = h.getServerRoom() as unknown as SectorRoom & { playerToUser: Map<string, string | null> };
    room.playerToUser.set(pid, 'user-1'); // trade requires an account

    const notices: TradeNotice[] = [];
    cr.onMessage('trade_notice', (n: TradeNotice) => notices.push(n));

    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: -450 });
    let capitalEntityId: number | undefined;
    const end = Date.now() + 5000;
    while (Date.now() < end && capitalEntityId === undefined) {
      for (const s of room._internals.structureRegistry.all()) {
        if (s.kind === 'capital' && s.owner === pid) capitalEntityId = room._internals.swarmRegistry.get(s.id)?.entityId;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(capitalEntityId, 'capital placed').toBeDefined();

    const offer = dir.offersFor(pid).find((o) => o.kind === 'sell' && o.good === 'salvage')!;
    cr.send('accept_offer', {
      type: 'accept_offer', offerId: offer.offerId, networkEntityId: capitalEntityId,
      qty: 10, recurrenceMin: null, visits: null, priceBandPct: 0,
    });
    const until = Date.now() + 5000;
    while (Date.now() < until && notices.length === 0) await new Promise((r) => setTimeout(r, 25));
    expect(notices[0]?.message).not.toContain('No storage');
    expect(notices[0]?.event).toBe('accepted');

    // The director sends a hauler into this very room.
    const hEnd = Date.now() + 5000;
    let hauler = false;
    while (Date.now() < hEnd && !hauler) {
      hauler = [...room._internals.swarmRegistry.all()].some((r) => r.id.startsWith('hauler-'));
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(hauler).toBe(true);

    // The "inbound" notice names the sector — never the testMode `#roomId`
    // key the director knows this room by (no raw ids in player-facing text).
    const iEnd = Date.now() + 3000;
    while (Date.now() < iEnd && !notices.some((n) => n.event === 'inbound')) await new Promise((r) => setTimeout(r, 25));
    const inbound = notices.find((n) => n.event === 'inbound');
    expect(inbound?.message).toContain('trade-test');
    expect(inbound?.message).not.toContain('#');
  });

  /**
   * E2E regression (trade-tab.spec "No storage of yours here."): the browser can
   * join a testMode trade room BEFORE boot has installed the TradeDirector, so
   * the room's onCreate saw no sink and never registered. The room must join
   * the director lazily, on its first trade request.
   */
  it('a room created BEFORE the director starts still trades (lazy registration)', { timeout: 30_000 }, async () => {
    setTradeSink(null);
    h = await bootSectorTestServer({
      sectorKey: 'trade-test', testMode: true, droneCount: 0, asteroidConfig: [],
      tradeEnabled: true, seedStorageHold: { goods: { salvage: 120 }, credits: 3000 },
    } as never);
    const pid = randomUUID();
    const cr = await h.connectActive(pid); // room exists now, with no director
    const room = h.getServerRoom() as unknown as SectorRoom & { playerToUser: Map<string, string | null> };
    room.playerToUser.set(pid, 'user-1');

    dir = new TradeDirector(new Map<string, TradeRoom>(), new EconomyStore({ persistence: getPersistence }), getHoldStore(), {
      controlIntervalMs: 50,
    });
    dir.start();
    setTradeSink(dir); // boot finishes AFTER the room was created

    const notices: TradeNotice[] = [];
    cr.onMessage('trade_notice', (n: TradeNotice) => notices.push(n));
    cr.send('place_structure', { type: 'place_structure', kind: 'capital', x: 0, y: -450 });
    let capitalEntityId: number | undefined;
    const end = Date.now() + 5000;
    while (Date.now() < end && capitalEntityId === undefined) {
      for (const s of room._internals.structureRegistry.all()) {
        if (s.kind === 'capital' && s.owner === pid) capitalEntityId = room._internals.swarmRegistry.get(s.id)?.entityId;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const offer = dir.offersFor(pid).find((o) => o.kind === 'sell' && o.good === 'salvage')!;
    cr.send('accept_offer', {
      type: 'accept_offer', offerId: offer.offerId, networkEntityId: capitalEntityId,
      qty: 10, recurrenceMin: null, visits: null, priceBandPct: 0,
    });
    const until = Date.now() + 5000;
    while (Date.now() < until && notices.length === 0) await new Promise((r) => setTimeout(r, 25));
    expect(notices[0]?.message).toBe('Deal agreed: a hauler is on its way.');
  });
});
