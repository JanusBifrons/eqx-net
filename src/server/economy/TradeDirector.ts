/**
 * TradeDirector — trade deals carried out by physical haulers (plan
 * peppy-jumping-pinwheel P2). Process-global, like the LivingWorldDirector; an
 * unref'd ~1 s control loop (discrete low-frequency logic, never the 60 Hz tick).
 *
 * A VISIT (one run of a deal):
 *   scheduled ──plan──▶ inbound: a `trader-hauler` spawns at the sector edge and
 *     flies to the base. (A BUY's goods ride in the hauler's hold from spawn.)
 *   inbound ──arrives──▶ docked: the player's side moves into ESCROW in one
 *     atomic group with the deal state — a SELL's goods into the hauler's hold,
 *     a BUY's or GIFT's credits/goods into an escrow hold.
 *   docked ──dockMs──▶ departing (spooling out) ──departMs──▶ SETTLED: value
 *     changes hands only now, in one atomic group (proceeds minted / goods
 *     released into the network / escrow destroyed), then the hauler leaves.
 *   Hauler killed at any point ⇒ RAIDED: the room spills the hauler's hold where
 *     it died (anything with a hold spills); the player's escrow is refunded —
 *     unless the deal owner damaged their own hauler (forfeit + rep hit).
 *
 * Every value move goes through `TradeRoom.tradeTransfer` (one `HoldStore`
 * group) with the deal's `TRADE_DEAL_PUT` riding the same group, so a crash can
 * never leave escrow and deal state disagreeing. `reconcile()` on boot unwinds
 * any run that was in flight (haulers are not persisted).
 */
import { randomUUID } from 'node:crypto';
import type { Bus } from '../../core/events/Bus.js';
import type { Hold, GoodId } from '../../shared-types/goods.js';
import { GOOD_IDS } from '../../shared-types/goods.js';
import {
  ECON_ALLEGIANCES,
  MAX_DEALS_PER_NETWORK,
  MAX_OFFER_QTY,
  REP_ATTACK_ROBOT,
  REP_DEAL_COMPLETED,
  REP_PARTIAL_FILL,
  REP_PIRACY_HIT,
  REP_SELF_RAID,
  tradeSectorKey,
  type EconAllegiance,
  type TradeNotice,
  type TradeOffer,
} from '../../shared-types/economy.js';
import { getSector } from '../../core/galaxy/galaxy.js';
import { cloneHold, emptyHold, isHoldEmpty } from '../../core/cargo/hold.js';
import { applyFill, driftMarket, quoteBuy, quotePacked, quoteSell } from '../../core/economy/market.js';
import { packedHullProducts, packedStructureProducts, parseProduct, productName } from '../../shared-types/blueprints.js';
import { hullBillValue, packBillValue } from '../../shared-types/recipes.js';
import { isPlayableShipKindId } from '../../shared-types/shipKinds.js';
import { isStructureKindId } from '../../shared-types/structureKinds.js';
import { giftRepGain, robotTruce, tradersRefuse, waveIntervalFactor } from '../../core/economy/reputation.js';
import {
  afterVisit,
  buyCost,
  planVisit,
  sellProceeds,
  visitValue,
  type TradeDeal,
  type TradeRun,
} from '../../core/economy/deals.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { BotCarry } from '../livingworld/botTypes.js';
import { sectorEdgePose, type Rng } from '../livingworld/population.js';
import { HAULER_ID_PREFIX } from '../livingworld/directorBotIds.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { guarded } from '../rooms/guardedLoop.js';
import type { HoldStore } from '../cargo/HoldStore.js';
import type { TradeNetworkSnapshot, TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import type { EconomyStore } from './EconomyStore.js';
import type { AcceptOfferMsg, SendGiftMsg, TradeSink, TradeVerdict } from './tradeSink.js';
import type { Wallet } from './Wallet.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

/** The room surface the trade director drives (SectorRoom implements it). */
export interface TradeRoom {
  eventBus(): Bus;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: { botId: string; kind: ShipKindId; x: number; y: number }): boolean;
  despawnLivingWorldBot(botId: string): BotCarry | null;
  getBotPose(botId: string): { x: number; y: number; angle: number } | null;
  setBotMoveTarget(botId: string, x: number, y: number): void;
  tradeSnapshot(ownerId: string, networkUid: string): TradeNetworkSnapshot | null;
  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null;
  tradeBaseUnderAttack(ownerId: string): boolean;
  /** Drop a hold as a loot pod at (x, y) (overflow / orphaned escrow). */
  tradeDropAt(hold: Hold, x: number, y: number): void;
  /** Send a trade notice to `playerId` if they are connected to this room. */
  tradeNotify(playerId: string, notice: TradeNotice): void;
}

export interface TradeDirectorOptions {
  controlIntervalMs: number;
  /** Docked (escrow) dwell before the hauler starts spooling out. */
  dockMs: number;
  /** Departure spool: settles when it completes. */
  departMs: number;
  /** An inbound hauler that hasn't docked by now aborts (visit skipped). */
  inboundTimeoutMs: number;
  /** Offers board rotation. */
  offerTtlMs: number;
  /** Market drift cadence. */
  marketDriftMs: number;
  /** A hauler counts as docked within this distance of its dock point. */
  dockRadius: number;
  /** Dock point distance from the network's anchor storage. */
  dockOffset: number;
  /** One robot-attack rep hit per player per this window. */
  robotHitThrottleMs: number;
  /** One "your hauler is under fire" notice per hauler per this window. */
  underFireThrottleMs: number;
}

