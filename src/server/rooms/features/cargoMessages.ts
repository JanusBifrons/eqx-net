/**
 * Cargo client messages — open / move a structure's or ship's cargo (C1/C3),
 * an NPC Freight Dock's market (T4), break-ins (C2) and a Freight Dock's
 * standing orders (T4b). Moved verbatim out of `SectorRoom`, with the cargo
 * gate (`cargoAccess`), the dock market and the C3 ship cargo view / move
 * (`shipCargo`; holds move through cargoWindow's `moveBetweenHolds`) only
 * these handlers used; the room
 * hands in live accessors so every handler reads the same state it did there.
 */
import type { Client } from 'colyseus';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { BreakInSubsystem } from '../BreakInSubsystem.js';
import type { StorageService } from '../../cargo/StorageService.js';
import { isOperationalStorage } from '../../cargo/storageHolds.js';
import { getPlayerShipStore, getHoldStore, getWallet } from '../../db/PersistenceWorker.js';
import { paysRealCredits } from '../sealedSectors.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { emptyHold, holdWeight, isHoldEmpty } from '../../../core/cargo/hold.js';
import type { HolderType } from '../../cargo/HoldStore.js';
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../../shared-types/goods.js';
import type { GoodId } from '../../../shared-types/goods.js';
import { cargoOpensFor, isNpcOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import {
  BreakInCancelSchema, BreakInSchema, MAX_FREIGHT_ORDERS, SetFreightOrdersSchema, type CargoState,
} from '../../../shared-types/messages/cargoMessages.js';
import { CAPITAL_CRATE_PRODUCT, capitalCratePrice, packedSellRefusal } from '../../economy/capitalCrateTrade.js';
import { buyCapitalCrateAtDock, DOCK_CAPITAL_LISTING } from '../../economy/dockCapitalCrate.js';
import type { LootSubsystem, LootCollector } from '../../cargo/LootSubsystem.js';
import type { LootSearch } from '../../cargo/LootSearch.js';
import {
  applyAutoUnload, moveBetweenHolds, ownHoldState, parseCargoRequest, peekCargoState, podCargoState, sendCargoState, structureCargoState,
  type AutoUnloadDeps, type CargoMove, type CargoRef, type StructureCargoDeps,
} from '../../cargo/cargoWindow.js';

/** C3 — a ship cargo target (see `SectorRoom.shipTarget`). */
export interface CargoShipTarget {
  /** Break-in / grant key: the NPC swarm id, or the player hull's shipInstanceId. */
  id: string;
  holdUid: string;
  owner: string;
  x: number;
  y: number;
  radius: number;
  capacity: number;
  /** Player-facing kind name (never an id). */
  label: string;
  /** Does its hold persist? (player hulls, trade haulers; NPC loot holds don't) */
  persisted: boolean;
  npc?: SwarmEntityRecord;
}

/** What the handlers need from the room; getters read the live field. */
export interface CargoMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get'>;
  sectorKey(): string | null;
  relationCtx: RelationContext;
  rebuildStructuresSlice(): void;
  storage(): Pick<StorageService, 'cargoTake' | 'cargoPut' | 'cargoView' | 'networkStock' | 'marketBuy' | 'marketSell' | 'dockFreeWeight'>;
  breakIns: Pick<BreakInSubsystem, 'progress' | 'hasGrant' | 'start' | 'cancel'>;
  manualCargo: Pick<Set<string>, 'add'>;
  shipPoseCache: Pick<ReadonlyMap<string, ShipPhysicsState>, 'get'>;
  getActiveShip(playerId: string): ShipState | undefined;
  shipCargoCapacity(kind: string, shipInstanceId: string): number;
  /** C3 — an NPC ship's hold, its loot rolled once (`NpcLootHolds.hold`). */
  npcHold(rec: SwarmEntityRecord): Hold;
  shipTarget(ref: { entityId?: number; ship?: string }): CargoShipTarget | null;
  breakInMsFor(rec: StructureRecord): number;
  breakInMsForShip(t: CargoShipTarget): number;
  pilotNear(playerId: string, rec: StructureRecord): boolean;
  pilotNearPoint(playerId: string, x: number, y: number, radius: number): boolean;
  /** Game-clock now (the loot window's search time). */
  now(): number;
  /** Loot pods (plan cargo-pods): a pod opens in the loot window. */
  loot(): Pick<LootSubsystem, 'isPod' | 'inOpenReach' | 'take'>;
  lootSearch: LootSearch;
  pilotCollector(playerId: string): LootCollector | null;
  /** Cargo pods 14c — the auto-unload switch's ship end. */
  resolveActiveShipKey(playerId: string): string | undefined;
  /** The flown hull, else the hull parked by Command / Build (`PilotSwap.ownShipKey`). */
  ownShipKey(playerId: string): string | undefined;
}

