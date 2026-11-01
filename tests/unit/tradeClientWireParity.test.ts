/**
 * Client → server wire parity (#15) for the economy/blueprint/lab senders in
 * `src/client/net/tradeClient.ts`: the EXACT payload each real client sender
 * puts on the wire must pass the zod schema the server parses it with.
 *
 * Bug this locks (found 2026-11-01 while wiring the C1 cargo panel): the
 * client's `send()` always adds a `type` field, but the lab, blueprint-install
 * and bounty schemas were `.strict()` with no `type` — so every real
 * `lab_query` / `lab_start` / `lab_cancel` / `install_blueprint` /
 * `place_bounty` was dropped as malformed. The integration tests sent the
 * payload WITHOUT `type`, so they never saw it. This test crosses the actual
 * seam: the client's own send helper → the server's schema.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const sent: Array<{ type: string; payload: unknown }> = [];
vi.mock('../../src/client/net/clientSingleton', () => ({
  getGameClient: () => ({ getRoom: () => ({ send: (type: string, payload: unknown) => sent.push({ type, payload }) }) }),
}));

import * as client from '../../src/client/net/tradeClient';
import { AcceptOfferSchema, CancelDealSchema, SendGiftSchema } from '../../src/shared-types/economy';
import { InstallBlueprintSchema, UnpackHullSchema } from '../../src/shared-types/blueprints';
import { BpBuySchema, BpMarketQuerySchema, BpSellSchema } from '../../src/shared-types/blueprintMarket';
import { PlaceBountySchema } from '../../src/shared-types/contracts';
import { LabCancelSchema, LabQuerySchema, LabStartSchema } from '../../src/shared-types/messages/labMessages';

function lastAccepted(schema: ZodType, wireType: string): void {
  const m = sent[sent.length - 1]!;
  expect(m.type).toBe(wireType);
  const r = schema.safeParse(m.payload);
  expect(r.success, `${wireType}: ${JSON.stringify(m.payload)} → ${r.success ? '' : r.error.message}`).toBe(true);
}

describe('tradeClient senders match the server schemas', () => {
  afterEach(() => { sent.length = 0; });

  it('accept_offer / cancel_deal / send_gift', () => {
    client.sendAcceptOffer({ offerId: 'o1', networkEntityId: 3, qty: 5, recurrenceMin: null, visits: null, priceBandPct: 10 });
    lastAccepted(AcceptOfferSchema, 'accept_offer');
    client.sendCancelDeal('d1');
    lastAccepted(CancelDealSchema, 'cancel_deal');
    client.sendGift({ allegiance: 'traders', networkEntityId: 3, good: 'alloy', qty: 2, credits: 0 });
    lastAccepted(SendGiftSchema, 'send_gift');
  });

  it('install_blueprint', () => {
    client.sendInstallBlueprint(3, 'bp-cargo-expander');
    lastAccepted(InstallBlueprintSchema, 'install_blueprint');
  });

  it('bp_market_query / bp_buy / bp_sell (economy v2 W6)', () => {
    client.sendBpMarketQuery(3);
    lastAccepted(BpMarketQuerySchema, 'bp_market_query');
    client.sendBpBuy(3, 'bpo-1');
    lastAccepted(BpBuySchema, 'bp_buy');
    client.sendBpSell(3, 'bp-1');
    lastAccepted(BpSellSchema, 'bp_sell');
  });

  it('unpack_hull (economy v2 W5a)', () => {
    client.sendUnpackHull(3, 'gunship');
    lastAccepted(UnpackHullSchema, 'unpack_hull');
  });

  it('place_bounty', () => {
    client.sendPlaceBounty({ targetPlayerId: 'p2', amount: 500 });
    lastAccepted(PlaceBountySchema, 'place_bounty');
  });

  it('lab_query / lab_start / lab_cancel', () => {
    client.sendLabQuery(7);
    lastAccepted(LabQuerySchema, 'lab_query');
    client.sendLabStart(7, { kind: 'research', stat: 'material', uid: 'bp-1' });
    lastAccepted(LabStartSchema, 'lab_start');
    client.sendLabCancel(7);
    lastAccepted(LabCancelSchema, 'lab_cancel');
  });
});