export const DEFAULT_TRADE_OPTIONS: TradeDirectorOptions = {
  controlIntervalMs: 1000,
  dockMs: 20_000,
  departMs: 8_000,
  inboundTimeoutMs: 180_000,
  offerTtlMs: 10 * 60_000,
  marketDriftMs: 5 * 60_000,
  dockRadius: 260,
  dockOffset: 220,
  robotHitThrottleMs: 10_000,
  underFireThrottleMs: 8_000,
};

interface BoardOffer {
  offerId: string;
  kind: 'sell' | 'buy';
  /** null on a packed-item offer. */
  good: GoodId | null;
  /** Economy v2 W4b — a packed structure on sale (`structure:<kind>`). */
  product?: string;
  maxQty: number;
  expiresAtMs: number;
}

const escrowUid = (runId: string): string => `escrow-${runId}`;

/** Economy v2 W4b — packed-structure offers kept on the board, and their size. */
export const PACKED_OFFERS_ON_BOARD = 4;
export const PACKED_OFFER_MAX_QTY = 3;
/** Economy v2 W5b — packed-HULL offers kept on the board. */
export const PACKED_HULL_OFFERS_ON_BOARD = 2;
/** Trader-made packed items are solid mid quality. */
export const TRADER_PACKED_QUALITY = 50;

/** Goods value of a packed product's pack recipe (0 ⇒ not sellable). */
function packedBillOf(product: string): number {
  const { ns, id } = parseProduct(product);
  if (ns === 'structure' && isStructureKindId(id)) return packBillValue(id);
  if (ns === 'hull' && isPlayableShipKindId(id)) return hullBillValue(id);
  return 0;
}

/** No wallet injected (tests that don't exercise credits): an empty balance
 *  that refuses every debit and ignores credits. */
const NO_WALLET: Pick<Wallet, 'balance' | 'credit' | 'creditDeferred' | 'debitDeferred' | 'flush'> = {
  balance: () => 0,
  credit: () => 0,
  creditDeferred: () => null,
  debitDeferred: () => null,
  flush: () => undefined,
};

