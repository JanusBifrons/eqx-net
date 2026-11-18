/**
 * The cargo / loot window's server side, moved out of `SectorRoom`
 * (pure moves; the room keeps the message wiring). Every function takes
 * explicit collaborators, never the room.
 *
 * - `parseCargoRequest` / `sendCargoState`: the `cargo_query` / `cargo_move`
 *   envelope (a rock chunk's ore never leaves the server: `wireHold`).
 * - `structureCargoState`: an open structure's cargo, plus a take / put (C1).
 * - `moveBetweenHolds`: a ship-to-ship cargo move, one atomic group (C3).
 * - `podCargoState`: a loot pod opened in the loot window (slices 11-12).
 * - `peekCargoState`: look, don't take, at a stranger's cargo (slice 13).
 * - `ownHoldState`: "your hold" from the HUD cargo chip (slice 19).
 * - `applyAutoUnload`: the 14c auto-unload switch (ship end / storage end).
 * - `dropTestPodRow`: the `test_drop_pods` test-mode row of pods.
 */
import type { Client } from 'colyseus';
import { randomUUID } from 'node:crypto';
import { CargoMoveSchema, CargoQuerySchema, SetAutoUnloadSchema, type CargoState } from '../../shared-types/messages/cargoMessages.js';
import { clampRequest, isRequestEmpty, searchView } from '../../core/cargo/lootSearch.js';
import { cloneHold, emptyHold, extractRequested, holdWeight, isHoldEmpty, mergeInto, transferInto, wireHold, type CargoRequest } from '../../core/cargo/hold.js';
import { scrapColliderFor } from '../../core/geometry/scrapCollider.js';
import { podComponentIndex } from '../../shared-types/shipKinds/cargoPod.js';
import { ROCK_CHUNK_PRODUCT } from '../../shared-types/items.js';
import type { Hold } from '../../shared-types/goods.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import type { PlayerShipRecord } from '../playerShips/PlayerShipStore.js';
import { isOperationalStorage, type StorageService } from './StorageService.js';
import type { HolderType, HoldRecord, HoldStore } from './HoldStore.js';
import type { LootCollector, LootSubsystem } from './LootSubsystem.js';
import type { LootSearch } from './LootSearch.js';

export type CargoMove = { dir: 'take' | 'put'; items: CargoRequest };
export type CargoRef = { entityId?: number; ship?: string };

/** A `cargo_query` / `cargo_move` payload; null = malformed. */
export function parseCargoRequest(kind: 'cargo_query' | 'cargo_move', raw: unknown): { ref: CargoRef; move: CargoMove | null } | null {
  if (kind === 'cargo_move') {
    const p = CargoMoveSchema.safeParse(raw);
    if (!p.success) return null;
    return { ref: p.data.ship !== undefined ? { ship: p.data.ship } : { entityId: p.data.entityId! }, move: { dir: p.data.dir, items: p.data.items } };
  }
  const p = CargoQuerySchema.safeParse(raw);
  if (!p.success) return null;
  return { ref: p.data.ship !== undefined ? { ship: p.data.ship } : { entityId: p.data.entityId! }, move: null };
}

/** Send a cargo reply. A rock chunk's ore never leaves the server (`wireHold`: the gacha). */
export function sendCargoState(client: Client, st: CargoState): void {
  if (st.hold !== null) st.hold = wireHold(st.hold);
  if (st.ship !== null) st.ship = wireHold(st.ship);
  try { client.send('cargo_state', st); } catch { /* closing */ }
}

/** Collaborators for an open structure's cargo. */
export interface StructureCargoDeps {
  storage: () => StorageService;
  holds: () => HoldStore;
  shipRecord: (shipInstanceId: string) => PlayerShipRecord | null;
  /** Pilots who moved cargo by hand (the auto-deposit stands back). */
  manualCargo: Set<string>;
  sectorKey: () => string | null;
  /** A Capital's mineral bank rides room state. */
  bankChanged: () => void;
}

/** C1 — an open structure's cargo (access already granted), after an
 *  optional take / put via `StorageService.cargoTake` / `cargoPut`. */