export function registerCargoMessages(h: CargoMessageHost): RoomFeature {
  // ── C1 (plan soft-leaping-truffle v3) — open a structure's cargo ────────
  // The cargo pane is rebuilt from `cargo_state` replies only (#16).
  const structureCargo: StructureCargoDeps = {
    storage: h.storage, holds: getHoldStore, shipRecord: (id) => getPlayerShipStore().get(id), manualCargo: h.manualCargo,
    sectorKey: h.sectorKey, bankChanged: () => h.rebuildStructuresSlice(),
  };
  const cargoRequest = (client: Client, kind: 'cargo_query' | 'cargo_move', raw: unknown): void => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const req = parseCargoRequest(kind, raw);
    if (req === null) { h.malformed.record(client.sessionId, kind); return; }
    const { ref, move } = req;
    const send = (st: CargoState): void => sendCargoState(client, st);
    // C3 — a ship (an NPC ship by entityId, a player's ship / parked hull).
    if (ref.ship !== undefined || h.swarmRegistry.getByEntityId(ref.entityId!)?.kind === 1) {
      send(shipCargo(h, playerId, ref, move));
      return;
    }
    const entityId = ref.entityId!;
    // Plan cargo-pods — a loot pod opens in the loot window.
    const podId = h.swarmRegistry.getByEntityId(entityId)?.id;
    if (podId !== undefined && h.loot().isPod(podId)) { send(podCargoState(h.loot(), h.lootSearch, getHoldStore(), h.now(), playerId, h.pilotCollector(playerId), entityId, podId, move)); return; }
    const access = cargoAccess(h, playerId, entityId);
    if (!access.ok) {
      const lr = access.locked;
      const breakIn = lr ? { pct: h.breakIns.progress(playerId, lr.id), durationMs: h.breakInMsFor(lr) } : undefined;
      // Slice 13: close to someone else's storage you may look, not take.
      if (lr && h.sectorKey() !== null && h.pilotNear(playerId, lr)) {
        send(peekCargoState(h.lootSearch, h.now(), playerId, lr.id, h.storage().cargoView(lr).hold, { entityId }, move !== null, access.message + ' You can only look.', breakIn));
        return;
      }
      send({ type: 'cargo_state', entityId, open: false, hold: null, used: 0, capacity: 0, ship: null, shipCapacity: 0, message: access.message, ...(breakIn ? { breakIn } : {}), ...(move ? { ok: false } : {}) });
      return;
    }
    if (access.market) { send(dockMarket(h, playerId, entityId, access, move)); return; }
    send(structureCargoState(structureCargo, playerId, entityId, access, move));
  };
  // C2 — break into locked cargo (a hostile act); stop.
  h.onMessage('break_in', (client: Client, raw: unknown) => {
    const p = BreakInSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'break_in'); return; }
    const actor = h.sessionToPlayer().get(client.sessionId);
    if (!actor) return;
    // C3 — a ship: an NPC ship (by entityId), a player's ship or parked hull.
    const st = h.shipTarget(p.data.ship !== undefined ? { ship: p.data.ship } : { entityId: p.data.entityId! });
    if (st !== null) {
      if (cargoOpensFor(relationOf(actor, st.owner, h.relationCtx), false) || h.breakIns.hasGrant(actor, st.id)) return;
      if (h.getActiveShip(actor)?.shipInstanceId === st.holdUid || !h.pilotNearPoint(actor, st.x, st.y, st.radius)) return;
      h.breakIns.start(actor, st.id, h.breakInMsForShip(st));
      return;
    }
    if (p.data.entityId === undefined) return;
    const swarmRec = h.swarmRegistry.getByEntityId(p.data.entityId);
    const rec = swarmRec ? h.structureRegistry.get(swarmRec.id) : undefined;
    if (!rec || !isOperationalStorage(rec)) return;
    // Only cargo that doesn't open for you, and only once you're there.
    if (cargoOpensFor(relationOf(actor, rec.owner, h.relationCtx), false) || h.breakIns.hasGrant(actor, rec.id)) return;
    if (!h.pilotNear(actor, rec)) return;
    h.breakIns.start(actor, rec.id, h.breakInMsFor(rec));
  });
  h.onMessage('break_in_cancel', (client: Client, raw: unknown) => {
    if (!BreakInCancelSchema.safeParse(raw).success) { h.malformed.record(client.sessionId, 'break_in_cancel'); return; }
    const actor = h.sessionToPlayer().get(client.sessionId);
    if (actor) h.breakIns.cancel(actor, 'You stopped.');
  });

  // T4b — standing orders on the owner's own built Freight Dock (last
  // order per good wins). Convoys fill them; the panel re-reads on its poll.
  h.onMessage('set_freight_orders', (client: Client, raw: unknown) => {
    const p = SetFreightOrdersSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'set_freight_orders'); return; }
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(p.data.entityId);
    const rec = swarmRec ? h.structureRegistry.get(swarmRec.id) : undefined;
    if (!rec || rec.owner !== owner || rec.kind !== 'freight_dock' || !rec.isConstructed) return;
    const byGood = new Map<GoodId, { good: GoodId; mode: 'import' | 'export'; level: number }>();
    for (const o of p.data.orders) byGood.set(o.good, { good: o.good, mode: o.mode, level: o.level });
    rec.freightOrders = [...byGood.values()].slice(0, MAX_FREIGHT_ORDERS);
    if (rec.freightOrders.length === 0) delete rec.freightOrders;
    auditEvent({ event: 'freight_orders_set', sector: h.sectorKey() ?? undefined, playerId: owner, orders: rec.freightOrders?.length ?? 0 });
  });
  // Cargo pods 14c — auto-unload on/off, the ship end or the storage end.
  const autoUnloadDeps: AutoUnloadDeps = {
    activeShipKey: (pid) => h.resolveActiveShipKey(pid), shipRecord: (id) => getPlayerShipStore().get(id), putShipRecord: (r) => getPlayerShipStore().put(r),
    structureAt: (eid) => { const sr = h.swarmRegistry.getByEntityId(eid); return sr ? h.structureRegistry.get(sr.id) : undefined; },
  };
  h.onMessage('set_auto_unload', (client: Client, raw: unknown) => {
    if (!applyAutoUnload(raw, h.sessionToPlayer().get(client.sessionId), autoUnloadDeps)) h.malformed.record(client.sessionId, 'set_auto_unload');
  });
  h.onMessage('cargo_query', (client: Client, raw: unknown) => cargoRequest(client, 'cargo_query', raw));
  h.onMessage('cargo_move', (client: Client, raw: unknown) => cargoRequest(client, 'cargo_move', raw));
  return {};
}

