/**
 * Cargo client messages — open / move a structure's or ship's cargo (C1/C3),
 * an NPC Freight Dock's market (T4), break-ins (C2) and a Freight Dock's
 * standing orders (T4b). Moved verbatim out of `SectorRoom`, with the cargo
 * gate (`cargoAccess`) and the dock market only these handlers used; the room
 * hands in live accessors so every handler reads the same state it did there.
 */
import type { Client } from 'colyseus';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { BreakInSubsystem } from '../BreakInSubsystem.js';
import { isOperationalStorage, type StorageService } from '../../cargo/StorageService.js';
import { getPlayerShipStore, getHoldStore, getWallet } from '../../db/PersistenceWorker.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { emptyHold, holdWeight, isHoldEmpty, type CargoRequest } from '../../../core/cargo/hold.js';
import { GOOD_DEFS, GOOD_IDS, type Hold } from '../../../shared-types/goods.js';
import type { GoodId } from '../../../shared-types/goods.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import { cargoOpensFor, isNpcOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import {
  BreakInCancelSchema, BreakInSchema, CARGO_ACCESS_RANGE, CargoMoveSchema, CargoQuerySchema, MAX_FREIGHT_ORDERS, SetFreightOrdersSchema, type CargoState,
} from '../../../shared-types/messages/cargoMessages.js';

/** The part of a C3 ship cargo target these handlers read (`SectorRoom.shipTarget`). */
export interface CargoShipTarget {
  /** Break-in / grant key: the NPC swarm id, or the player hull's shipInstanceId. */
  id: string;
  holdUid: string;
  owner: string;
  x: number;
  y: number;
  radius: number;
  capacity: number;
}

type CargoMove = { dir: 'take' | 'put'; items: CargoRequest };

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
  shipCargo(playerId: string, ref: { entityId?: number; ship?: string }, move: CargoMove | null): CargoState;
  shipTarget(ref: { entityId?: number; ship?: string }): CargoShipTarget | null;
  breakInMsFor(rec: StructureRecord): number;
  breakInMsForShip(t: CargoShipTarget): number;
  pilotNear(playerId: string, rec: StructureRecord): boolean;
  pilotNearPoint(playerId: string, x: number, y: number, radius: number): boolean;
}

export function registerCargoMessages(h: CargoMessageHost): RoomFeature {
  // ── C1 (plan soft-leaping-truffle v3) — open a structure's cargo ────────
  // The cargo pane is rebuilt from `cargo_state` replies only (#16).
  const cargoRequest = (client: Client, kind: 'cargo_query' | 'cargo_move', raw: unknown): void => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    let ref: { entityId?: number; ship?: string };
    let move: CargoMove | null = null;
    if (kind === 'cargo_move') {
      const p = CargoMoveSchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      ref = p.data.ship !== undefined ? { ship: p.data.ship } : { entityId: p.data.entityId! };
      move = { dir: p.data.dir, items: p.data.items };
    } else {
      const p = CargoQuerySchema.safeParse(raw);
      if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
      ref = p.data.ship !== undefined ? { ship: p.data.ship } : { entityId: p.data.entityId! };
    }
    const send = (st: CargoState): void => { try { client.send('cargo_state', st); } catch { /* closing */ } };
    // C3 — a ship (an NPC ship by entityId, a player's ship / parked hull).
    if (ref.ship !== undefined || h.swarmRegistry.getByEntityId(ref.entityId!)?.kind === 1) {
      send(h.shipCargo(playerId, ref, move));
      return;
    }
    const entityId = ref.entityId!;
    const access = cargoAccess(h, playerId, entityId);
    if (!access.ok) {
      const lr = access.locked;
      const breakIn = lr ? { pct: h.breakIns.progress(playerId, lr.id), durationMs: h.breakInMsFor(lr) } : undefined;
      send({ type: 'cargo_state', entityId, open: false, hold: null, used: 0, capacity: 0, ship: null, shipCapacity: 0, message: access.message, ...(breakIn ? { breakIn } : {}), ...(move ? { ok: false } : {}) });
      return;
    }
    if (access.market) { send(dockMarket(h, playerId, entityId, access, move)); return; }
    let verdict: { ok: boolean; message: string } | undefined;
    if (move !== null) {
      const moved = move.dir === 'take'
        ? h.storage().cargoTake(access.shipInstanceId, playerId, access.rec, move.items, access.capacity)
        : h.storage().cargoPut(access.shipInstanceId, playerId, access.rec, move.items);
      if (isHoldEmpty(moved)) {
        verdict = { ok: false, message: move.dir === 'take' ? 'No room aboard for that.' : 'No room in there for that.' };
      } else {
        verdict = { ok: true, message: move.dir === 'take' ? 'Loaded aboard.' : 'Unloaded.' };
        h.manualCargo.add(playerId);
        auditEvent({
          event: 'cargo_moved', sector: h.sectorKey() ?? undefined, playerId, shipInstanceId: access.shipInstanceId,
          owner: access.rec.owner, structureKind: access.rec.kind, dir: move.dir, weight: holdWeight(moved),
        });
        // A Capital's mineral bank rides room state.
        if (getStructureKind(access.rec.kind).storageCapacity > 0) h.rebuildStructuresSlice();
      }
    }
    const view = h.storage().cargoView(access.rec);
    const shipHold = getHoldStore().get(access.shipInstanceId)?.hold ?? emptyHold();
    const own = access.rec.owner === playerId && access.rec.kind === 'freight_dock';
    send({
      type: 'cargo_state', entityId, open: true, hold: view.hold, used: view.used, capacity: view.capacity,
      ship: shipHold, shipCapacity: access.capacity,
      ...(own ? { orders: (access.rec.freightOrders ?? []).map((o) => ({ ...o })) } : {}),
      ...(verdict ?? {}),
    });
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
  const dx = Math.max(Math.abs(pose.x - rec.x) - (rec.halfW ?? rec.radius), 0);
  const dy = Math.max(Math.abs(pose.y - rec.y) - (rec.halfH ?? rec.radius), 0);
  if (dx * dx + dy * dy > CARGO_ACCESS_RANGE * CARGO_ACCESS_RANGE) {
    return { ok: false, message: 'Fly closer to open its cargo.' };
  }
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
  if (sink === null) return closed('The traders are not here.');
  if (sink.dockQuote(playerId, sectorKey, 'minerals') === null) return closed('The traders refuse to deal with you.');
  const wallet = getWallet();
  let verdict: { ok: boolean; message: string } | undefined;
  if (move !== null) {
    let total = 0;
    let any = false;
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
      : { ok: false, message: move.dir === 'take' ? 'Nothing bought: out of stock, no room aboard, or not enough credits.' : 'Nothing sold: the dock is full or you hold none.' };
    if (any) auditEvent({ event: 'dock_trade', sector: sectorKey ?? undefined, playerId, owner: dock.owner, dir: move.dir === 'take' ? 'buy' : 'sell', credits: total });
  }
  const stock: Hold = { goods: {}, blueprints: [] };
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
  return { type: 'cargo_state', entityId, open: true, hold: stock, used: 0, capacity: 0, ship, shipCapacity: access.capacity, market, ...(verdict ?? {}) };
}
