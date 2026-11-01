/**
 * Economy contract — market, reputation, trade deals (plan peppy-jumping-pinwheel
 * P2). Shared by server + client (invariant #15): the Trade tab labels and the
 * server's quotes/gates read the same numbers. Pure data + zod; the logic lives
 * in `src/core/economy/`.
 *
 * Trade has NO stations: a player accepts a DEAL, a trader HAULER flies to the
 * player's base, both sides sit in escrow while it is docked, and value changes
 * hands only when it departs safely.
 */
import { z } from 'zod';
import { GOOD_IDS, type GoodId } from './goods.js';

// ── Market ──────────────────────────────────────────────────────────────────

/** Mid-market credits per unit at neutral supply. Balance knobs. */
export const BASE_PRICES: Readonly<Record<GoodId, number>> = Object.freeze({
  minerals: 2,
  salvage: 6,
  alloy: 25,
  core: 120,
});

/** Traders buy below mid and sell above it (the spread is an inflation sink). */
export const MARKET_SPREAD = 0.1;
/** Price never leaves [floor, ceil] × base, however hard a good is dumped. */
export const PRICE_FLOOR_MUL = 0.4;
export const PRICE_CEIL_MUL = 2.5;

// ── Reputation ──────────────────────────────────────────────────────────────

/** The AI sides a player has standing with (players have none with each other). */
export const ECON_ALLEGIANCES = ['drones', 'robots', 'traders'] as const;
export type EconAllegiance = (typeof ECON_ALLEGIANCES)[number];

export const REP_MIN = -1000;
export const REP_MAX = 1000;
/** Trader rep swings deal prices by up to ±15 %. */
export const REP_PRICE_SWING = 0.15;
/** Traders refuse new deals below this standing. */
export const TRADER_REFUSE_BELOW = -300;
/** Robots stop attacking a player on sight at or above this standing. */
export const ROBOT_TRUCE_AT = 500;

/** Reputation deltas (balance knobs — tune on-device). */
export const REP_DEAL_COMPLETED = 10;
export const REP_PARTIAL_FILL = -15;
export const REP_PIRACY_HIT = -200; // per run, per player who damaged the hauler
export const REP_SELF_RAID = -500; // the deal owner damaged their own hauler
export const REP_ATTACK_ROBOT = -100; // a player hit a robot (ends any truce)

/**
 * The internal key the trade system knows a room by → the sector key a player
 * may see. testMode rooms are registered as `<sectorKey>#<roomId>`; the room id
 * part must never reach player-facing text (client CLAUDE.md "no raw ids").
 */
export function tradeSectorKey(key: string): string {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
}

// ── Deals ───────────────────────────────────────────────────────────────────

export const DEAL_KINDS = ['sell', 'buy', 'gift'] as const;
export type DealKind = (typeof DEAL_KINDS)[number];

/** Recurring-deal cadences (minutes). */
export const RECURRENCE_MINUTES = [10, 30, 60] as const;
/** Max ACTIVE deals per base network (one-off + recurring). */
export const MAX_DEALS_PER_NETWORK = 3;
/** Max units a single offer can cover (keeps one deal from draining a market). */
export const MAX_OFFER_QTY = 500;
/** Per-player cap on goods VALUE traded per hour (wash-trading defence). */
export const HOURLY_TRADE_VALUE_CAP = 20_000;
/** Flat fee per hauler run, taken from the proceeds (inflation sink). */
export const HAULING_FEE = 5;

export const DEAL_STATES = ['scheduled', 'inbound', 'docked', 'departing', 'settled', 'failed', 'cancelled'] as const;
export type DealState = (typeof DEAL_STATES)[number];

/** One entry on the offers board. `kind` is from the PLAYER's side. */
export interface TradeOffer {
  offerId: string;
  kind: 'sell' | 'buy';
  good: GoodId;
  /** Credits per unit at the requesting player's reputation. */
  unitPrice: number;
  maxQty: number;
  expiresAtMs: number;
}

/** A deal as the client sees it (the Trade tab's "My deals"). */
export interface TradeDealView {
  dealId: string;
  kind: DealKind;
  good: GoodId | null;
  qty: number;
  credits: number;
  allegiance: EconAllegiance;
  sectorKey: string;
  networkUid: string;
  unitPrice: number;
  priceBandPct: number;
  recurrenceMin: number | null;
  visitsLeft: number | null;
  state: DealState;
  nextVisitAtMs: number | null;
}

export interface TradeHistoryEntry {
  atMs: number;
  dealId: string;
  outcome: 'settled' | 'partial' | 'skipped' | 'raided' | 'refused' | 'cancelled';
  kind: DealKind;
  good: GoodId | null;
  qty: number;
  credits: number;
  note: string;
}