/**
 * C1 (plan soft-leaping-truffle v3) — may `playerId` open the cargo of the
 * structure with this entity id right now? Opens when the relation allows it
 * (`cargoOpensFor`: own and friendly; allied only if the owner allows), the
 * pilot flies a live ship (#17: ACTIVE + alive + a roster row, the loot
 * collector's liveness) and is within CARGO_ACCESS_RANGE of its footprint.
 * Neutral or hostile cargo needs a break-in (C2).
 */
function cargoAccess(h: CargoMessageHost, playerId: string, entityId: number):
  | { ok: true; rec: StructureRecord; shipInstanceId: string; capacity: number; market: boolean }
  | { ok: false; message: string; locked?: StructureRecord } {
  const swarmRec = h.swarmRegistry.getByEntityId(entityId);
  const rec = swarmRec ? h.structureRegistry.get(swarmRec.id) ?? null : null;
  if (rec === null || !isOperationalStorage(rec)) return { ok: false, message: 'That has no cargo hold.' };
  // Allies may open only if the owner allows it; there is no owner setting yet.
  const relation = relationOf(playerId, rec.owner, h.relationCtx);
  let market = false;
  // C2 — a successful break-in opens it for a short window.
  if (!cargoOpensFor(relation, false) && !h.breakIns.hasGrant(playerId, rec.id)) {
    // T4 — an NPC Freight Dock trades with anyone who isn't hostile.
    if (isNpcOwner(rec.owner) && rec.kind === 'freight_dock' && relation !== 'hostile' && getTradeSink() !== null) {
      market = true;
    } else {
      return { ok: false, locked: rec, message: relation === 'hostile' ? 'Locked. They will not trade with you.' : 'Locked. That cargo is not yours.' };
    }
  }
  if (h.sectorKey() === null) return { ok: false, message: 'Cargo only moves in the galaxy.' };
  const ship = h.getActiveShip(playerId);
  const pose = h.shipPoseCache.get(playerId);
  if (!ship?.alive || !ship.isActive || ship.shipInstanceId === '' || getPlayerShipStore().get(ship.shipInstanceId) === null || !pose) {
    return { ok: false, message: 'You need a ship to move cargo.' };
  }
  if (!h.pilotNear(playerId, rec)) return { ok: false, message: 'Fly closer to open its cargo.' };
  return { ok: true, rec, shipInstanceId: ship.shipInstanceId, capacity: h.shipCargoCapacity(ship.kind, ship.shipInstanceId), market };
}

