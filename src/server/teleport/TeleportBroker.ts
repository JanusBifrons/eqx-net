/**
 * Teleporters across sectors (plan soft-leaping-truffle v4, T3). A
 * process-wide registry, like the trade sink: every room with a sector key
 * registers itself, so a teleporter can reach its partner in another sector's
 * room (all galaxy rooms are live in one process).
 *
 * The broker only finds rooms and moves NPC bots; each room still owns its
 * own teleporters, storage and ships.
 */
import type { StorageService } from '../cargo/StorageService.js';
import type { StructureRecord } from '../structures/StructureRegistry.js';
import type { TeleporterSubsystem } from '../structures/TeleporterSubsystem.js';

/** What the broker needs from a room. SectorRoom implements it. */
export interface TeleportRoom {
  readonly sectorKey: string | null;
  readonly teleporters: TeleporterSubsystem;
  readonly storage: StorageService;
  /** The built teleporter with this structure uid, or null. */
  teleporterByUid(uid: string): StructureRecord | null;
  /** The owner's built teleporters in this room (for the pairing list). */
  ownTeleporters(owner: string): StructureRecord[];
  /** v4 H — every structure in this room (link lookups). */
  structures(): Iterable<StructureRecord>;
  /** Who is on `from`'s pad right now (offsets from its centre). Both ends of
   *  a jump are collected BEFORE either is dispatched, so nobody rides twice. */
  collectRiders(from: StructureRecord): RiderBatch;
  /**
   * Send a collected batch to `toRoom`'s pad `to` (same offsets). Pilots leave
   * by an instant transit; parked hulls are rebuilt on the far side; NPC bots
   * move through their director (a bot no director owns stays behind).
   */
  dispatchRiders(batch: RiderBatch, toRoom: TeleportRoom, to: StructureRecord): void;
  /** T4 — send a message to a player if they are in this room. */
  sendToPlayer(playerId: string, type: string, msg: unknown): boolean;
  /** Rebuild a parked hull that rode a jump into this room. */
  receiveLingeringHull(row: {
    shipInstanceId: string;
    playerId: string;
    kind: string;
    x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
    health: number;
    shieldDown: boolean;
  }): void;
}

/** Everything on one pad at the swap, as offsets from the pad's centre. */
export interface RiderBatch {
  pilots: Array<{ playerId: string; dx: number; dy: number }>;
  hulls: Array<{
    shipInstanceId: string;
    playerId: string;
    kind: string;
    dx: number; dy: number; vx: number; vy: number; angle: number; angvel: number;
    health: number;
    shieldDown: boolean;
  }>;
  bots: Array<{ botId: string; dx: number; dy: number }>;
}

/** T4 — a request to pair another owner's teleporter with one of yours. */
export interface PairRequest {
  id: string;
  /** The other owner's teleporter (they accept or decline). */
  targetSector: string;
  targetUid: string;
  toOwner: string;
  /** The requester's own teleporter. */
  fromSector: string;
  fromUid: string;
  fromOwner: string;
  atMs: number;
}

/** Pending pair requests expire after this long. */
export const PAIR_REQUEST_TTL_MS = 10 * 60_000;

/** Moves a director-owned NPC bot between sectors (a director registers one). */
export type BotMover = (botId: string, fromSector: string, toSector: string, x: number, y: number) => boolean;

export class TeleportBroker {
  private readonly rooms = new Map<string, TeleportRoom>();
  private readonly movers: BotMover[] = [];
  private readonly requests = new Map<string, PairRequest>();

  register(room: TeleportRoom): void {
    if (room.sectorKey !== null) this.rooms.set(room.sectorKey, room);
  }

  unregister(room: TeleportRoom): void {
    if (room.sectorKey !== null && this.rooms.get(room.sectorKey) === room) this.rooms.delete(room.sectorKey);
  }

  room(sectorKey: string): TeleportRoom | null {
    return this.rooms.get(sectorKey) ?? null;
  }

  /** A partner teleporter in another sector, with its room. */
  find(sectorKey: string, uid: string): { room: TeleportRoom; rec: StructureRecord } | null {
    const room = this.rooms.get(sectorKey);
    if (!room) return null;
    const rec = room.teleporterByUid(uid);
    return rec ? { room, rec } : null;
  }

  /** Every built teleporter the owner has, in every registered sector. */
  ownTeleporters(owner: string): Array<{ sectorKey: string; rec: StructureRecord }> {
    const out: Array<{ sectorKey: string; rec: StructureRecord }> = [];
    for (const [sectorKey, room] of this.rooms) {
      for (const rec of room.ownTeleporters(owner)) out.push({ sectorKey, rec });
    }
    return out;
  }

  addBotMover(m: BotMover): void {
    this.movers.push(m);
  }

  /** Move an NPC bot to another sector; false when no director owns it. */
  moveBot(botId: string, fromSector: string, toSector: string, x: number, y: number): boolean {
    for (const m of this.movers) if (m(botId, fromSector, toSector, x, y)) return true;
    return false;
  }

  /** Send to a player in whichever registered room they are in. */
  sendToPlayer(playerId: string, type: string, msg: unknown): boolean {
    for (const room of this.rooms.values()) if (room.sendToPlayer(playerId, type, msg)) return true;
    return false;
  }

  addRequest(req: PairRequest): void {
    for (const [id, r] of this.requests) if (req.atMs - r.atMs > PAIR_REQUEST_TTL_MS) this.requests.delete(id);
    this.requests.set(req.id, req);
  }

  /** Take a pending request (it is answered once). */
  takeRequest(id: string, nowMs: number): PairRequest | null {
    const r = this.requests.get(id);
    if (!r) return null;
    this.requests.delete(id);
    return nowMs - r.atMs > PAIR_REQUEST_TTL_MS ? null : r;
  }

  clear(): void {
    this.rooms.clear();
    this.movers.length = 0;
    this.requests.clear();
  }
}

let _broker: TeleportBroker | null = null;

/** The process-wide broker (created on first use). */
export function getTeleportBroker(): TeleportBroker {
  return (_broker ??= new TeleportBroker());
}