export function structureCargoState(
  d: StructureCargoDeps, playerId: string, entityId: number,
  access: { rec: StructureRecord; shipInstanceId: string; capacity: number }, move: CargoMove | null,
): CargoState {
  const storage = d.storage();
  let verdict: { ok: boolean; message: string } | undefined;
  if (move !== null) {
    const moved = move.dir === 'take'
      ? storage.cargoTake(access.shipInstanceId, playerId, access.rec, move.items, access.capacity)
      : storage.cargoPut(access.shipInstanceId, playerId, access.rec, move.items);
    if (isHoldEmpty(moved)) {
      verdict = { ok: false, message: move.dir === 'take' ? 'No room aboard for that.' : 'No room in there for that.' };
    } else {
      verdict = { ok: true, message: move.dir === 'take' ? 'Loaded aboard.' : 'Unloaded.' };
      d.manualCargo.add(playerId);
      auditEvent({
        event: 'cargo_moved', sector: d.sectorKey() ?? undefined, playerId, shipInstanceId: access.shipInstanceId,
        owner: access.rec.owner, structureKind: access.rec.kind, dir: move.dir, weight: holdWeight(moved),
      });
      if (getStructureKind(access.rec.kind).storageCapacity > 0) d.bankChanged();
    }
  }
  const view = storage.cargoView(access.rec);
  const shipHold = d.holds().get(access.shipInstanceId)?.hold ?? emptyHold();
  const own = access.rec.owner === playerId && access.rec.kind === 'freight_dock';
  const ownStorage = access.rec.owner === playerId && isOperationalStorage(access.rec);
  return {
    type: 'cargo_state', entityId, open: true, hold: view.hold, used: view.used, capacity: view.capacity,
    ship: shipHold, shipCapacity: access.capacity,
    ...(own ? { orders: (access.rec.freightOrders ?? []).map((o) => ({ ...o })) } : {}),
    ...(ownStorage ? { autoUnload: d.shipRecord(access.shipInstanceId)?.autoUnload !== false, acceptAutoUnload: access.rec.acceptAutoUnload !== false } : {}),
    ...(verdict ?? {}),
  };
}

/**
 * C3 — move the requested items from one hold to another. Player holds
 * commit together in ONE atomic group; an NPC loot hold (memory only) is
 * updated in memory and never persisted. Returns what moved. `persist`:
 * the commit reaches the DB (a galaxy sector, not an engineering room).
 */
export function moveBetweenHolds(
  store: HoldStore, persist: boolean,
  from: { uid: string; persisted: boolean; type: HolderType; owner: string | null },
  to: { uid: string; persisted: boolean; type: HolderType; owner: string | null },
  want: CargoRequest,
  toCapacity: number,
): Hold {
  const fromRow = store.get(from.uid);
  if (fromRow === undefined) return emptyHold();
  const src = cloneHold(fromRow.hold);
  const toRow = store.get(to.uid);
  const dst = cloneHold(toRow?.hold ?? emptyHold());
  const picked = extractRequested(src, want);
  const { moved } = transferInto(dst, picked, toCapacity);
  mergeInto(src, picked);
  if (isHoldEmpty(moved)) return moved;
  const puts: HoldRecord[] = [];
  const deletes: string[] = [];
  const write = (side: typeof from, row: HoldRecord | undefined, hold: Hold): void => {
    const rec: HoldRecord = row
      ? { ...row, hold }
      : { holderUid: side.uid, holderType: side.type, ownerId: side.owner, sectorKey: null, x: null, y: null, hold, expiresAt: null };
    if (!side.persisted) {
      // An NPC loot hold stays even when emptied: its loot was rolled once,
      // and a missing row would roll it again at death (taken twice).
      store.put(rec, false);
      return;
    }
    if (isHoldEmpty(hold)) deletes.push(side.uid); else puts.push(rec);
  };
  write(from, fromRow, src);
  write(to, toRow, dst);
  if (puts.length > 0 || deletes.length > 0) store.commit(puts, deletes, persist);
  return moved;
}

/** A loot pod opened in the loot window (plan cargo-pods slice 11): free
 *  for all within `LOOT_OPEN_REACH`; `take` only (a pod is never filled). */
export function podCargoState(
  loot: LootSubsystem, search: LootSearch, holds: HoldStore, now: number,
  playerId: string, c: LootCollector | null, entityId: number, podId: string, move: CargoMove | null,
): CargoState {
  const closed = (message: string): CargoState => ({
    type: 'cargo_state', entityId, open: false, hold: null, used: 0, capacity: 0, ship: null, shipCapacity: 0, message, ...(move ? { ok: false } : {}),
  });
  if (c === null) return closed('You need a ship to take loot.');
  const inReach = loot.inOpenReach(c, podId);
  const elapsed = search.advance(playerId, podId, now, inReach);
  let verdict: { ok: boolean; message: string } | undefined;
  if (move !== null) {
    if (move.dir === 'put') verdict = { ok: false, message: 'A cargo pod only gives.' };
    else {
      // Only found stacks can be taken (slice 12).
      const before = holds.get(podId)?.hold;
      const want = before === undefined ? move.items : clampRequest(searchView(before, elapsed).revealed, move.items);
      const r = before !== undefined && inReach && isRequestEmpty(want) ? { ok: false as const, reason: 'unfound' as const } : loot.take(c, podId, want);
      verdict = r.ok ? { ok: true, message: 'Loaded aboard.' }
        : r.reason === 'unfound' ? { ok: false, message: 'Still searching.' }
        : { ok: false, message: r.reason === 'hold_full' ? 'No room aboard for that.' : r.reason === 'out_of_reach' ? 'Fly closer to open it.' : 'It is empty.' };
    }
  }
  const pod = holds.get(podId)?.hold;
  const shipHold = holds.get(c.shipInstanceId)?.hold ?? emptyHold();
  if (pod === undefined) {
    search.forgetContainer(podId);
    return { type: 'cargo_state', entityId, open: false, hold: null, used: 0, capacity: 0, ship: shipHold, shipCapacity: c.capacity, message: 'It is empty.', ...(verdict ? { ok: verdict.ok } : {}) };
  }
  if (!inReach) return closed('Fly closer to open it.');
  const seen = searchView(pod, elapsed);
  return {
    type: 'cargo_state', entityId, open: true, hold: seen.revealed, used: holdWeight(seen.revealed), capacity: 0, ship: shipHold, shipCapacity: c.capacity,
    ...(seen.hidden > 0 ? { hidden: seen.hidden, revealInMs: Math.ceil(seen.nextInMs) } : {}),
    ...(verdict ?? {}),
  };
}