/**
 * T4 — an NPC Freight Dock is a market: Take buys from the base's storage
 * network, Put sells into the dock, at the trade board's regional price for
 * this pilot. Each good is ONE atomic group (ship + storage + the wallet op),
 * clamped first to stock, cargo space, the wallet and the hourly volume.
 */
function dockMarket(
  h: CargoMessageHost,
  playerId: string,
  entityId: number,
  access: { rec: StructureRecord; shipInstanceId: string; capacity: number },
  move: CargoMove | null,
): CargoState {
  const sink = getTradeSink();
  const shipId = access.shipInstanceId;
  const dock = access.rec;
  const sectorKey = h.sectorKey();
  const storage = h.storage();
  const closed = (message: string): CargoState => ({
    type: 'cargo_state', entityId, open: false, hold: null, used: 0, capacity: 0, ship: null, shipCapacity: 0, message, ...(move ? { ok: false } : {}),
  });
  if (sink === null || !paysRealCredits(sectorKey)) return closed('The traders are not here.'); // sandbox: no real credits
  if (sink.dockQuote(playerId, sectorKey, 'minerals') === null) return closed('The traders refuse to deal with you.');
  const wallet = getWallet();
  let verdict: { ok: boolean; message: string } | undefined;
  // Playable base loop — traders never buy a Capital crate back.
  const refusal = move?.dir === 'put' ? packedSellRefusal(getHoldStore().get(shipId)?.hold ?? emptyHold(), move.items.packed ?? []) : null;
  if (refusal !== null) {
    verdict = { ok: false, message: refusal };
  } else if (move !== null) {
    let total = 0;
    let any = false;
    let crateRefusal: string | null = null;
    // Playable base loop — the dock sells a fresh Capital crate (the board's price).
    if (move.dir === 'take' && sink.traderRep !== undefined && (move.items.packed ?? []).includes(CAPITAL_CRATE_PRODUCT)) {
      const r = buyCapitalCrateAtDock({
        holds: getHoldStore(), wallet, persist: true, playerId, shipInstanceId: shipId, shipCapacity: access.capacity,
        traderRep: sink.traderRep(playerId), volumeLeft: sink.volumeLeft(playerId),
      });
      if (r.ok) { total += r.cost; any = true; } else crateRefusal = r.message;
    }
    for (const g of GOOD_IDS) {
      const asked = move.items.goods?.[g] ?? 0;
      if (!(asked > 0)) continue;
      const q = sink.dockQuote(playerId, sectorKey, g);
      if (q === null) continue;
      const ship = getHoldStore().get(shipId)?.hold ?? emptyHold();
      const w = GOOD_DEFS[g].weight;
      if (move.dir === 'take') {
        const unit = q.buy;
        const space = Math.floor(Math.max(0, access.capacity - holdWeight(ship)) / Math.max(1e-9, w));
        const afford = unit > 0 ? Math.floor(wallet.balance(playerId) / unit) : asked;
        const volume = unit > 0 ? Math.floor(sink.volumeLeft(playerId) / unit) : asked;
        const n = Math.min(asked, storage.networkStock(dock, g), space, afford, volume);
        if (n <= 0) continue;
        const cost = Math.ceil(n * unit);
        const op = cost > 0 ? wallet.debitDeferred(playerId, cost, 'dock_buy') : null;
        if (cost > 0 && op === null) continue;
        const moved = storage.marketBuy(shipId, playerId, dock, g, n, op ? [op] : []);
        if (moved <= 0) { if (cost > 0) wallet.credit(playerId, cost, 'dock_refund'); continue; }
        sink.recordDockFill(playerId, g, moved, 'buy', cost);
        total += cost;
        any = true;
      } else {
        const unit = q.sell;
        const fit = Math.floor(storage.dockFreeWeight(dock) / Math.max(1e-9, w));
        const volume = unit > 0 ? Math.floor(sink.volumeLeft(playerId) / unit) : asked;
        const n = Math.min(asked, ship.goods[g] ?? 0, fit, volume);
        if (n <= 0) continue;
        const pay = Math.floor(n * unit);
        const op = pay > 0 ? wallet.creditDeferred(playerId, pay, 'dock_sell') : null;
        const moved = storage.marketSell(shipId, playerId, dock, g, n, op ? [op] : []);
        if (moved <= 0) continue;
        sink.recordDockFill(playerId, g, moved, 'sell', pay);
        total += pay;
        any = true;
      }
    }
    verdict = any
      ? { ok: true, message: move.dir === 'take' ? `Bought for ${total}¢.` : `Sold for ${total}¢.` }
      : crateRefusal !== null ? { ok: false, message: crateRefusal }
      : { ok: false, message: move.dir === 'take' ? 'Nothing bought: out of stock, no room aboard, or not enough credits.' : 'Nothing sold: the dock is full or you hold none.' };
    if (any) auditEvent({ event: 'dock_trade', sector: sectorKey ?? undefined, playerId, owner: dock.owner, dir: move.dir === 'take' ? 'buy' : 'sell', credits: total });
  }
  const stock: Hold = { goods: {}, blueprints: [] };
  if (sink.traderRep !== undefined) stock.packed = [{ ...DOCK_CAPITAL_LISTING }];
  for (const g of GOOD_IDS) {
    const n = storage.networkStock(dock, g);
    if (n > 0) stock.goods[g] = n;
  }
  const ship = getHoldStore().get(shipId)?.hold ?? emptyHold();
  const market: NonNullable<CargoState['market']> = { buy: {}, sell: {} };
  for (const g of GOOD_IDS) {
    if ((stock.goods[g] ?? 0) <= 0 && (ship.goods[g] ?? 0) <= 0) continue;
    const q = sink.dockQuote(playerId, sectorKey, g);
    if (q === null) continue;
    market.buy[g] = q.buy;
    market.sell[g] = q.sell;
  }
  if (sink.traderRep !== undefined) market.packed = { [CAPITAL_CRATE_PRODUCT]: capitalCratePrice(sink.traderRep(playerId)) };
  return { type: 'cargo_state', entityId, open: true, hold: stock, used: 0, capacity: 0, ship, shipCapacity: access.capacity, market, ...(verdict ?? {}) };
}

