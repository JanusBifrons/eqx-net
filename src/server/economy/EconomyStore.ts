/**
 * EconomyStore — the in-memory authority for the economy (plan
 * peppy-jumping-pinwheel P2): per-player reputation + trade history, every
 * trade deal, and the galaxy market. Mirrors `HoldStore`: memory is primary,
 * every mutation is shadowed as an ABSOLUTE upsert on the CRITICAL lane.
 *
 * Deal writes that accompany a value move (escrow in/out) are handed to the
 * caller as ops (`dealOp`) so they ride the SAME atomic `GROUP` as the hold
 * changes (`HoldStore.commit(..., extraOps)`) — a deal can never claim a state
 * its escrow doesn't match.
 */
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import {
  ECON_ALLEGIANCES,
  HOURLY_TRADE_VALUE_CAP,
  tradeSectorKey,
  type EconAllegiance,
  type PlayerEconomyView,
  type TradeDealView,
  type TradeHistoryEntry,
} from '../../shared-types/economy.js';
import { GOOD_IDS } from '../../shared-types/goods.js';
import { createMarket, type MarketState } from '../../core/economy/market.js';
import { applyRep, neutralRep, type RepTable } from '../../core/economy/reputation.js';
import {
  PLAYER_POLICY_OFF,
  PlayerPolicyWireSchema,
  STANDING_MAX,
  clampStanding,
  defaultFactionPolicy,
  isNpcFactionId,
  npcFactions,
  policyFromWire,
  type FactionPolicy,
  type PlayerFactionsView,
  type PlayerPolicyWire,
} from '../../shared-types/factions.js';
import { isActiveDeal, type TradeDeal } from '../../core/economy/deals.js';

/** History entries kept per player (the Trade tab's History list). */
export const HISTORY_CAP = 40;
/** Window over which recent gifts weaken further gifts. */
export const GIFT_WINDOW_MS = 60 * 60 * 1000;

/** Bumped when stored standings change scale. 1 = −100..100 (factions F1);
 *  a row without it holds the old −1000..1000 values and is divided by 10. */
export const STANDING_SCALE_VERSION = 1;

export interface PlayerEconomy {
  /** Each NPC faction's view of this player (−100..100). */
  rep: RepTable;
  /** This player's view of other factions (−100..100, sparse). */
  views: Record<string, number>;
  standingScale: number;
  /** The player's own faction policy (F3); absent = all off. */
  policy?: PlayerPolicyWire;
  history: TradeHistoryEntry[];
  /** Value gifted to each side inside the current window (diminishing returns). */
  gifts: Record<EconAllegiance, { value: number; sinceMs: number }>;
  /** Goods value traded inside the current hour (volume cap). */
  volume: { value: number; sinceMs: number };
  /** Bumped on every change the Trade tab shows (#16 polling key). */
  econVersion: number;
}

export interface EconomyStoreDeps {
  persistence: () => IPersistenceSink;
  now?: () => number;
}

const MARKET_KEY = 'market';
/** economy_state key of the NPC-to-NPC standing web. */
const STANDINGS_KEY = 'standings';

export class EconomyStore {
  private readonly players = new Map<string, PlayerEconomy>();
  /** NPC faction → NPC faction → standing (sparse; missing = 0). */
  private readonly npcWeb = new Map<string, Map<string, number>>();
  /** Player → their resolved policy, built when it is set (hot-path reads). */
  private readonly policyCache = new Map<string, FactionPolicy>();
  private readonly deals = new Map<string, TradeDeal>();
  market: MarketState;
  private readonly now: () => number;

  constructor(private readonly deps: EconomyStoreDeps) {
    this.now = deps.now ?? Date.now;
    this.market = createMarket(this.now());
  }

  // ── Hydrate (boot; memory only, never re-persisted) ──────────────────────

  hydrate(rows: {
    players: ReadonlyArray<{ player_id: string; payload_json: string }>;
    deals: ReadonlyArray<{ payload_json: string }>;
    market: string | null;
    standings?: string | null;
  }): { players: number; deals: number } {
    if (rows.standings) {
      try {
        const web = JSON.parse(rows.standings) as Record<string, Record<string, number>>;
        for (const from of Object.keys(web)) {
          const row = new Map<string, number>();
          for (const to of Object.keys(web[from]!)) {
            const v = web[from]![to];
            if (typeof v === 'number' && Number.isFinite(v) && v !== 0) row.set(to, clampStanding(v));
          }
          if (row.size > 0) this.npcWeb.set(from, row);
        }
      } catch { /* corrupt row — start neutral */ }
    }
    let p = 0;
    let d = 0;
    for (const r of rows.players) {
      const pe = parsePlayer(r.payload_json);
      if (pe) {
        this.players.set(r.player_id, pe);
        if (pe.policy) this.cachePolicy(r.player_id, pe.policy);
        p++;
      }
    }
    for (const r of rows.deals) {
      try {
        const deal = JSON.parse(r.payload_json) as TradeDeal;
        if (typeof deal.dealId === 'string' && typeof deal.ownerId === 'string') { this.deals.set(deal.dealId, deal); d++; }
      } catch { /* corrupt row — skip, never fabricate */ }
    }
    if (rows.market) {
      try {
        const m = JSON.parse(rows.market) as MarketState;
        if (m && typeof m.updatedAtMs === 'number' && m.supply) {
          for (const g of GOOD_IDS) if (typeof m.supply[g] !== 'number') m.supply[g] = 0;
          this.market = m;
        }
      } catch { /* keep the fresh market */ }
    }
    return { players: p, deals: d };
  }