/**
 * Plan cargo-pods slice 13: a peek at a living stranger's cargo. Open to
 * look (searched like a pod, per viewer), never to move: a move gets
 * `ok:false`. Callers have already checked the pilot is close.
 */
export function peekCargoState(
  search: LootSearch, now: number, playerId: string, containerId: string, hold: Hold, echo: { entityId: number } | { targetShip: string },
  isMove: boolean, message: string, breakIn?: CargoState['breakIn'],
): CargoState {
  const seen = searchView(hold, search.advance(playerId, containerId, now, true));
  return {
    type: 'cargo_state', ...echo, open: true, takeable: false, hold: seen.revealed, used: holdWeight(seen.revealed), capacity: 0,
    ship: null, shipCapacity: 0, message,
    ...(seen.hidden > 0 ? { hidden: seen.hidden, revealInMs: Math.ceil(seen.nextInMs) } : {}),
    ...(breakIn ? { breakIn } : {}), ...(isMove ? { ok: false } : {}),
  };
}

/** Cargo pods slice 19: "your hold" from the HUD cargo chip. One hold, all
 *  visible (no search on your own ship), nothing to take. */
export function ownHoldState(
  own: Hold, capacity: number, autoUnload: boolean, echo: { entityId: number } | { targetShip: string }, isMove: boolean,
): CargoState {
  return {
    type: 'cargo_state', ...echo, open: true, own: true, takeable: false, hold: own, used: holdWeight(own),
    capacity, ship: null, shipCapacity: 0, autoUnload,
    ...(isMove ? { ok: false, message: 'That is already aboard.' } : {}),
  };
}

/** Collaborators for the `set_auto_unload` switch. */
export interface AutoUnloadDeps {
  activeShipKey: (playerId: string) => string | undefined;
  shipRecord: (shipInstanceId: string) => PlayerShipRecord | null;
  putShipRecord: (rec: PlayerShipRecord) => void;
  structureAt: (entityId: number) => StructureRecord | undefined;
}

/** Cargo pods 14c — auto-unload on/off, the ship end or the storage end.
 *  Returns false on a malformed payload (the caller records it). */
export function applyAutoUnload(raw: unknown, owner: string | undefined, d: AutoUnloadDeps): boolean {
  const p = SetAutoUnloadSchema.safeParse(raw);
  if (!p.success) return false;
  if (!owner) return true;
  if (p.data.side === 'ship') {
    const shipId = d.activeShipKey(owner);
    const rec = shipId !== undefined ? d.shipRecord(shipId) : null;
    if (!rec || rec.playerId !== owner || (rec.autoUnload !== false) === p.data.on) return true;
    const next = { ...rec };
    if (p.data.on) delete next.autoUnload; else next.autoUnload = false;
    d.putShipRecord(next);
    return true;
  }
  const rec = d.structureAt(p.data.entityId!);
  if (!rec || rec.owner !== owner || !isOperationalStorage(rec)) return true;
  if (p.data.on) delete rec.acceptAutoUnload; else rec.acceptAutoUnload = false;
  return true;
}

/** Test mode: a row of pods above (x, y), sizes 0..3 left to right, beacons
 *  grey, blue, gold, magenta (spill); the huge one holds a mix, so its loot
 *  window shows a few tiles. */
export function dropTestPodRow(loot: LootSubsystem, px: number, py: number): void {
  const holds: Array<Partial<Record<'salvage' | 'alloy' | 'core', number>>> = [{ salvage: 4 }, { alloy: 4 }, { core: 2 }, { salvage: 9, alloy: 3, core: 1 }];
  // One row ending with the huge pod right under the ship (inside the
  // loot open reach, so the stills can open its window).
  const GAP = 24;
  const halves = holds.map((_, size) => scrapColliderFor('cargo-pod', podComponentIndex(size, 0))?.radius ?? 20);
  let x = px + halves[3]! - (halves.reduce((s, r) => s + 2 * r, 0) + GAP * (holds.length - 1));
  for (let size = 0; size < holds.length; size++) {
    x += halves[size]!;
    // The huge one also holds a rock chunk (a ship's spilled hold can),
    // so the stills show its tile in the window and then in the hold.
    const packed = size === 3 ? [{ product: ROCK_CHUNK_PRODUCT, quality: 0, uid: `rc-${randomUUID()}`, weight: 400, ore: {} }] : undefined;
    loot.drop({ goods: holds[size]!, blueprints: [], ...(packed && { packed }) }, x, py - 100, 0, 0, { size, alone: true, spill: size === 3 });
    x += halves[size]! + GAP;
  }
}
