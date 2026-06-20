/**
 * PlayerShipStore — Phase 2 multi-ship roster.
 *
 * A player owns up to `ROSTER_CAP` (10) ships. Each ship is a persistent
 * identity with its own kind, health, last position, last sector. Ships
 * persist indefinitely (only the 10-cap evicts), unlike the legacy
 * `LimboStore` which auto-expired entries after a TTL.
 *
 * In-memory primary, persistence shadow on every mutation through the
 * existing `IPersistenceSink` CRITICAL lane (`PLAYER_SHIP_PUT` /
 * `PLAYER_SHIP_DELETE`). Boot hydration reads via the read-only
 * main-thread connection — same pattern as LimboStore — and seeds the
 * in-memory maps before the prune timer starts.
 *
 * Two indices: `byShip` (primary) and `byPlayer` (secondary, for roster
 * fetches). Both are maintained in lockstep; mutators always go through
 * `put`/`delete` to keep them aligned.
 *
 * Catalogue-version drift is handled at the `hydrate` boundary — see
 * `applyKindVersionDrift` below. The store itself stores whatever was
 * persisted; the drift correction runs once at hydrate so all post-boot
 * reads see corrected values.
 */
import type { IPersistenceSink } from '../../core/contracts/IPersistenceSink.js';
import {
  SHIP_KIND_CATALOGUE_VERSION,
  getShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';

/** Per-player roster cap. */
export const ROSTER_CAP = 10;

/** Default linger window applied when a ship goes active (player joins
 *  a sector room). On disconnect the room schedules eviction after this
 *  window, matching the LimboStore's 15-min behaviour. */
export const PLAYER_SHIP_ACTIVE_LINGER_MS = 900_000; // 15 min

/**
 * Phase 4 (Leveling & XP, WS-0). Per-ship spent stat-point allocation. Keyed
 * by a stat id (e.g. `hull`, `energy`, `damage`, `topSpeed`, `turnRate`,
 * `shield`); the value is the number of points spent on that stat. The exact
 * stat-id set + the per-point multiplier are owned by later workstreams
 * (WS-B2); WS-0 only persists the map. An empty `{}` means "no points spent".
 */
export type StatAlloc = Record<string, number>;

/**
 * Phase 4 (Leveling & XP, WS-0). One activated latent mount slot — the
 * dynamic-mounts feature (WS-B3) activates a ship-kind's candidate hardpoint
 * and binds a weapon to it. WS-0 only persists the list; the geometry for a
 * `slotId` is looked up client-side from the ship-kind catalogue (no geometry
 * on the wire), and the firing path is owned by WS-B3.
 */
export interface ActivatedMount {
  slotId: string;
  weaponId: string;
}

/** Returned when a player tries to spawn an 11th ship. */
export class RosterFullError extends Error {
  constructor(public readonly playerId: string) {
    super(`Player ${playerId} is at roster cap (${ROSTER_CAP}). Abandon a ship to make room.`);
    this.name = 'RosterFullError';
  }
}

export interface PlayerShipRecord {
  shipId: string;
  playerId: string;
  userId: string | null;
  kind: string;
  /** Catalogue version this record was last saved at. Drift handled on
   *  hydrate (see `applyKindVersionDrift`). */
  kindVersion: number;
  health: number;
  lastSectorKey: string;
  lastX: number;
  lastY: number;
  lastVx: number;
  lastVy: number;
  lastAngle: number;
  lastAngvel: number;
  lastFireClientTick: number;
  /** True while currently bound to a sector-room slot. False once the
   *  disconnect-linger window has expired and the ship has been moved
   *  back to "stored" state. */
  isActive: boolean;
  /** The Colyseus room id this ship is bound to when `isActive`. */
  activeRoomId: string | null;
  /** Disconnect-linger expiry. Only meaningful when `isActive` and the
   *  owning client has dropped; the prune sweep flips `isActive=false`
   *  and freezes pose at this point. Ignored when `isActive=false`. */
  expiresAt: number;
  /** Phase 4 (Leveling & XP, WS-0). Current level (≥ 1). A fresh ship is
   *  level 1; later workstreams (WS-B1) award XP from kills and increment
   *  this at curve thresholds. */
  level: number;
  /** Phase 4. Accumulated XP toward the next level (≥ 0). */
  xp: number;
  /** Phase 4. Spent stat-point allocation; `{}` = no points spent. */
  statAlloc: StatAlloc;
  /** Phase 4. Activated latent mount slots + bound weapons; `[]` = none. */
  mounts: ActivatedMount[];
  createdAt: number;
  updatedAt: number;
}

/** Subset of fields supplied when creating a fresh ship. */
export interface CreateShipInput {
  playerId: string;
  userId: string | null;
  kind: ShipKindId | string;
  sectorKey: string;
  x: number;
  y: number;
  /** Hull at spawn. Caller is responsible for clamping to kind's
   *  maxHealth — store doesn't know catalogue numerics beyond version. */
  health: number;
}

export interface PlayerShipStoreOpts {
  persistence?: IPersistenceSink;
  /** UUID generator override for tests. Production uses `crypto.randomUUID`. */
  generateShipId?: () => string;
  /** Wall clock override for tests. */
  now?: () => number;
}

export class PlayerShipStore {
  private readonly byShip = new Map<string, PlayerShipRecord>();
  private readonly byPlayer = new Map<string, Set<string>>();
  private readonly persistence: IPersistenceSink | undefined;
  private readonly generateShipId: () => string;
  private readonly nowFn: () => number;

  constructor(opts: PlayerShipStoreOpts = {}) {
    this.persistence = opts.persistence;
    this.generateShipId = opts.generateShipId ?? defaultUuid;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /** Create a new ship row for `playerId`. Throws `RosterFullError` when
   *  the player is at cap. Returns the freshly-built record. */
  create(input: CreateShipInput): PlayerShipRecord {
    const owned = this.byPlayer.get(input.playerId);
    if (owned !== undefined && owned.size >= ROSTER_CAP) {
      throw new RosterFullError(input.playerId);
    }
    const now = this.nowFn();
    const record: PlayerShipRecord = {
      shipId: this.generateShipId(),
      playerId: input.playerId,
      userId: input.userId,
      kind: input.kind,
      kindVersion: SHIP_KIND_CATALOGUE_VERSION,
      health: input.health,
      lastSectorKey: input.sectorKey,
      lastX: input.x,
      lastY: input.y,
      lastVx: 0,
      lastVy: 0,
      lastAngle: 0,
      lastAngvel: 0,
      lastFireClientTick: 0,
      isActive: false,
      activeRoomId: null,
      expiresAt: 0,
      level: 1,
      xp: 0,
      statAlloc: {},
      mounts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.put(record);
    return record;
  }

  /** Upsert a record by `shipId`. Used by `create`, `markActive`,
   *  `markStored`, `hydrate`. Keeps the secondary index in sync. */
  put(record: PlayerShipRecord, now: number = this.nowFn()): void {
    const existing = this.byShip.get(record.shipId);
    if (existing !== undefined && existing.playerId !== record.playerId) {
      // Ownership transfer — drop from old player's index.
      this.byPlayer.get(existing.playerId)?.delete(record.shipId);
    }
    const stamped: PlayerShipRecord = { ...record, updatedAt: now };
    this.byShip.set(stamped.shipId, stamped);
    let owned = this.byPlayer.get(stamped.playerId);
    if (owned === undefined) {
      owned = new Set<string>();
      this.byPlayer.set(stamped.playerId, owned);
    }
    owned.add(stamped.shipId);
    this.persistence?.enqueueCritical({
      type: 'PLAYER_SHIP_PUT',
      shipId: stamped.shipId,
      playerId: stamped.playerId,
      userId: stamped.userId,
      kind: stamped.kind,
      kindVersion: stamped.kindVersion,
      health: stamped.health,
      lastSectorKey: stamped.lastSectorKey,
      lastX: stamped.lastX,
      lastY: stamped.lastY,
      lastVx: stamped.lastVx,
      lastVy: stamped.lastVy,
      lastAngle: stamped.lastAngle,
      lastAngvel: stamped.lastAngvel,
      lastFireClientTick: stamped.lastFireClientTick,
      isActive: stamped.isActive,
      activeRoomId: stamped.activeRoomId,
      expiresAt: stamped.expiresAt,
      level: stamped.level,
      xp: stamped.xp,
      statAllocJson: JSON.stringify(stamped.statAlloc),
      mountsJson: JSON.stringify(stamped.mounts),
      ts: now,
    });
  }

  get(shipId: string): PlayerShipRecord | null {
    return this.byShip.get(shipId) ?? null;
  }

  listByPlayer(playerId: string): PlayerShipRecord[] {
    const ids = this.byPlayer.get(playerId);
    if (ids === undefined) return [];
    const out: PlayerShipRecord[] = [];
    for (const id of ids) {
      const rec = this.byShip.get(id);
      if (rec !== undefined) out.push(rec);
    }
    return out;
  }

  count(playerId: string): number {
    return this.byPlayer.get(playerId)?.size ?? 0;
  }

  /** Hard delete (abandon / scuttle). Returns true if a row was removed. */
  delete(shipId: string, now: number = this.nowFn()): boolean {
    const existing = this.byShip.get(shipId);
    if (existing === undefined) return false;
    this.byShip.delete(shipId);
    this.byPlayer.get(existing.playerId)?.delete(shipId);
    this.persistence?.enqueueCritical({
      type: 'PLAYER_SHIP_DELETE',
      shipId,
      ts: now,
    });
    return true;
  }

  /** Flip a ship to active state, bound to `roomId`. Caller passes the
   *  current pose so the row's last-known fields stay coherent across
   *  the active/stored boundary. */
  markActive(
    shipId: string,
    roomId: string,
    pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel: number; health: number; lastFireClientTick?: number },
    expiresAt: number = this.nowFn() + PLAYER_SHIP_ACTIVE_LINGER_MS,
  ): PlayerShipRecord | null {
    const existing = this.byShip.get(shipId);
    if (existing === undefined) return null;
    const next: PlayerShipRecord = {
      ...existing,
      isActive: true,
      activeRoomId: roomId,
      lastX: pose.x,
      lastY: pose.y,
      lastVx: pose.vx,
      lastVy: pose.vy,
      lastAngle: pose.angle,
      lastAngvel: pose.angvel,
      health: pose.health,
      lastFireClientTick: pose.lastFireClientTick ?? existing.lastFireClientTick,
      expiresAt,
    };
    this.put(next);
    return next;
  }

  /** Flip a ship to stored state and freeze pose at the supplied values. */
  markStored(
    shipId: string,
    pose: { x: number; y: number; vx: number; vy: number; angle: number; angvel: number; health: number; lastFireClientTick?: number; sectorKey?: string },
  ): PlayerShipRecord | null {
    const existing = this.byShip.get(shipId);
    if (existing === undefined) return null;
    const next: PlayerShipRecord = {
      ...existing,
      isActive: false,
      activeRoomId: null,
      lastX: pose.x,
      lastY: pose.y,
      lastVx: pose.vx,
      lastVy: pose.vy,
      lastAngle: pose.angle,
      lastAngvel: pose.angvel,
      health: pose.health,
      lastFireClientTick: pose.lastFireClientTick ?? existing.lastFireClientTick,
      lastSectorKey: pose.sectorKey ?? existing.lastSectorKey,
      expiresAt: 0,
    };
    this.put(next);
    return next;
  }

  /**
   * Boot-time rehydrate from on-disk rows. Pure in-memory write — does NOT
   * shadow through the sink (the rows already live there). Applies the
   * catalogue-version drift correction in-line so all post-boot reads see
   * `kindVersion === SHIP_KIND_CATALOGUE_VERSION` and `health <=
   * currentKind.maxHealth`.
   */
  hydrate(rows: ReadonlyArray<PlayerShipRecord>, now: number = this.nowFn()): void {
    for (const row of rows) {
      const corrected = applyKindVersionDrift(row);
      this.byShip.set(corrected.shipId, corrected);
      let owned = this.byPlayer.get(corrected.playerId);
      if (owned === undefined) {
        owned = new Set<string>();
        this.byPlayer.set(corrected.playerId, owned);
      }
      owned.add(corrected.shipId);
      // If the drift correction changed anything, persist the updated row so
      // the next hydrate is a no-op.
      if (corrected !== row) {
        this.persistence?.enqueueCritical({
          type: 'PLAYER_SHIP_PUT',
          shipId: corrected.shipId,
          playerId: corrected.playerId,
          userId: corrected.userId,
          kind: corrected.kind,
          kindVersion: corrected.kindVersion,
          health: corrected.health,
          lastSectorKey: corrected.lastSectorKey,
          lastX: corrected.lastX,
          lastY: corrected.lastY,
          lastVx: corrected.lastVx,
          lastVy: corrected.lastVy,
          lastAngle: corrected.lastAngle,
          lastAngvel: corrected.lastAngvel,
          lastFireClientTick: corrected.lastFireClientTick,
          isActive: corrected.isActive,
          activeRoomId: corrected.activeRoomId,
          expiresAt: corrected.expiresAt,
          level: corrected.level,
          xp: corrected.xp,
          statAllocJson: JSON.stringify(corrected.statAlloc),
          mountsJson: JSON.stringify(corrected.mounts),
          ts: now,
        });
      }
    }
  }

  size(): number {
    return this.byShip.size;
  }
}

/**
 * Returning-player drift safety. If a stored ship was saved against an older
 * catalogue version, fast-forward to the current version:
 *   - Re-resolve the kind. The id set is append-only (invariant #11) so the
 *     lookup never fails; `getShipKind` falls back to DEFAULT_SHIP_KIND
 *     defensively.
 *   - Clamp `health` to the current `maxHealth` — never strip earned damage,
 *     never gift hull above the new cap.
 *   - Stamp `kindVersion` to current so the next hydrate is a no-op.
 *
 * Other numeric stats (speed, angvel, damping, grip, thrust) are not
 * cached on the row — they're read live off the catalogue per frame via
 * `getShipKind(record.kind)`, so the new values take effect automatically.
 * Returns the same reference when nothing changed, otherwise a fresh
 * record (callers can `===` to detect drift).
 */
export function applyKindVersionDrift(row: PlayerShipRecord): PlayerShipRecord {
  if (row.kindVersion >= SHIP_KIND_CATALOGUE_VERSION) return row;
  const kind = getShipKind(row.kind);
  const clampedHealth = Math.min(row.health, kind.maxHealth);
  return {
    ...row,
    health: clampedHealth,
    kindVersion: SHIP_KIND_CATALOGUE_VERSION,
  };
}

/** crypto.randomUUID is available on Node 19+ and modern browsers. */
function defaultUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for very old runtimes; not cryptographically strong but unique
  // enough for ship-id space. Production targets Node 20+.
  return (
    Math.random().toString(16).slice(2, 10) + '-' +
    Math.random().toString(16).slice(2, 6) + '-' +
    Math.random().toString(16).slice(2, 6) + '-' +
    Math.random().toString(16).slice(2, 6) + '-' +
    Math.random().toString(16).slice(2, 14)
  );
}