  // ── Players ──────────────────────────────────────────────────────────────

  player(playerId: string): PlayerEconomy {
    let pe = this.players.get(playerId);
    if (!pe) {
      pe = freshPlayer(this.now());
      this.players.set(playerId, pe);
    }
    return pe;
  }

  /** NPC faction `faction`'s view of a player. */
  rep(playerId: string, faction: string): number {
    return this.players.get(playerId)?.rep[faction] ?? 0;
  }

  /** Apply a reputation delta + persist. Returns the new standing. */
  addRep(playerId: string, faction: string, delta: number): number {
    const pe = this.player(playerId);
    const v = applyRep(pe.rep, faction, delta);
    this.touchPlayer(playerId);
    return v;
  }

  // ── The standing web (factions F1) ───────────────────────────────────────

  /**
   * Faction `from`'s view of faction `to`, −100..100 (0 when never set). A
   * player's faction id is their player id. Allocation-free.
   */
  standing(from: string, to: string): number {
    if (from === to) return STANDING_MAX;
    const fromNpc = isNpcFactionId(from);
    const toNpc = isNpcFactionId(to);
    if (fromNpc && !toNpc) return this.players.get(to)?.rep[from] ?? 0;
    if (!fromNpc) return this.players.get(from)?.views[to] ?? 0;
    return this.npcWeb.get(from)?.get(to) ?? 0;
  }

  /** Move `from`'s view of `to` by `delta` and persist. Returns the new value. */
  adjustStanding(from: string, to: string, delta: number): number {
    if (from === to) return STANDING_MAX;
    const fromNpc = isNpcFactionId(from);
    const toNpc = isNpcFactionId(to);
    if (fromNpc && !toNpc) return this.addRep(to, from, delta);
    if (!fromNpc) {
      const pe = this.player(from);
      const v = clampStanding((pe.views[to] ?? 0) + delta);
      if (v === 0) delete pe.views[to];
      else pe.views[to] = v;
      this.touchPlayer(from);
      return v;
    }
    let row = this.npcWeb.get(from);
    if (!row) { row = new Map(); this.npcWeb.set(from, row); }
    const v = clampStanding((row.get(to) ?? 0) + delta);
    if (v === 0) row.delete(to);
    else row.set(to, v);
    this.saveStandings();
    return v;
  }

  // ── Policies (F3) ───────────────────────────────────────────────────────

  /** A faction's policy: a player's own settings, else the catalogue default.
   *  Allocation-free (the player's policy is resolved when it is set). */
  policyOf(faction: string): FactionPolicy {
    return this.policyCache.get(faction) ?? defaultFactionPolicy(faction);
  }

  playerPolicy(playerId: string): PlayerPolicyWire {
    return this.players.get(playerId)?.policy ?? PLAYER_POLICY_OFF;
  }

  setPlayerPolicy(playerId: string, wire: PlayerPolicyWire): void {
    const pe = this.player(playerId);
    pe.policy = { hostileBelow: wire.hostileBelow, alliedAbove: wire.alliedAbove };
    this.cachePolicy(playerId, pe.policy);
    this.touchPlayer(playerId);
  }

  private cachePolicy(playerId: string, wire: PlayerPolicyWire): void {
    if (wire.hostileBelow === null && wire.alliedAbove === null) this.policyCache.delete(playerId);
    else this.policyCache.set(playerId, policyFromWire(wire));
  }

