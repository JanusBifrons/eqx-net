/**
 * The surfaces the convoy director trades through (moved out of
 * ConvoyDirector.ts): an NPC base as its room reports it, a Freight Dock bay
 * and its crane job, the player payments hook and the room surface
 * SectorRoom implements.
 */
import type { BaseTradeView } from '../../core/economy/convoys.js';
import type { Bus } from '../../core/events/Bus.js';
import type { Hold, GoodId } from '../../shared-types/goods.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { TradeTransferResult, TradeTransferSpec } from '../cargo/StorageService.js';
import type { Wallet } from './Wallet.js';
import type { TradeSink } from './tradeSink.js';

/** One NPC base as its room reports it. */
export interface NpcBaseTrade {
  owner: string;
  /** Uid of a storage structure in the base's network (the trade anchor). */
  networkUid: string;
  view: Omit<BaseTradeView, 'key' | 'sectorKey'>;
  /** The base's footprint box (world). */
  box: { x0: number; x1: number; y0: number; y1: number };
  /** T4b — a player's Freight Dock with standing orders (owner = playerId).
   *  Trades only with NPC bases, and is paid / charged through the wallet. */
  player?: { imports: GoodId[]; exports: GoodId[] };
  /** structure-restyle 3h — a Freight Dock bay a hauler can reach (world
   *  centre); absent = dock at the footprint box's edge (`dockPoint`). */
  bay?: ConvoyBay;
}

/** 3h — a dock's crane bay a convoy hauler parks on. */
export interface ConvoyBay { dockId: string; x: number; y: number }

/** 3h — what a convoy hauler asks a dock's crane for (`ConvoyRoom.craneServe`). */
export interface CraneHaulJob {
  dockId: string;
  /** The base's owner: the dock must still be theirs. */
  owner: string;
  /** Load at pickup, unload at delivery (the crane's cargo direction). */
  cargo: 'load' | 'unload';
  /** Cargo weight moved (sizes the crane's hold, `dockUnloadHoldTicks`). */
  weight: number;
  /** Runs once, in the room tick, at the end of the crane's hold. */
  atHoldEnd: () => void;
}

/** T4b — what the director needs to charge and pay players. */
export interface ConvoyPayments {
  wallet: Pick<Wallet, 'balance' | 'credit' | 'creditDeferred' | 'debitDeferred'>;
  sink: () => TradeSink | null;
}

/** The room surface the convoy director drives (SectorRoom implements it). */
export interface ConvoyRoom {
  eventBus(): Bus;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: { botId: string; kind: ShipKindId; x: number; y: number }): boolean;
  despawnLivingWorldBot(botId: string): unknown;
  getBotPose(botId: string): { x: number; y: number; angle: number } | null;
  setBotMoveTarget(botId: string, x: number, y: number): void;
  tradeTransfer(ownerId: string, networkUid: string, spec: TradeTransferSpec): TradeTransferResult | null;
  tradeDropAt(hold: Hold, x: number, y: number): void;
  /** T2 — this room's NPC bases. */
  npcBaseTrade(): NpcBaseTrade[];
  /** T2 — the nearest point clear of every structure (hauler spawns). */
  clearPointNear(x: number, y: number): { x: number; y: number };
  /** 3h — have `job.dockId`'s crane serve hauler `botId` (the bay dwell
   *  players get: settle, wait its turn, reach, hold, retract). 'serving'
   *  while it is on its way onto the bay or being served; 'none' when that
   *  dock can't serve it (gone, not `job.owner`'s, unpowered): trade
   *  atomically instead. The first job per hauler stands until it runs or
   *  is cancelled. */
  craneServe?(botId: string, job: CraneHaulJob): 'serving' | 'none';
  /** 3h — drop hauler `botId`'s crane job (an arm out retracts, nothing moves). */
  craneCancel?(botId: string): void;
}