/** `GET /player/economy` — the Trade tab's whole state (invariant #16: the
 *  client rebuilds everything from this; `trade_notice` events only accelerate). */
export interface PlayerEconomyView {
  econVersion: number;
  rep: Record<EconAllegiance, number>;
  deals: TradeDealView[];
  history: TradeHistoryEntry[];
}

// ── Client → server messages (strict zod, invariant #3) ─────────────────────

const id64 = z.string().min(1).max(64);

export const AcceptOfferSchema = z
  .object({
    type: z.literal('accept_offer'),
    offerId: id64,
    /** Swarm entityId of one of the player's storage structures (the base
     *  network the deal serves). The room resolves it to the structure's
     *  stable uid, so the client never needs the uid. */
    networkEntityId: z.number().int().nonnegative(),
    qty: z.number().int().min(1).max(MAX_OFFER_QTY),
    /** null ⇒ one-off; else repeat every N minutes. */
    recurrenceMin: z.union([z.null(), z.literal(10), z.literal(30), z.literal(60)]),
    /** Recurring only: number of visits (null ⇒ until cancelled). */
    visits: z.number().int().min(1).max(100).nullable(),
    /** Recurring only: skip a visit whose re-quote moved more than this % from the accepted price. */
    priceBandPct: z.number().int().min(0).max(50),
  })
  .strict();
export type AcceptOfferMessage = z.infer<typeof AcceptOfferSchema>;

export const CancelDealSchema = z.object({ type: z.literal('cancel_deal'), dealId: id64 }).strict();

export const SendGiftSchema = z
  .object({
    type: z.literal('send_gift'),
    allegiance: z.enum(ECON_ALLEGIANCES),
    networkEntityId: z.number().int().nonnegative(),
    good: z.enum(GOOD_IDS).nullable(),
    qty: z.number().int().min(0).max(MAX_OFFER_QTY),
    credits: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .refine((m) => (m.good !== null && m.qty > 0) || m.credits > 0, 'a gift must carry goods or credits');

// ── Client-side validation of what the server sends (invariant #3) ─────────

const repSchema = z.object({ drones: z.number(), robots: z.number(), traders: z.number() });
const goodOrNull = z.enum(GOOD_IDS).nullable();

export const TradeOfferSchema = z.object({
  offerId: z.string(),
  kind: z.enum(['sell', 'buy']),
  good: z.enum(GOOD_IDS),
  unitPrice: z.number(),
  maxQty: z.number().int(),
  expiresAtMs: z.number(),
});
export const TradeOffersResponseSchema = z.object({ offers: z.array(TradeOfferSchema) });

export const TradeDealViewSchema = z.object({
  dealId: z.string(),
  kind: z.enum(DEAL_KINDS),
  good: goodOrNull,
  qty: z.number(),
  credits: z.number(),
  allegiance: z.enum(ECON_ALLEGIANCES),
  sectorKey: z.string(),
  networkUid: z.string(),
  unitPrice: z.number(),
  priceBandPct: z.number(),
  recurrenceMin: z.number().nullable(),
  visitsLeft: z.number().nullable(),
  state: z.enum(DEAL_STATES),
  nextVisitAtMs: z.number().nullable(),
});

export const TradeHistoryEntrySchema = z.object({
  atMs: z.number(),
  dealId: z.string(),
  outcome: z.enum(['settled', 'partial', 'skipped', 'raided', 'refused', 'cancelled']),
  kind: z.enum(DEAL_KINDS),
  good: goodOrNull,
  qty: z.number(),
  credits: z.number(),
  note: z.string(),
});

export const PlayerEconomyViewSchema = z.object({
  econVersion: z.number(),
  rep: repSchema,
  deals: z.array(TradeDealViewSchema),
  history: z.array(TradeHistoryEntrySchema),
});

export const TRADE_NOTICE_EVENTS = [
  'accepted', 'rejected', 'inbound', 'docked', 'settled', 'partial', 'skipped', 'raided', 'cancelled', 'under_fire',
] as const;

export const TradeNoticeSchema = z.object({
  type: z.literal('trade_notice'),
  dealId: z.string(),
  event: z.enum(TRADE_NOTICE_EVENTS),
  message: z.string().max(300),
  econVersion: z.number(),
});

// ── Server → client discrete notice (accelerator only, #16) ────────────────

export interface TradeNotice {
  type: 'trade_notice';
  dealId: string;
  /** What just happened to the deal. */
  event:
    | 'accepted' | 'rejected' | 'inbound' | 'docked' | 'settled' | 'partial' | 'skipped' | 'raided' | 'cancelled'
    /** The player's hauler is taking fire (the escort prompt). Throttled. */
    | 'under_fire';
  message: string;
  econVersion: number;
}
