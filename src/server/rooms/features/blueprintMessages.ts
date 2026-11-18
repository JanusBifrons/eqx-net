/**
 * Blueprint and packed-item client messages — load / unload a processor's
 * blueprint (P2b), install a blueprint on my ship (Living World P5), the
 * packed-structure stock, the blueprint market (Economy v2 W6) and unpacking
 * a packed hull (W5a). Moved verbatim out of `SectorRoom`, with the helpers
 * only these handlers used; the room hands in live accessors so every handler
 * reads the same state it did there.
 */
import type { Client } from 'colyseus';
import type { StructureRecord, StructureRegistry } from '../../structures/StructureRegistry.js';
import type { ProductionSubsystem } from '../../structures/ProductionSubsystem.js';
import type { SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import { isOperationalStorage, DEPOSIT_RANGE, type StorageService } from '../../cargo/StorageService.js';
import { getPlayerShipStore, getHoldStore, getWallet } from '../../db/PersistenceWorker.js';
import { getTradeSink } from '../../economy/tradeSink.js';
import { bpBuyPrice, bpSellPrice, getBlueprintMarket, listing as bpListing } from '../../economy/BlueprintMarket.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import type { ParsedMessageHost, RoomFeature } from './parsedMessage.js';
import { packedCount, takePacked } from '../../../core/cargo/hold.js';
import { getShipKind, isPlayableShipKindId, type ShipKindId } from '../../../shared-types/shipKinds.js';
import { ROSTER_SOFT_GUARD } from '../../playerShips/PlayerShipStore.js';
import { isProcessorKind } from '../../../shared-types/production.js';
import { blueprintProductFor } from '../../../shared-types/recipes.js';
import { PackedStockQuerySchema, type PackedStock } from '../../../shared-types/packedStock.js';
import { BpBuySchema, BpMarketQuerySchema, BpSellSchema, type BpListing, type BpMarketState } from '../../../shared-types/blueprintMarket.js';
import { LoadBlueprintSchema, UnloadBlueprintSchema } from '../../../shared-types/messages.js';
import {
  InstallBlueprintSchema, UnpackHullSchema, blueprintName, blueprintQuality, productName, qualityHullFactor, type BlueprintResult,
} from '../../../shared-types/blueprints.js';

/** Economy v2 W5a — an unpacked hull parks this far from its storage. */
const UNPACK_PARK_OFFSET = 400;

/** What the handlers need from the room; getters read the live field. */
export interface BlueprintMessageHost extends ParsedMessageHost {
  sessionToPlayer(): ReadonlyMap<string, string>;
  playerToUser: ReadonlyMap<string, string | null>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'getByEntityId'>;
  structureRegistry: Pick<StructureRegistry, 'get' | 'all'>;
  sectorKey(): string | null;
  production(): Pick<ProductionSubsystem, 'unload' | 'recipeOf'>;
  storage(): Pick<StorageService, 'loadBlueprint' | 'unloadBlueprint' | 'flushDirty' | 'installBlueprint' | 'network' | 'commitChanged'>;
  rebuildStructuresSlice(): void;
  resolveActiveShipKey(playerId: string): string | undefined;
  ship(shipInstanceId: string): ShipState | undefined;
  shipPoseCache: Pick<ReadonlyMap<string, ShipPhysicsState>, 'get'>;
  fittedOf(shipInstanceId: string): readonly string[];
  fittedCache: Pick<Map<string, readonly string[]>, 'set'>;
  shipHullMax(kindMax: number, alloc: ShipState['statAlloc'] | undefined, shipInstanceId: string): number;
}

export function registerBlueprintMessages(h: BlueprintMessageHost): RoomFeature {
  // ── P2b — load / unload a processor's blueprint (owner-gated) ──
  // A loaded cycle hands its inputs back first; if they don't fit, no change.
  const blueprintMessage = (type: 'load_blueprint' | 'unload_blueprint') => (client: Client, raw: unknown) => {
    const parsed = (type === 'load_blueprint' ? LoadBlueprintSchema : UnloadBlueprintSchema).safeParse(raw);
    if (!parsed.success) {
      h.malformed.record(client.sessionId, type);
      return;
    }
    const owner = h.sessionToPlayer().get(client.sessionId);
    if (!owner) return;
    const swarmRec = h.swarmRegistry.getByEntityId(parsed.data.entityId);
    if (!swarmRec) return;
    const rec = h.structureRegistry.get(swarmRec.id);
    if (!rec || rec.owner !== owner || !isProcessorKind(rec.kind)) return;
    if (!h.production().unload(rec)) return;
    const ok = type === 'load_blueprint'
      ? h.storage().loadBlueprint(rec, blueprintProductFor(h.production().recipeOf(rec)), blueprintQuality)
      : h.storage().unloadBlueprint(rec);
    h.storage().flushDirty();
    if (ok) h.rebuildStructuresSlice();
  };
  h.onMessage('load_blueprint', blueprintMessage('load_blueprint'));
  h.onMessage('unload_blueprint', blueprintMessage('unload_blueprint'));

  // ── Living World P5 — install a blueprint from my storage onto my ship ───
  h.onMessage('install_blueprint', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const p = InstallBlueprintSchema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, 'install_blueprint'); return; }
    const reply = (ok: boolean, message: string): void => {
      try { client.send('blueprint_result', { type: 'blueprint_result', ok, message } satisfies BlueprintResult); } catch { /* closing */ }
    };
    const shipId = h.resolveActiveShipKey(playerId);
    const ship = shipId ? h.ship(shipId) : undefined;
    const sectorKey = h.sectorKey();
    if (sectorKey === null || !shipId || !ship || !ship.alive || !ship.isActive) { reply(false, 'You need an active ship here.'); return; }
    const rec = h.swarmRegistry.getByEntityId(p.data.networkEntityId);
    const s = rec ? h.structureRegistry.get(rec.id) : undefined;
    if (s === undefined || s.owner !== playerId || s.uid === undefined) { reply(false, 'Pick one of your storage structures.'); return; }
    const pose = h.shipPoseCache.get(playerId);
    if (!pose || Math.hypot(pose.x - s.x, pose.y - s.y) > DEPOSIT_RANGE) { reply(false, 'Fly your ship next to that storage to install.'); return; }
    const id = p.data.blueprintId;
    if (h.fittedOf(shipId).includes(id)) { reply(false, 'This ship already has that blueprint.'); return; }
    const fitted = h.storage().installBlueprint(playerId, s.uid, id, shipId);
    if (fitted === null) { reply(false, 'That blueprint isn\'t in this storage.'); return; }
    h.fittedCache.set(shipId, fitted);
    // A hull blueprint raises the max now (no free heal — the extra is empty).
    const kind = getShipKind(ship.kind);
    ship.maxHealth = h.shipHullMax(kind.maxHealth, ship.statAlloc, shipId);
    h.rebuildStructuresSlice();
    auditEvent({ event: 'blueprint_installed', sector: sectorKey, playerId, shipInstanceId: shipId, blueprint: id });
    reply(true, `${blueprintName(id)} installed.`);
  });

  // ── Economy v2 — packed-structure stock for the Build menus ──────────────
  h.onMessage('packed_stock_query', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    if (!PackedStockQuerySchema.safeParse(raw).success) { h.malformed.record(client.sessionId, 'packed_stock_query'); return; }
    try { client.send('packed_stock', { type: 'packed_stock', counts: packedStockOf(h, playerId) } satisfies PackedStock); } catch { /* closing */ }
  });

  // ── Economy v2 W6 — the blueprint market (buy / sell, instant) ───────────
  const bpRequest = (client: Client, kind: 'bp_market_query' | 'bp_buy' | 'bp_sell', raw: unknown): void => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const schema = kind === 'bp_buy' ? BpBuySchema : kind === 'bp_sell' ? BpSellSchema : BpMarketQuerySchema;
    const p = schema.safeParse(raw);
    if (!p.success) { h.malformed.record(client.sessionId, kind); return; }
    const d = p.data as { networkEntityId: number; offerId?: string; uid?: string };
    let verdict: { ok: boolean; message: string } | undefined;
    if (kind === 'bp_buy') verdict = buyBlueprint(h, playerId, d.networkEntityId, d.offerId!);
    else if (kind === 'bp_sell') verdict = sellBlueprint(h, playerId, d.networkEntityId, d.uid!);
    try { client.send('bp_market_state', bpMarketView(h, playerId, d.networkEntityId, verdict)); } catch { /* closing */ }
  };
  h.onMessage('bp_market_query', (client: Client, raw: unknown) => bpRequest(client, 'bp_market_query', raw));
  h.onMessage('bp_buy', (client: Client, raw: unknown) => bpRequest(client, 'bp_buy', raw));
  h.onMessage('bp_sell', (client: Client, raw: unknown) => bpRequest(client, 'bp_sell', raw));

  // ── Economy v2 W5a — unpack a packed hull into my roster ─────────────────
  h.onMessage('unpack_hull', (client: Client, raw: unknown) => {
    const playerId = h.sessionToPlayer().get(client.sessionId);
    if (!playerId) return;
    const p = UnpackHullSchema.safeParse(raw);
    if (!p.success || !isPlayableShipKindId(p.data.kind)) { h.malformed.record(client.sessionId, 'unpack_hull'); return; }
    const reply = (ok: boolean, message: string): void => {
      try { client.send('blueprint_result', { type: 'blueprint_result', ok, message } satisfies BlueprintResult); } catch { /* closing */ }
    };
    reply(...unpackHull(h, playerId, p.data.networkEntityId, p.data.kind));
  });
  return {};
}