  /**
   * The Factions tab: every NPC faction the player has standing with (and the
   * fixed ones always), plus players either side has an opinion of. Sorted by
   * how strongly they feel. `nameOf` resolves a player id to a display name.
   */
  factionsView(playerId: string, nameOf: (playerId: string) => string): PlayerFactionsView {
    const pe = this.players.get(playerId);
    const rows: PlayerFactionsView['rows'] = [];
    for (const f of npcFactions()) {
      const theirView = pe?.rep[f.id] ?? 0;
      const yourView = pe?.views[f.id] ?? 0;
      if (f.kind === 'minor' && theirView === 0 && yourView === 0) continue;
      rows.push({ factionId: f.id, name: f.displayName, kind: f.kind, color: f.color, theirView, yourView });
    }
    const others = new Set<string>();
    if (pe) for (const id of Object.keys(pe.views)) if (!isNpcFactionId(id)) others.add(id);
    for (const [id, other] of this.players) if (id !== playerId && (other.views[playerId] ?? 0) !== 0) others.add(id);
    for (const id of others) {
      rows.push({
        factionId: id, name: nameOf(id), kind: 'player', color: 0x9aa0b4,
        theirView: this.players.get(id)?.views[playerId] ?? 0,
        yourView: pe?.views[id] ?? 0,
      });
    }
    rows.sort((a, b) => Math.abs(b.theirView) + Math.abs(b.yourView) - (Math.abs(a.theirView) + Math.abs(a.yourView)));
    return { rows, policy: this.playerPolicy(playerId) };
  }

  private saveStandings(): void {
    const web: Record<string, Record<string, number>> = {};
    for (const [from, row] of this.npcWeb) {
      if (row.size === 0) continue;
      const r: Record<string, number> = {};
      for (const [to, v] of row) r[to] = v;
      web[from] = r;
    }
    this.enqueue({ type: 'ECON_STATE_PUT', key: STANDINGS_KEY, payloadJson: JSON.stringify(web), ts: this.now() });
  }

  pushHistory(playerId: string, entry: TradeHistoryEntry): void {
    const pe = this.player(playerId);
    pe.history.unshift(entry);
    if (pe.history.length > HISTORY_CAP) pe.history.length = HISTORY_CAP;
    this.touchPlayer(playerId);
  }

  /** Value gifted to `a` in the current window (rolls the window). */
  recentGiftValue(playerId: string, a: EconAllegiance): number {
    const g = this.player(playerId).gifts[a];
    if (this.now() - g.sinceMs > GIFT_WINDOW_MS) { g.value = 0; g.sinceMs = this.now(); }
    return g.value;
  }

  recordGift(playerId: string, a: EconAllegiance, value: number): void {
    this.recentGiftValue(playerId, a);
    this.player(playerId).gifts[a].value += value;
    this.touchPlayer(playerId);
  }

  /** Remaining goods value the player may trade this hour. */
  volumeLeft(playerId: string): number {
    const v = this.player(playerId).volume;
    if (this.now() - v.sinceMs > 60 * 60 * 1000) { v.value = 0; v.sinceMs = this.now(); }
    return Math.max(0, HOURLY_TRADE_VALUE_CAP - v.value);
  }

  recordVolume(playerId: string, value: number): void {
    this.volumeLeft(playerId);
    this.player(playerId).volume.value += value;
    this.touchPlayer(playerId);
  }

  /** Bump the econVersion + persist the player row. */
  touchPlayer(playerId: string): void {
    const pe = this.player(playerId);
    pe.econVersion++;
    this.enqueue(this.playerOp(playerId));
  }

  playerOp(playerId: string): PersistOp {
    return {
      type: 'ECON_PLAYER_PUT',
      playerId,
      payloadJson: JSON.stringify(this.player(playerId)),
      ts: this.now(),
    };
  }

  // ── Deals ────────────────────────────────────────────────────────────────

  getDeal(dealId: string): TradeDeal | undefined {
    return this.deals.get(dealId);
  }

  allDeals(): IterableIterator<TradeDeal> {
    return this.deals.values();
  }

  dealsOf(ownerId: string): TradeDeal[] {
    const out: TradeDeal[] = [];
    for (const d of this.deals.values()) if (d.ownerId === ownerId) out.push(d);
    return out;
  }

  activeDealsForNetwork(networkUid: string): number {
    let n = 0;
    for (const d of this.deals.values()) if (d.networkUid === networkUid && isActiveDeal(d)) n++;
    return n;
  }

  /** Set a deal in memory and return its persist op (caller decides whether it
   *  rides an atomic hold group or goes alone via `saveDeal`). */
  dealOp(deal: TradeDeal): PersistOp {
    this.deals.set(deal.dealId, deal);
    this.player(deal.ownerId).econVersion++;
    return { type: 'TRADE_DEAL_PUT', dealId: deal.dealId, ownerId: deal.ownerId, payloadJson: JSON.stringify(deal), ts: this.now() };
  }

  saveDeal(deal: TradeDeal): void {
    this.enqueue(this.dealOp(deal));
  }

  // ── Market ───────────────────────────────────────────────────────────────