export class TradeDirector implements TradeSink {
  private readonly opts: TradeDirectorOptions;
  private readonly rng: Rng;
  private readonly now: () => number;
  private offers: BoardOffer[] = [];
  private lastDriftAtMs: number;
  private readonly robotHitAt = new Map<string, number>();
  private readonly underFireAt = new Map<string, number>();
  private readonly push: ((ownerPlayerId: string, title: string, body: string, tag: string) => void) | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];

  /** Its OWN copy of the room map: `registerRoom` must never add a testMode
   *  room to the caller's map (in production that is the galaxy room map the
   *  squad directors iterate — a test room would leak into /galaxy/snapshot). */
  private readonly rooms: Map<string, TradeRoom>;

  constructor(
    rooms: ReadonlyMap<string, TradeRoom>,
    private readonly store: EconomyStore,
    private readonly holds: HoldStore,
    options: Partial<TradeDirectorOptions> & {
      rng?: Rng;
      nowMs?: () => number;
      /** Web Push for an OFFLINE owner (the notifier gates presence itself). */
      push?: (ownerPlayerId: string, title: string, body: string, tag: string) => void;
      /** Economy v2 W1 — the virtual wallet credits move through (buy price,
       *  gift credits, sell proceeds, refunds). */
      wallet?: Pick<Wallet, 'balance' | 'credit' | 'creditDeferred' | 'debitDeferred' | 'flush'>;
    } = {},
  ) {
    this.rooms = new Map(rooms);
    this.opts = { ...DEFAULT_TRADE_OPTIONS, ...options };
    this.rng = options.rng ?? Math.random;
    this.now = options.nowMs ?? Date.now;
    this.push = options.push ?? null;
    this.wallet = options.wallet ?? NO_WALLET;
    this.lastDriftAtMs = this.now();
  }

  private readonly wallet: Pick<Wallet, 'balance' | 'credit' | 'creditDeferred' | 'debitDeferred' | 'flush'>;

  /** Refund a run's wallet-held credits as an op for the caller's group
   *  (null when nothing was paid). */
  private refundOp(deal: TradeDeal, run: TradeRun, reason: string): PersistOp | null {
    return this.wallet.creditDeferred(deal.ownerId, run.paid ?? 0, reason);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.reconcile();
    this.rotateOffers();
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId.startsWith(HAULER_ID_PREFIX)) this.onHaulerDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
    const timer = setInterval(guarded('trade-tick', () => this.tick()), this.opts.controlIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
  }

  /**
   * Boot: haulers are not persisted, so any run that was in flight is unwound —
   * escrow back to the network (a SELL's goods ride in the hauler's hold, so
   * they go back too; a BUY's trader goods are discarded) — and the visit is
   * re-scheduled shortly. No value is created or lost.
   */
  reconcile(): void {
    for (const deal of [...this.store.allDeals()]) {
      const run = deal.run;
      if (run === null) continue;
      const room = this.rooms.get(deal.sectorKey);
      const release: string[] = [escrowUid(run.runId)];
      const destroy: string[] = [];
      if (deal.kind === 'sell') release.push(run.haulerId);
      else destroy.push(run.haulerId);
      const next: TradeDeal = { ...deal, run: null, state: 'scheduled', nextVisitAtMs: this.now() + 30_000 };
      const op = this.store.dealOp(next);
      // The wallet-held credits go back (in the same group when possible).
      const refund = this.refundOp(deal, run, 'trade_refund');
      const ops = refund ? [op, refund] : [op];
      const res = room?.tradeTransfer(deal.ownerId, deal.networkUid, { release, destroy, extraOps: ops }) ?? null;
      if (res === null) {
        if (refund) this.wallet.flush(deal.ownerId);
        // Base gone: keep the goods as pods at the old dock rather than lose them.
        for (const uid of release) this.dropHolder(room, uid, run.dockX, run.dockY);
        for (const uid of destroy) this.holds.delete(uid);
        this.store.saveDeal(next);
      } else if (!isHoldEmpty(res.overflow)) {
        room!.tradeDropAt(res.overflow, res.x, res.y);
      }
      serverLogEvent('trade_reconciled', { dealId: deal.dealId, phase: run.phase });
    }
  }

  // ── Offers board ─────────────────────────────────────────────────────────

  private rotateOffers(): void {
    const now = this.now();
    this.offers = this.offers.filter((o) => o.expiresAtMs > now && o.maxQty > 0);
    // Keep one SELL and one BUY offer per good on the board.
    for (const good of GOOD_IDS) {
      for (const kind of ['sell', 'buy'] as const) {
        if (this.offers.some((o) => o.product === undefined && o.good === good && o.kind === kind)) continue;
        const cap = good === 'core' ? 20 : good === 'alloy' ? 120 : MAX_OFFER_QTY;
        this.offers.push({
          offerId: `of-${randomUUID().slice(0, 10)}`,
          kind,
          good,
          maxQty: Math.max(5, Math.round(cap * (0.4 + this.rng() * 0.6))),
          expiresAtMs: now + this.opts.offerTtlMs * (0.7 + this.rng() * 0.6),
        });
      }
    }
    // Economy v2 W4b — traders also SELL packed structures (the user's ruling:
    // most players buy them rather than make them). A rotating handful.
    this.stockPacked('structure:', packedStructureProducts(), PACKED_OFFERS_ON_BOARD, now);
    // Economy v2 W5b — and packed HULLS (their own slots, so ~25 structure
    // kinds never crowd the 4 ships off the board).
    this.stockPacked('hull:', packedHullProducts(), PACKED_HULL_OFFERS_ON_BOARD, now);
  }

  /** Keep `slots` packed offers whose product starts with `prefix`. */
  private stockPacked(prefix: string, all: readonly string[], slots: number, now: number): void {
    const products = all.filter((p) => packedBillOf(p) > 0);
    let onBoard = this.offers.filter((o) => o.product?.startsWith(prefix) === true).length;
    for (let tries = 0; onBoard < slots && tries < 20 && products.length > 0; tries++) {
      const product = products[Math.floor(this.rng() * products.length)]!;
      if (this.offers.some((o) => o.product === product)) continue;
      this.offers.push({
        offerId: `of-${randomUUID().slice(0, 10)}`,
        kind: 'buy',
        good: null,
        product,
        maxQty: 1 + Math.floor(this.rng() * PACKED_OFFER_MAX_QTY),
        expiresAtMs: now + this.opts.offerTtlMs * (0.7 + this.rng() * 0.6),
      });
      onBoard++;
    }
  }

  /** The price of one unit of `offer` at `traderRep`. */
  private offerPrice(offer: { kind: 'sell' | 'buy'; good: GoodId | null; product?: string }, traderRep: number): number {
    if (offer.product !== undefined) return quotePacked(packedBillOf(offer.product), traderRep);
    return this.quote(offer.kind, offer.good!, traderRep);
  }

  /** The board as `playerId` sees it (prices at their trader reputation). */
  offersFor(playerId: string): TradeOffer[] {
    const rep = this.store.rep(playerId, 'traders');
    return this.offers.map((o) => ({
      offerId: o.offerId,
      kind: o.kind,
      good: o.good,
      ...(o.product !== undefined ? { product: o.product } : {}),
      unitPrice: this.offerPrice(o, rep),
      maxQty: o.maxQty,
      expiresAtMs: o.expiresAtMs,
    }));
  }

  private quote(kind: 'sell' | 'buy', good: GoodId, traderRep: number): number {
    return kind === 'sell' ? quoteSell(this.store.market, good, traderRep) : quoteBuy(this.store.market, good, traderRep);
  }

  // ── Requests (TradeSink) ─────────────────────────────────────────────────

  acceptOffer(playerId: string, sectorKey: string, networkUid: string, msg: AcceptOfferMsg): TradeVerdict {
    const offer = this.offers.find((o) => o.offerId === msg.offerId);
    if (!offer || offer.expiresAtMs <= this.now()) return reject('That offer has expired.');
    if (msg.qty > offer.maxQty) return reject(`That offer only covers ${offer.maxQty}.`);
    const traderRep = this.store.rep(playerId, 'traders');
    if (tradersRefuse(traderRep)) return reject('Traders refuse to deal with you.');
    const room = this.rooms.get(sectorKey);
    if (!room || room.tradeSnapshot(playerId, networkUid) === null) return reject('No storage of yours here.');
    if (this.store.activeDealsForNetwork(networkUid) >= MAX_DEALS_PER_NETWORK) {
      return reject(`A base can run at most ${MAX_DEALS_PER_NETWORK} deals.`);
    }
    if (offer.product !== undefined && msg.recurrenceMin !== null) return reject('Packed structures are one-off deals.');
    const unitPrice = this.offerPrice(offer, traderRep);
    if (msg.qty * unitPrice > this.store.volumeLeft(playerId)) return reject('Hourly trade limit reached.');
    const recurring = msg.recurrenceMin !== null;
    const deal: TradeDeal = {
      dealId: `deal-${randomUUID().slice(0, 12)}`,
      ownerId: playerId,
      kind: offer.kind,
      allegiance: 'traders',
      good: offer.good,
      ...(offer.product !== undefined ? { product: offer.product } : {}),
      qty: msg.qty,
      credits: 0,
      sectorKey,
      networkUid,
      unitPrice,
      priceBandPct: recurring ? msg.priceBandPct : 0,
      recurrenceMin: msg.recurrenceMin,
      visitsLeft: recurring ? msg.visits : 1,
      state: 'scheduled',
      nextVisitAtMs: this.now(),
      createdAtMs: this.now(),
      attempts: 0,
      run: null,
    };
    if (!recurring) offer.maxQty -= msg.qty;
    this.store.saveDeal(deal);
    serverLogEvent('trade_deal_accepted', { dealId: deal.dealId, playerId, kind: deal.kind, good: deal.good, qty: deal.qty });
    return { ok: true, dealId: deal.dealId, message: `Deal agreed: a hauler is on its way.` };
  }

  cancelDeal(playerId: string, dealId: string): TradeVerdict {
    const deal = this.store.getDeal(dealId);
    if (!deal || deal.ownerId !== playerId) return reject('No such deal.');
    if (deal.state === 'scheduled') {
      this.store.saveDeal({ ...deal, state: 'cancelled', nextVisitAtMs: null });
      this.history(deal, 'cancelled', 0, 0, 'Cancelled');
      return { ok: true, dealId, message: 'Deal cancelled.' };
    }
    if (deal.run !== null) {
      // Mid-visit: let this visit finish, then stop.
      this.store.saveDeal({ ...deal, recurrenceMin: null, visitsLeft: 1 });
      return { ok: true, dealId, message: 'Deal will end after the current visit.' };
    }
    return reject('That deal has already ended.');
  }

  sendGift(playerId: string, sectorKey: string, networkUid: string, msg: SendGiftMsg): TradeVerdict {
    const room = this.rooms.get(sectorKey);
    if (!room || room.tradeSnapshot(playerId, networkUid) === null) return reject('No storage of yours here.');
    if (this.store.activeDealsForNetwork(networkUid) >= MAX_DEALS_PER_NETWORK) {
      return reject(`A base can run at most ${MAX_DEALS_PER_NETWORK} deals.`);
    }
    const deal: TradeDeal = {
      dealId: `deal-${randomUUID().slice(0, 12)}`,
      ownerId: playerId,
      kind: 'gift',
      allegiance: msg.allegiance,
      good: msg.good,
      qty: msg.good !== null ? msg.qty : 0,
      credits: msg.credits,
      sectorKey,
      networkUid,
      unitPrice: 0,
      priceBandPct: 0,
      recurrenceMin: null,
      visitsLeft: 1,
      state: 'scheduled',
      nextVisitAtMs: this.now(),
      createdAtMs: this.now(),
      attempts: 0,
      run: null,
    };
    this.store.saveDeal(deal);
    return { ok: true, dealId: deal.dealId, message: 'Gift arranged: a hauler will collect it.' };
  }

  onHaulerDamaged(haulerId: string, attackerPlayerId: string | null): void {
    for (const deal of this.store.allDeals()) {
      const run = deal.run;
      if (run === null || run.haulerId !== haulerId) continue;
      if (attackerPlayerId !== null && !run.attackers.includes(attackerPlayerId)) {
        // Memory only — the attacker list is consulted when the run ends, and a
        // restart unwinds the run anyway.
        run.attackers.push(attackerPlayerId);
      }
      // Escort prompt — tell the owner their hauler is taking fire (throttled).
      if (attackerPlayerId !== deal.ownerId) {
        const now = this.now();
        if (now - (this.underFireAt.get(haulerId) ?? -Infinity) >= this.opts.underFireThrottleMs) {
          this.underFireAt.set(haulerId, now);
          this.notify(deal, 'under_fire', `Your trade hauler in ${sectorLabel(deal.sectorKey)} is under fire!`);
        }
      }
      return;
    }
  }

  /**
   * Add a room after boot (testMode rooms that opt into trade — showcase/E2E).
   * Galaxy rooms are passed to the constructor.
   */
  registerRoom(sectorKey: string, room: TradeRoom): void {
    if (this.rooms.has(sectorKey)) return;
    this.rooms.set(sectorKey, room);
    if (this.timer === null) return;
    const bus = room.eventBus();
    const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
      if (e.entityId.startsWith(HAULER_ID_PREFIX)) this.onHaulerDestroyed(e.entityId);
    };
    bus.on('ENTITY_DESTROYED', fn);
    this.subs.push({ bus, fn });
  }

  unregisterRoom(sectorKey: string, room: TradeRoom): void {
    if (this.rooms.get(sectorKey) !== room) return;
    this.rooms.delete(sectorKey);
    const bus = room.eventBus();
    for (let i = this.subs.length - 1; i >= 0; i--) {
      if (this.subs[i]!.bus === bus) {
        bus.off('ENTITY_DESTROYED', this.subs[i]!.fn);
        this.subs.splice(i, 1);
      }
    }
  }

  onRobotDamaged(attackerPlayerId: string): void {
    const now = this.now();
    const last = this.robotHitAt.get(attackerPlayerId) ?? -Infinity;
    if (now - last < this.opts.robotHitThrottleMs) return;
    this.robotHitAt.set(attackerPlayerId, now);
    this.store.addRep(attackerPlayerId, 'robots', REP_ATTACK_ROBOT);
  }

  traderRep(playerId: string): number {
    return this.store.rep(playerId, 'traders');
  }

  robotTruce(playerId: string): boolean {
    return robotTruce(this.store.rep(playerId, 'robots'));
  }

  waveIntervalFactor(playerId: string): number {
    return waveIntervalFactor(this.store.rep(playerId, 'drones'));
  }

  // ── Control loop ─────────────────────────────────────────────────────────

  /** One control step (public for deterministic tests). */
  tick(): void {
    const now = this.now();
    if (now - this.lastDriftAtMs >= this.opts.marketDriftMs) {
      driftMarket(this.store.market, now, this.rng);
      this.store.saveMarket();
      this.lastDriftAtMs = now;
    }
    this.rotateOffers();
    for (const deal of [...this.store.allDeals()]) {
      if (deal.state === 'scheduled' && deal.nextVisitAtMs !== null && deal.nextVisitAtMs <= now) {
        this.startVisit(deal);
      } else if (deal.run !== null) {
        this.advanceRun(deal, deal.run, now);
      }
    }
  }

  private startVisit(deal: TradeDeal): void {
    const room = this.rooms.get(deal.sectorKey);
    const snap = room?.tradeSnapshot(deal.ownerId, deal.networkUid) ?? null;
    const traderRep = this.store.rep(deal.ownerId, 'traders');
    const quoteNow = deal.kind === 'gift' ? 0
      : deal.product !== undefined ? quotePacked(packedBillOf(deal.product), traderRep)
      : !deal.good ? 0 : this.quote(deal.kind, deal.good, traderRep);
    const plan = planVisit(
      deal,
      {
        exists: snap !== null,
        underAttack: snap !== null && room!.tradeBaseUnderAttack(deal.ownerId),
        goods: snap?.goods ?? {},
        credits: this.wallet.balance(deal.ownerId),
        freeCapacity: snap?.freeCapacity ?? 0,
      },
      quoteNow,
      traderRep,
    );
    if (!plan.go) {
      this.skipVisit(deal, plan.reason === 'refused' ? 'Traders refused the visit' : `Visit skipped: ${plan.reason.replace(/-/g, ' ')}`);
      return;
    }
    if (deal.kind !== 'gift' && visitValue(deal, plan.qty, 0, plan.unitPrice) > this.store.volumeLeft(deal.ownerId)) {
      this.skipVisit(deal, 'Visit skipped: hourly trade limit');
      return;
    }
    if (!room!.hasFreeSlot()) {
      this.skipVisit(deal, 'Visit skipped: sector traffic is full');
      return;
    }
    const runId = randomUUID().slice(0, 12);
    const haulerId = `${HAULER_ID_PREFIX}${runId}`;
    const edge = sectorEdgePose(this.rng);
    if (!room!.spawnLivingWorldBot({ botId: haulerId, kind: 'trader-hauler', x: edge.x, y: edge.y })) {
      this.skipVisit(deal, 'Visit skipped: the hauler could not enter the sector');
      return;
    }
    // Dock beside the storage, on the side the hauler arrives from.
    const ax = edge.x - snap!.x;
    const ay = edge.y - snap!.y;
    const len = Math.max(1, Math.hypot(ax, ay));
    const run: TradeRun = {
      runId,
      haulerId,
      phase: 'inbound',
      qty: plan.qty,
      credits: plan.credits,
      unitPrice: plan.unitPrice,
      partial: plan.partial,
      phaseStartedAtMs: this.now(),
      attackers: [],
      dockX: snap!.x + (ax / len) * this.opts.dockOffset,
      dockY: snap!.y + (ay / len) * this.opts.dockOffset,
    };
    const next: TradeDeal = { ...deal, state: 'inbound', run };
    const op = this.store.dealOp(next);
    if (deal.kind === 'buy' && (deal.good || deal.product !== undefined)) {
      // The trader's goods (or packed items) ride in the hauler's hold from
      // spawn, so raiding the hauler spills them.
      const hold = emptyHold();
      if (deal.good) hold.goods[deal.good] = plan.qty;
      else for (let i = 0; i < plan.qty; i++) (hold.packed ??= []).push({ product: deal.product!, quality: TRADER_PACKED_QUALITY });
      this.holds.commit(
        [{ holderUid: haulerId, holderType: 'hauler', ownerId: null, sectorKey: deal.sectorKey, x: null, y: null, hold, expiresAt: null }],
        [],
        true,
        [op],
      );
    } else {
      this.store.saveDeal(next);
    }
    room!.setBotMoveTarget(haulerId, run.dockX, run.dockY);
    this.notify(next, 'inbound', `A trade hauler is inbound to your base in ${sectorLabel(deal.sectorKey)}.`);
    serverLogEvent('trade_run_start', { dealId: deal.dealId, haulerId, sectorKey: deal.sectorKey });
  }

  private advanceRun(deal: TradeDeal, run: TradeRun, now: number): void {
    const room = this.rooms.get(deal.sectorKey);
    if (!room) return;
    const elapsed = now - run.phaseStartedAtMs;
    if (run.phase === 'inbound') {
      const pose = room.getBotPose(run.haulerId);
      if (pose === null) return; // destroyed — the bus handler settles it
      if (Math.hypot(pose.x - run.dockX, pose.y - run.dockY) <= this.opts.dockRadius) {
        this.dock(deal, run, room);
      } else if (elapsed >= this.opts.inboundTimeoutMs) {
        this.abortRun(deal, run, room, 'Visit aborted: the hauler never reached the base');
      } else {
        room.setBotMoveTarget(run.haulerId, run.dockX, run.dockY);
      }
    } else if (run.phase === 'docked') {
      room.setBotMoveTarget(run.haulerId, run.dockX, run.dockY);
      if (elapsed >= this.opts.dockMs) {
        this.store.saveDeal({ ...deal, state: 'departing', run: { ...run, phase: 'departing', phaseStartedAtMs: now } });
      }
    } else if (elapsed >= this.opts.departMs) {
      this.settle(deal, run, room);
    }
  }

  /** Docked: the player's side of the trade moves into escrow. */
  private dock(deal: TradeDeal, run: TradeRun, room: TradeRoom): void {
    if (room.tradeSnapshot(deal.ownerId, deal.networkUid) === null) {
      this.abortRun(deal, run, room, 'Visit aborted: your storage is gone');
      return;
    }
    const want = emptyHold();
    let into = escrowUid(run.runId);
    if (deal.kind === 'sell' && deal.good) {
      want.goods[deal.good] = run.qty;
      into = run.haulerId; // the goods physically ride in the hauler
    } else if (deal.kind === 'gift' && deal.good && run.qty > 0) {
      want.goods[deal.good] = run.qty;
    }
    // Economy v2 W1 — the credit side comes from the WALLET (held virtually on
    // the run until settlement; refunded if the visit unwinds).
    const due = deal.kind === 'buy' ? buyCost(run.qty, run.unitPrice) : deal.kind === 'gift' ? run.credits : 0;
    let walletOp: PersistOp | null = null;
    if (due > 0) {
      walletOp = this.wallet.debitDeferred(deal.ownerId, due, deal.kind === 'buy' ? 'trade_buy' : 'trade_gift');
      if (walletOp === null && deal.kind === 'buy') { this.abortRun(deal, run, room, 'Visit aborted: not enough credits'); return; }
    }
    const paid = walletOp !== null ? due : 0;
    const docked: TradeRun = { ...run, phase: 'docked', phaseStartedAtMs: this.now(), paid, credits: deal.kind === 'gift' ? paid : run.credits };
    const next: TradeDeal = { ...deal, state: 'docked', run: docked };
    const ops = walletOp ? [this.store.dealOp(next), walletOp] : [this.store.dealOp(next)];
    const res = room.tradeTransfer(deal.ownerId, deal.networkUid, { take: { want, intoUid: into }, extraOps: ops });
    if (res === null) {
      // Unreachable after the snapshot check; keep the wallet whole regardless.
      if (paid > 0) this.wallet.credit(deal.ownerId, paid, 'trade_refund');
      this.abortRun(deal, run, room, 'Visit aborted: your storage is gone');
      return;
    }
    // The base may hold less than at planning time — adjust to what moved.
    if (deal.kind === 'sell' && deal.good) {
      const got = res.taken.goods[deal.good] ?? 0;
      if (got <= 0) { this.abortRun(next, docked, room, 'Visit aborted: nothing left to sell'); return; }
      if (got < run.qty) this.store.saveDeal({ ...next, run: { ...docked, qty: got, partial: true } });
    } else if (deal.kind === 'gift') {
      const got = deal.good ? res.taken.goods[deal.good] ?? 0 : 0;
      if (got <= 0 && paid <= 0) { this.abortRun(next, docked, room, 'Visit aborted: nothing left to give'); return; }
      this.store.saveDeal({ ...next, run: { ...docked, qty: got, partial: got < run.qty || paid < run.credits } });
    }
    this.notify(next, 'docked', 'The trade hauler has docked. Keep it safe until it leaves.');
  }

  /** Safe departure: value changes hands now, atomically. */
  private settle(deal: TradeDeal, run: TradeRun, room: TradeRoom): void {
    const outcome = afterVisit(deal, 'completed', this.now());
    const next: TradeDeal = { ...deal, ...outcome, run: null };
    const op = this.store.dealOp(next);
    const escrow = escrowUid(run.runId);
    let res: TradeTransferResult | null;
    let credits = 0;
    const alive = room.tradeSnapshot(deal.ownerId, deal.networkUid) !== null;
    if (deal.kind === 'sell') {
      credits = sellProceeds(run.qty, run.unitPrice);
      // The proceeds go to the WALLET, in the same group as the goods leaving.
      const pay = alive ? this.wallet.creditDeferred(deal.ownerId, credits, 'trade_sell') : null;
      res = alive
        ? room.tradeTransfer(deal.ownerId, deal.networkUid, { destroy: [run.haulerId], extraOps: pay ? [op, pay] : [op] })
        : null;
      if (res !== null && deal.good) applyFill(this.store.market, deal.good, run.qty, 'sell');
    } else if (deal.kind === 'buy') {
      credits = buyCost(run.qty, run.unitPrice);
      res = room.tradeTransfer(deal.ownerId, deal.networkUid, { release: [run.haulerId], destroy: [escrow], extraOps: [op] });
      if (res !== null && deal.good) applyFill(this.store.market, deal.good, run.qty, 'buy');
    } else {
      credits = run.credits;
      res = room.tradeTransfer(deal.ownerId, deal.networkUid, { destroy: [escrow], extraOps: [op] });
    }
    if (res === null) {
      // Base razed while docked: nothing is owed — the wallet-held credits go
      // back, and the escrow goods + the hauler's cargo stay as pods at the dock.
      if ((run.paid ?? 0) > 0) this.wallet.credit(deal.ownerId, run.paid ?? 0, 'trade_refund');
      this.dropHolder(room, escrow, run.dockX, run.dockY);
      this.dropHolder(room, run.haulerId, run.dockX, run.dockY);
      this.store.saveDeal(next);
    } else if (!isHoldEmpty(res.overflow)) {
      room.tradeDropAt(res.overflow, res.x, res.y);
    }
    room.despawnLivingWorldBot(run.haulerId);

    if (deal.kind === 'gift') {
      const value = visitValue(deal, run.qty, run.credits, deal.good ? quoteSell(this.store.market, deal.good, 0) : 0);
      const gain = giftRepGain(value, this.store.recentGiftValue(deal.ownerId, deal.allegiance));
      this.store.recordGift(deal.ownerId, deal.allegiance, value);
      this.store.addRep(deal.ownerId, deal.allegiance, gain);
      this.history(deal, 'settled', run.qty, run.credits, `Gift delivered to the ${deal.allegiance} (+${gain} standing)`);
      this.notify(next, 'settled', `Your gift reached the ${deal.allegiance}: +${gain} standing.`);
    } else {
      this.store.recordVolume(deal.ownerId, Math.floor(run.qty * run.unitPrice));
      this.store.addRep(deal.ownerId, 'traders', run.partial ? REP_PARTIAL_FILL : REP_DEAL_COMPLETED);
      const verb = deal.kind === 'sell' ? 'Sold' : 'Bought';
      const what = deal.product !== undefined ? `Packed ${productName(deal.product)}` : `${deal.good}`;
      const note = `${verb} ${run.qty} ${what} for ${credits} cr${run.partial ? ' (partial)' : ''}`;
      this.history(deal, run.partial ? 'partial' : 'settled', run.qty, credits, note);
      this.notify(next, run.partial ? 'partial' : 'settled', note);
    }
    this.store.saveMarket();
    serverLogEvent('trade_settled', { dealId: deal.dealId, kind: deal.kind, qty: run.qty, credits });
  }

  /** The hauler was destroyed. The room already spilled its hold. */
  private onHaulerDestroyed(haulerId: string): void {
    let deal: TradeDeal | undefined;
    for (const d of this.store.allDeals()) if (d.run?.haulerId === haulerId) { deal = d; break; }
    if (!deal || !deal.run) return;
    const run = deal.run;
    const room = this.rooms.get(deal.sectorKey);
    const forfeit = run.attackers.includes(deal.ownerId);
    const next: TradeDeal = { ...deal, ...afterVisit(deal, 'raided', this.now()), run: null };
    const op = this.store.dealOp(next);
    const escrow = escrowUid(run.runId);
    // A forfeit keeps the wallet-held credits (the self-raid penalty);
    // otherwise they're refunded in the same group as the escrow goods.
    const refund = forfeit ? null : this.refundOp(deal, run, 'trade_refund');
    const ops = refund ? [op, refund] : [op];
    const spec: TradeTransferSpec = forfeit
      ? { destroy: [escrow], extraOps: ops }
      : { release: [escrow], extraOps: ops };
    const res = room?.tradeTransfer(deal.ownerId, deal.networkUid, spec) ?? null;
    if (res === null) {
      if (refund) this.wallet.flush(deal.ownerId);
      this.dropHolder(room, escrow, run.dockX, run.dockY);
      this.store.saveDeal(next);
    } else if (!isHoldEmpty(res.overflow)) {
      room!.tradeDropAt(res.overflow, res.x, res.y);
    }
    for (const a of run.attackers) {
      this.store.addRep(a, 'traders', a === deal.ownerId ? REP_SELF_RAID : REP_PIRACY_HIT);
    }
    const why = forfeit
      ? 'You attacked your own hauler: escrow forfeited.'
      : run.phase === 'inbound'
        ? 'Your trade hauler was destroyed on the way in.'
        : 'Your trade hauler was destroyed while docked. Escrow refunded.';
    this.history(deal, 'raided', run.qty, 0, why);
    this.notify(next, 'raided', why);
    serverLogEvent('trade_raided', { dealId: deal.dealId, haulerId, phase: run.phase, forfeit, attackers: run.attackers.length });
  }

  private abortRun(deal: TradeDeal, run: TradeRun, room: TradeRoom, why: string): void {
    const next: TradeDeal = { ...deal, ...afterVisit(deal, 'skipped', this.now()), run: null };
    const op = this.store.dealOp(next);
    // Unwind: the player's escrow (and a sell's goods in the hauler) go back;
    // a buy's trader goods leave with the hauler.
    const release = [escrowUid(run.runId)];
    const destroy: string[] = [];
    if (deal.kind === 'sell') release.push(run.haulerId);
    else destroy.push(run.haulerId);
    const refund = this.refundOp(deal, run, 'trade_refund');
    const res = room.tradeTransfer(deal.ownerId, deal.networkUid, { release, destroy, extraOps: refund ? [op, refund] : [op] });
    if (res === null) {
      if (refund) this.wallet.flush(deal.ownerId);
      for (const uid of release) this.dropHolder(room, uid, run.dockX, run.dockY);
      for (const uid of destroy) this.holds.delete(uid);
      this.store.saveDeal(next);
    } else if (!isHoldEmpty(res.overflow)) {
      room.tradeDropAt(res.overflow, res.x, res.y);
    }
    room.despawnLivingWorldBot(run.haulerId);
    this.history(deal, 'skipped', 0, 0, why);
    this.notify(next, 'skipped', why);
  }

  private skipVisit(deal: TradeDeal, why: string): void {
    const next: TradeDeal = { ...deal, ...afterVisit(deal, 'skipped', this.now()), run: null };
    this.store.saveDeal(next);
    if (why.includes('refused')) this.history(deal, 'refused', 0, 0, why);
    else this.history(deal, 'skipped', 0, 0, why);
    this.notify(next, 'skipped', why);
  }

  /** Drop a holder's whole hold as a pod and delete the holder. */
  private dropHolder(room: TradeRoom | undefined, uid: string, x: number, y: number): void {
    const rec = this.holds.get(uid);
    if (rec === undefined) return;
    if (room && !isHoldEmpty(rec.hold)) room.tradeDropAt(cloneHold(rec.hold), x, y);
    this.holds.delete(uid);
  }

  private history(deal: TradeDeal, outcome: 'settled' | 'partial' | 'skipped' | 'raided' | 'refused' | 'cancelled', qty: number, credits: number, note: string): void {
    this.store.pushHistory(deal.ownerId, { atMs: this.now(), dealId: deal.dealId, outcome, kind: deal.kind, good: deal.good, qty, credits, note });
  }

  private notify(deal: TradeDeal, event: TradeNotice['event'], message: string): void {
    const notice: TradeNotice = {
      type: 'trade_notice',
      dealId: deal.dealId,
      event,
      message,
      econVersion: this.store.player(deal.ownerId).econVersion,
    };
    for (const room of this.rooms.values()) room.tradeNotify(deal.ownerId, notice);
    // Offline owner → Web Push for the outcomes worth waking a phone for.
    if (this.push && (event === 'settled' || event === 'partial' || event === 'raided' || event === 'under_fire')) {
      const title = event === 'raided' ? 'Trade hauler lost' : event === 'under_fire' ? 'Hauler under fire' : 'Trade complete';
      this.push(deal.ownerId, title, message, `trade:${deal.dealId}`);
    }
  }
}

/** A sector's player-facing name (galaxy name, else the bare key — never the
 *  testMode `#roomId` suffix). */
function sectorLabel(key: string): string {
  const k = tradeSectorKey(key);
  return getSector(k)?.name ?? k;
}

function reject(message: string): TradeVerdict {
  return { ok: false, dealId: null, message };
}

/** Exposed for tests: every allegiance a gift may target. */
export const GIFT_ALLEGIANCES: readonly EconAllegiance[] = ECON_ALLEGIANCES;