/**
 * Economy v2 W5a — unpack one packed `kind` hull from `playerId`'s storage
 * network at `networkEntityId` into their roster: a fresh ship parked beside
 * that storage, picked from the roster like any other. The roster cap is
 * checked first; the packed item is taken (one hold group) BEFORE the roster
 * row is created, and put back if creating it fails, so a hull is never
 * duplicated. Galaxy rooms only (engineering rooms have no roster).
 */
function unpackHull(h: BlueprintMessageHost, playerId: string, networkEntityId: number, kind: ShipKindId): [boolean, string] {
  const name = getShipKind(kind).displayName;
  const sectorKey = h.sectorKey();
  if (sectorKey === null) return [false, 'Ships can only be unpacked in the galaxy.'];
  const rec = h.swarmRegistry.getByEntityId(networkEntityId);
  const s = rec ? h.structureRegistry.get(rec.id) : undefined;
  if (s === undefined || s.owner !== playerId || !isOperationalStorage(s)) return [false, 'Pick one of your storage structures.'];
  const product = `hull:${kind}`;
  const from = h.storage().network(s).find((r) => r.hold !== undefined && packedCount(r.hold, product) > 0);
  if (from === undefined) return [false, `There is no packed ${name} in this base.`];
  const store = getPlayerShipStore();
  if (store.listByPlayer(playerId).length >= ROSTER_SOFT_GUARD) return [false, `Your roster is full (${ROSTER_SOFT_GUARD} ships). Abandon one first.`];
  const item = takePacked(from.hold!, product)!;
  h.storage().commitChanged([from], []);
  try {
    const ship = store.create({
      playerId,
      userId: h.playerToUser.get(playerId) ?? null,
      kind,
      sectorKey,
      x: s.x + UNPACK_PARK_OFFSET,
      y: s.y,
      health: Math.round(getShipKind(kind).maxHealth * qualityHullFactor(item.quality)),
      hullQuality: item.quality,
    });
    auditEvent({ event: 'hull_unpacked', sector: sectorKey, playerId, shipInstanceId: ship.shipId, kind, quality: item.quality });
    return [true, `${name} unpacked: it's in your roster.`];
  } catch {
    (from.hold!.packed ??= []).push(item);
    h.storage().commitChanged([from], []);
    return [false, `Could not unpack the ${name}.`];
  }
}