  saveMarket(): void {
    this.enqueue({ type: 'ECON_STATE_PUT', key: MARKET_KEY, payloadJson: JSON.stringify(this.market), ts: this.now() });
  }

  // ── Views ────────────────────────────────────────────────────────────────

  view(playerId: string): PlayerEconomyView {
    const pe = this.player(playerId);
    const deals: TradeDealView[] = [];
    for (const d of this.dealsOf(playerId)) deals.push(dealView(d));
    deals.sort((a, b) => (b.nextVisitAtMs ?? 0) - (a.nextVisitAtMs ?? 0));
    const rep = {} as PlayerEconomyView['rep'];
    for (const a of ECON_ALLEGIANCES) rep[a] = pe.rep[a] ?? 0;
    return { econVersion: pe.econVersion, rep, deals, history: pe.history.slice() };
  }

  private enqueue(op: PersistOp): void {
    this.deps.persistence().enqueueCritical(op);
  }
}

export function dealView(d: TradeDeal): TradeDealView {
  return {
    dealId: d.dealId,
    kind: d.kind,
    good: d.good,
    ...(d.product !== undefined ? { product: d.product } : {}),
    qty: d.qty,
    credits: d.credits,
    allegiance: d.allegiance,
    // The view carries the SECTOR key only (never a testMode `#roomId`).
    sectorKey: tradeSectorKey(d.sectorKey),
    networkUid: d.networkUid,
    unitPrice: d.unitPrice,
    priceBandPct: d.priceBandPct,
    recurrenceMin: d.recurrenceMin,
    visitsLeft: d.visitsLeft,
    state: d.state,
    nextVisitAtMs: d.nextVisitAtMs,
  };
}

function freshPlayer(now: number): PlayerEconomy {
  const gifts = {} as PlayerEconomy['gifts'];
  for (const a of ECON_ALLEGIANCES) gifts[a] = { value: 0, sinceMs: now };
  return {
    rep: neutralRep(),
    views: {},
    standingScale: STANDING_SCALE_VERSION,
    history: [],
    gifts,
    volume: { value: 0, sinceMs: now },
    econVersion: 0,
  };
}

/** Defensive parse — a corrupt row is skipped, values are clamped, never fabricated. */
function parsePlayer(json: string): PlayerEconomy | null {
  try {
    const raw = JSON.parse(json) as Partial<PlayerEconomy>;
    const pe = freshPlayer(Date.now());
    // Rows saved before factions F1 hold −1000..1000; rescale them once.
    const scale = raw.standingScale === STANDING_SCALE_VERSION ? 1 : 0.1;
    if (raw.rep) {
      for (const f of Object.keys(raw.rep)) {
        const v = raw.rep[f];
        if (typeof v === 'number' && Number.isFinite(v)) pe.rep[f] = clampStanding(v * scale);
      }
    }
    if (raw.views) {
      for (const f of Object.keys(raw.views)) {
        const v = raw.views[f];
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0) pe.views[f] = clampStanding(v);
      }
    }
    if (raw.policy) {
      const parsed = PlayerPolicyWireSchema.safeParse(raw.policy);
      if (parsed.success) pe.policy = parsed.data;
    }
    if (Array.isArray(raw.history)) pe.history = raw.history.slice(0, HISTORY_CAP);
    if (raw.gifts) for (const a of ECON_ALLEGIANCES) if (raw.gifts[a]) pe.gifts[a] = { ...raw.gifts[a] };
    if (raw.volume) pe.volume = { ...raw.volume };
    if (typeof raw.econVersion === 'number') pe.econVersion = raw.econVersion;
    return pe;
  } catch {
    return null;
  }
}

/** Boot hydrate from the read-only main-thread connection. A missing table
 *  (first boot before the worker's schema exec) reads as empty. Constructed and
 *  owned by `index.ts` (no module singleton — keeps this file free of the
 *  sqlite-importing persistence module, so it unit-tests in plain node). */
export function hydrateEconomyStore(
  store: EconomyStore,
  select: (sql: string) => unknown[],
): { players: number; deals: number } {
  const read = <T>(sql: string): T[] => {
    try { return select(sql) as T[]; } catch { return []; }
  };
  const marketRow = read<{ payload_json: string }>("SELECT payload_json FROM economy_state WHERE key = 'market'")[0];
  const standingsRow = read<{ payload_json: string }>("SELECT payload_json FROM economy_state WHERE key = 'standings'")[0];
  return store.hydrate({
    players: read<{ player_id: string; payload_json: string }>('SELECT player_id, payload_json FROM player_economy'),
    deals: read<{ payload_json: string }>('SELECT payload_json FROM trade_deals'),
    market: marketRow?.payload_json ?? null,
    standings: standingsRow?.payload_json ?? null,
  });
}