/** C3 — open / move a SHIP's cargo (NPC ship, another player's ship, a parked
 *  hull, or the pilot's own hold from the HUD cargo chip). */
function shipCargo(h: CargoMessageHost, playerId: string, ref: CargoRef, move: CargoMove | null): CargoState {
  const echo = ref.entityId !== undefined ? { entityId: ref.entityId } : { targetShip: ref.ship! };
  const closed = (message: string, breakIn?: CargoState['breakIn']): CargoState => ({
    type: 'cargo_state', ...echo, open: false, hold: null, used: 0, capacity: 0, ship: null, shipCapacity: 0, message,
    ...(breakIn ? { breakIn } : {}), ...(move ? { ok: false } : {}),
  });
  // The HUD chip names you (`ship: playerId`): while you spectate that is the
  // hull you parked (Command / Quick Launch), keyed by its shipInstanceId.
  const parked = ref.ship === playerId && h.getActiveShip(playerId)?.isActive !== true ? h.ownShipKey(playerId) : undefined;
  const t = h.shipTarget(parked !== undefined ? { ship: parked } : ref);
  if (t === null) return closed('Nothing to open.');
  if (h.sectorKey() === null) return closed('Cargo only moves in the galaxy.');
  if (parked !== undefined && t.holdUid === parked) {
    // Your own hold from the chip while spectating: look only, like flying.
    return ownHoldState(getHoldStore().get(parked)?.hold ?? emptyHold(), t.capacity,
      getPlayerShipStore().get(parked)?.autoUnload !== false, echo, move !== null);
  }
  const mine = h.getActiveShip(playerId);
  if (!mine?.alive || !mine.isActive || mine.shipInstanceId === '' || getPlayerShipStore().get(mine.shipInstanceId) === null) {
    return closed('You need a ship to move cargo.');
  }
  if (t.holdUid === mine.shipInstanceId) {
    // Cargo pods slice 19: "your hold" from the HUD cargo chip (`ownHoldState`).
    return ownHoldState(getHoldStore().get(mine.shipInstanceId)?.hold ?? emptyHold(), h.shipCargoCapacity(mine.kind, mine.shipInstanceId),
      getPlayerShipStore().get(mine.shipInstanceId)?.autoUnload !== false, echo, move !== null);
  }
  if (!h.pilotNearPoint(playerId, t.x, t.y, t.radius)) {
    h.lootSearch.advance(playerId, t.id, h.now(), false);
    return closed('Fly closer to open its cargo.');
  }
  if (!cargoOpensFor(relationOf(playerId, t.owner, h.relationCtx), false) && !h.breakIns.hasGrant(playerId, t.id)) {
    // Slice 13: look, don't take (break-in rules unchanged).
    if (t.npc) h.npcHold(t.npc);
    return peekCargoState(h.lootSearch, h.now(), playerId, t.id, getHoldStore().get(t.holdUid)?.hold ?? emptyHold(), echo, move !== null,
      `Locked. That ${t.label} is not yours: you can only look.`, { pct: h.breakIns.progress(playerId, t.id), durationMs: h.breakInMsForShip(t) });
  }
  if (t.npc) h.npcHold(t.npc); // roll its loot (once) before anyone looks in
  const myCap = h.shipCargoCapacity(mine.kind, mine.shipInstanceId);
  const me = { uid: mine.shipInstanceId, persisted: true, type: 'ship' as HolderType, owner: playerId };
  const them = { uid: t.holdUid, persisted: t.persisted, type: (t.npc ? 'hauler' : 'ship') as HolderType, owner: t.npc ? null : t.owner };
  let verdict: { ok: boolean; message: string } | undefined;
  if (move !== null) {
    const persist = h.sectorKey() !== null;
    const moved = move.dir === 'take' ? moveBetweenHolds(getHoldStore(), persist, them, me, move.items, myCap) : moveBetweenHolds(getHoldStore(), persist, me, them, move.items, t.capacity);
    verdict = isHoldEmpty(moved)
      ? { ok: false, message: move.dir === 'take' ? 'No room aboard for that.' : 'No room in there for that.' }
      : { ok: true, message: move.dir === 'take' ? 'Loaded aboard.' : 'Unloaded.' };
    if (!isHoldEmpty(moved)) {
      auditEvent({ event: 'cargo_moved', sector: h.sectorKey() ?? undefined, playerId, shipInstanceId: mine.shipInstanceId, owner: t.owner, structureKind: `ship:${t.label}`, dir: move.dir, weight: holdWeight(moved) });
    }
  }
  const theirs = getHoldStore().get(t.holdUid)?.hold ?? emptyHold();
  return {
    type: 'cargo_state', ...echo, open: true, hold: theirs, used: holdWeight(theirs), capacity: Number.isFinite(t.capacity) ? t.capacity : 0,
    ship: getHoldStore().get(mine.shipInstanceId)?.hold ?? emptyHold(), shipCapacity: myCap, ...(verdict ?? {}),
  };
}