/** Economy v2 — `playerId`'s packed STRUCTURES in this sector, by product:
 *  their operational storage here plus their active ship's hold (exactly
 *  where `packedGateForBuild` looks). Control cadence (allocates). */
function packedStockOf(h: BlueprintMessageHost, playerId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (items: readonly { product: string }[] | undefined): void => {
    for (const it of items ?? []) if (it.product.startsWith('structure:')) counts[it.product] = (counts[it.product] ?? 0) + 1;
  };
  for (const rec of h.structureRegistry.all()) {
    if (rec.owner === playerId && rec.hold !== undefined && isOperationalStorage(rec)) add(rec.hold.packed);
  }
  const shipId = h.resolveActiveShipKey(playerId);
  if (shipId) add(getHoldStore().get(shipId)?.hold.packed);
  return counts;
}

/** Economy v2 W6 — `playerId`'s operational storage at `networkEntityId`. */
function ownStorageAt(h: BlueprintMessageHost, playerId: string, networkEntityId: number): StructureRecord | null {
  const rec = h.swarmRegistry.getByEntityId(networkEntityId);
  const s = rec ? h.structureRegistry.get(rec.id) : undefined;
  return s !== undefined && s.owner === playerId && s.uid !== undefined && isOperationalStorage(s) ? s : null;
}

/** Economy v2 W6 — the market view for `playerId`'s base at `networkEntityId`. */
function bpMarketView(h: BlueprintMessageHost, playerId: string, networkEntityId: number, verdict?: { ok: boolean; message: string }): BpMarketState {
  const rep = getTradeSink()?.traderRep?.(playerId) ?? 0;
  const s = ownStorageAt(h, playerId, networkEntityId);
  const mine: BpListing[] = [];
  if (s !== null) {
    for (const r of h.storage().network(s)) {
      for (const b of r.hold?.blueprints ?? []) if (mine.length < 200) mine.push(bpListing(b, b.uid, bpSellPrice(b, rep)));
    }
  }
  return {
    type: 'bp_market_state',
    networkEntityId,
    offers: getBlueprintMarket().offersFor(rep),
    mine,
    ...(verdict ?? {}),
  };
}

/** Economy v2 W6 — buy a board blueprint into this base: the wallet debit
 *  and the storage change commit as ONE group; the offer then leaves the board. */
function buyBlueprint(h: BlueprintMessageHost, playerId: string, networkEntityId: number, offerId: string): { ok: boolean; message: string } {
  const s = ownStorageAt(h, playerId, networkEntityId);
  if (s === null) return { ok: false, message: 'Pick one of your storage structures.' };
  const market = getBlueprintMarket();
  const bp = market.peek(offerId);
  if (bp === null) return { ok: false, message: 'That blueprint has been sold.' };
  const price = bpBuyPrice(bp, getTradeSink()?.traderRep?.(playerId) ?? 0);
  const pay = getWallet().debitDeferred(playerId, price, 'blueprint_buy');
  if (pay === null) return { ok: false, message: `You need ${price}¢ for that blueprint.` };
  market.remove(offerId);
  (s.hold ??= { goods: {}, blueprints: [] }).blueprints.push(bp);
  h.storage().commitChanged([s], [pay]);
  auditEvent({ event: 'blueprint_traded', sector: h.sectorKey() ?? undefined, playerId, side: 'buy', product: bp.product, credits: price });
  return { ok: true, message: `Bought ${productName(bp.product)} blueprint for ${price}¢.` };
}

/** Economy v2 W6 — sell a blueprint from this base to traders (one group). */
function sellBlueprint(h: BlueprintMessageHost, playerId: string, networkEntityId: number, uid: string): { ok: boolean; message: string } {
  const s = ownStorageAt(h, playerId, networkEntityId);
  if (s === null) return { ok: false, message: 'Pick one of your storage structures.' };
  const from = h.storage().network(s).find((r) => r.hold?.blueprints.some((b) => b.uid === uid));
  if (from === undefined) return { ok: false, message: 'That blueprint is not in this base.' };
  const list = from.hold!.blueprints;
  const bp = list.find((b) => b.uid === uid)!;
  const price = bpSellPrice(bp, getTradeSink()?.traderRep?.(playerId) ?? 0);
  if (price <= 0) return { ok: false, message: 'Traders won’t buy that blueprint.' };
  list.splice(list.indexOf(bp), 1);
  const op = getWallet().creditDeferred(playerId, price, 'blueprint_sell');
  h.storage().commitChanged([from], op ? [op] : []);
  auditEvent({ event: 'blueprint_traded', sector: h.sectorKey() ?? undefined, playerId, side: 'sell', product: bp.product, credits: price });
  return { ok: true, message: `Sold ${productName(bp.product)} blueprint for ${price}¢.` };
}
