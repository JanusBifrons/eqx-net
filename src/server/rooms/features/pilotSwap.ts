/**
 * Phase 4 WS-A2 — same-sector instant pilot swap: take or let go of a hull's
 * controls IN-ROOM. `displaceActiveHullToLingering` parks the pilot's active
 * hull as a lingering (AI-flown) hull; `reclaimLingeringHull` (the
 * `pilot_ship` message, `features/pilotMessages.ts`) makes one of their own
 * parked hulls active again. `shipKeyMoved` is THE one re-key seam both call.
 * Moved verbatim out of `SectorRoom`. The room hands in live accessors
 * (`() => value` for fields it reassigns); built once (#14). Discrete
 * events only, never per tick.
 */
import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import type { Bus } from '../../../core/events/Bus.js';
import { isEngageablePilotHull } from '../../../core/entity/shipLiveness.js';
import { effectiveShipShieldMax, type StatAlloc as CoreStatAlloc } from '../../../core/leveling/shipStats.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import { factionLooksWelcomeField } from '../../../shared-types/factions.js';
import type { WelcomeMessage } from '../../../shared-types/messages.js';
import type { ShellSalvo } from '../../../shared-types/messages/shellEvents.js';
import {
  TICK_IDX, SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF, slotBase,
} from '../../../shared-types/sabLayout.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import type { TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { CutFieldSubsystem } from '../CutFieldSubsystem.js';
import {
  CLIENT_READY_TIMEOUT_TICKS, JOIN_BROADCAST_GRACE_TICKS, withShipScale,
  type PendingJoinRecord, type WreckWelcomeFields,
} from '../join/joinConstants.js';
import type { LockSubsystem } from '../LockSubsystem.js';
import type { NpcLockSubsystem } from '../NpcLockSubsystem.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { RosterPersistence } from '../RosterPersistence.js';
import type { SectorState, ShipState } from '../schema/SectorState.js';
import type { WeaponMountTicker } from '../WeaponMountTicker.js';
import type { WingmanPilots } from './wingmanPilots.js';

/** What the pilot swap needs from the room; getters read the live field. */
export interface PilotSwapHost {
  state(): Pick<SectorState, 'ships'>;
  sectorKey(): string | null;
  sabF32(): Float32Array;
  sabU32(): Uint32Array;
  playerToSlot(): Map<string, number>;
  slotToPlayer(): Map<number, string>;
  pendingJoin(): Map<string, PendingJoinRecord>;
  setForceBroadcastUntilTick(tick: number): void;
  playerToActiveShipInstance: Map<string, string>;
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  ownerlessShips: Map<string, ReturnType<typeof setTimeout> | null>;
  spectateParkedHull: Map<string, string>;
  pendingCommandStart: Set<string>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  lastFireClientTick: Map<string, number>;
  playerToUser: ReadonlyMap<string, string | null>;
  fleet: Pick<FleetCommandSubsystem, 'isAttached' | 'shipKeyMoved'>;
  locks(): LockSubsystem;
  wingmanLocks(): LockSubsystem;
  npcLocks(): Pick<NpcLockSubsystem, 'forget'>;
  wingmen(): Pick<WingmanPilots, 'attachWingman' | 'detachWingman' | 'wingmanFireKeys'>;
  mountTicker(): Pick<WeaponMountTicker, 'shipKeyMoved'>;
  transitOrchestrator(): Pick<TransitOrchestrator, 'noteTakeControls'> | null;
  rosterPersistence(): Pick<RosterPersistence, 'markLinger' | 'bind'>;
  cutField(): Pick<CutFieldSubsystem, 'welcome'> | undefined;
  bus(): Pick<Bus, 'emit'>;
  logger: Pick<Logger, 'info'>;
  getActiveShip(playerId: string): ShipState | undefined;
  postToWorker(cmd: WorkerCmd): void;
  applyStatMulToWorker(bodyKey: string, alloc: CoreStatAlloc | undefined): void;
  shipHullMax(kindMax: number, alloc: CoreStatAlloc | undefined, shipInstanceId: string): number;
  shellWelcomeFields(client: Client, playerId: string): { shellEvents?: true; shellsInFlight?: ShellSalvo[] };
  wreckWelcomeFields(): WreckWelcomeFields;
}

export class PilotSwap {
  constructor(private readonly h: PilotSwapHost) {}

  // ── Spectate-parked hulls: who NPC fire control engages (moved from SectorRoom) ──
  /** Reused result of `engageablePilotHull` (#14). */
  private readonly _engageable: { ship: ShipState; pose: ShipPhysicsState } = {
    ship: undefined as unknown as ShipState, pose: undefined as unknown as ShipPhysicsState,
  };

  /**
   * The hull NPC fire control engages on pilot `playerId`'s behalf, with its
   * pose: liveness classes per `isEngageablePilotHull` (ACTIVE, or the
   * LINGERING hull they parked by Spectate). TRAVELLING is not excluded (as
   * before for these callers). Null when there is none. The result object is
   * shared: read it before the next call.
   */
  engageablePilotHull(playerId: string): { ship: ShipState; pose: ShipPhysicsState } | null {
    const out = this._engageable;
    const active = this.h.getActiveShip(playerId);
    if (active !== undefined) {
      // Flying a hull again (respawn, rejoin, reclaim): no longer spectating.
      if (this.h.spectateParkedHull.size > 0) this.h.spectateParkedHull.delete(playerId);
      const pose = this.h.shipPoseCache.get(playerId);
      // A reclaimed parked hull stays in the world through its join handshake
      // (`inWorld`, as others keep seeing it): taking its controls must not
      // drop the AI pilots' locks on it.
      const inWorld = this.h.pendingJoin().size > 0 &&this.h.pendingJoin().get(playerId)?.inWorld === true;
      if (!pose || !isEngageablePilotHull(active, inWorld)) return null;
      out.ship = active; out.pose = pose;
      return out;
    }
    const sid = this.h.spectateParkedHull.get(playerId);
    if (sid === undefined) return null;
    const ship = this.h.state().ships.get(sid);
    const pose = this.h.lingeringPoseCache.get(sid);
    if (!ship || !pose || !this.h.lingeringSlots.has(sid) || ship.playerId !== playerId) {
      this.h.spectateParkedHull.delete(playerId);
      return null;
    }
    if (!isEngageablePilotHull(ship, true)) return null;
    out.ship = ship; out.pose = pose;
    return out;
  }

  /**
   * The player's own ship here, for its hold (packed stock, the build gate):
   * the hull they fly, else the hull they parked by Command / Build while it
   * still lingers here and is theirs. A Quick Launch lands in Command view and
   * Build always lets go of the ship, so the starter crate sits in a PARKED hull.
   */
  ownShipKey(playerId: string): string | undefined {
    const active = this.h.playerToActiveShipInstance.get(playerId);
    if (active !== undefined) return active;
    const sid = this.h.spectateParkedHull.get(playerId);
    if (sid === undefined || !this.h.lingeringSlots.has(sid)) return undefined;
    return this.h.state().ships.get(sid)?.playerId === playerId ? sid : undefined;
  }

  /** WeaponMountTicker dep: visit every connected pilot's spectate-parked
   *  hull under the PILOT's id (so the capital's per-pilot NPC lock and the
   *  drone's `hostileTo` both key it). Bound once (#14). */
  readonly visitParkedPilotHulls = (
    visit: (pid: string, x: number, y: number, vx: number, vy: number, kindId: string, angle: number, shieldUp: boolean) => void,
  ): void => {
    if (this.h.spectateParkedHull.size === 0) return;
    for (const pid of this.h.spectateParkedHull.keys()) {
      if (this.h.getActiveShip(pid) !== undefined) continue; // covered by the ACTIVE pass
      const h = this.engageablePilotHull(pid);
      if (h) visit(pid, h.pose.x, h.pose.y, h.pose.vx, h.pose.vy, h.ship.kind, h.pose.angle, h.ship.shield > 0);
    }
  };

  /**
   * A player ship's key moved (playerId ↔ shipInstanceId; lock key
   * `p:<playerId>` ↔ `p:<shipInstanceId>`): its owner took or let go of its
   * controls. The ONE seam for it, called where the server re-keys the hull
   * (`displaceActiveHullToLingering`, `reclaimLingeringHull`). Everything that
   * names the ship by that key follows it:
   *  - every lock on the ship, in both player lock machines, and its own locks
   *    (`fromLocks` → `toLocks`, null = nobody flies it: they drop). See
   *    `LockSubsystem.shipKeyMoved`;
   *  - fleet references: attack orders, chases, retaliation targets
   *    (`FleetCommandSubsystem.shipKeyMoved`);
   *  - its turret angles and sticky target (`WeaponMountTicker.shipKeyMoved`),
   *    so the turrets never snap home on a hand-over.
   * Never add a second re-key path: extend this one.
   */
  private shipKeyMoved(from: string, to: string, fromLocks: LockSubsystem, toLocks: LockSubsystem | null): void {
    fromLocks.shipKeyMoved(from, to, toLocks);
    // Locks held on the ship in the sibling machine, when it isn't `toLocks`.
    const sibling = fromLocks === this.h.locks() ? this.h.wingmanLocks() : this.h.locks();
    if (toLocks !== sibling) sibling.shipKeyMoved(from, to, sibling);
    // AI pilots' cached target → lock key (`wingmanLockKey`) may name the old key.
    this.h.wingmen().wingmanFireKeys.clear();
    this.h.fleet.shipKeyMoved(from, to);
    this.h.mountTicker().shipKeyMoved(from, to);
  }

  // ── Phase 3 multi-ship roster (dual-write) ─────────────────────────────
  //
  // The room mirrors every spawn / linger / evict / destroy into
  // `PlayerShipStore`. LimboStore continues to drive the spawn-restore
  // logic; PlayerShipStore is the source of truth for the per-player
  // roster card list shown by the galaxy-map UI. Phase 4 plans to fold
  // these into one path with shipId-based join binding.
  //
  // Galaxy rooms only (sectorKey !== null). Engineering rooms have no
  // persistent identity and skip the dual-write entirely.

  private markRosterLinger(
    shipInstanceId: string,
    pose: {
      x: number; y: number; vx: number; vy: number; angle: number; angvel: number;
      health: number; lastFireClientTick: number;
    },
  ): void {
    this.h.rosterPersistence().markLinger(shipInstanceId, pose);
  }

  /**
   * Displace the player's CURRENT active hull into a lingering hull, IN-ROOM —
   * the inverse partner of `reclaimLingeringHull`. Mirrors the onJoin
   * fresh-spawn-displaces branch EXACTLY (the rekey/abandon identity invariant):
   * REKEY the worker body `playerId` → `linger-<shipInstanceId>`, move the slot
   * from `playerToSlot`/`slotToPlayer` into `lingeringSlots`, freeze the roster
   * row at the LIVE SAB pose (`markLinger`), record a persist-forever ownerless
   * marker (`null`), clear `playerToActiveShipInstance`, and flip `isActive=false`
   * so the snapshot loop renders it as a parked hull. The schema entry STAYS
   * (keyed by shipInstanceId) so the displaced hull keeps broadcasting. No-op when
   * the player has no live active hull (the spectator case).
   */
  displaceActiveHullToLingering(playerId: string): void {
    const ship = this.h.getActiveShip(playerId);
    const slot = this.h.playerToSlot().get(playerId);
    if (ship === undefined || slot === undefined || ship.shipInstanceId === '') return;
    if (!ship.alive) return;
    const shipInstanceId = ship.shipInstanceId;
    const b = slotBase(slot);
    // Freeze the roster row + lingering pose cache at the LIVE SAB pose so a
    // later reclaim / restore lands at where the hull actually is.
    const livePose = {
      x:      this.h.sabF32()[b + SLOT_X_OFF]!,
      y:      this.h.sabF32()[b + SLOT_Y_OFF]!,
      vx:     this.h.sabF32()[b + SLOT_VX_OFF]!,
      vy:     this.h.sabF32()[b + SLOT_VY_OFF]!,
      angle:  this.h.sabF32()[b + SLOT_ANGLE_OFF]!,
      angvel: this.h.sabF32()[b + SLOT_ANGVEL_OFF]!,
    };
    this.markRosterLinger(shipInstanceId, {
      ...livePose,
      health: ship.health,
      lastFireClientTick: this.h.lastFireClientTick.get(playerId) ?? 0,
    });
    this.h.lingeringPoseCache.set(shipInstanceId, { ...livePose });
    // Slot moves from the active maps to the lingering map; the worker body is
    // rekeyed so its per-tick SAB write keeps landing in the (now-lingering) slot
    // (the 2026-05-13 orphan-body push bug — see the onJoin displace branch).
    this.h.lingeringSlots.set(shipInstanceId, slot);
    this.h.playerToSlot().delete(playerId);
    this.h.slotToPlayer().delete(slot);
    this.h.ownerlessShips.set(shipInstanceId, null);
    this.h.playerToActiveShipInstance.delete(playerId);
    ship.isActive = false;
    this.h.postToWorker({ type: 'REKEY_SHIP', oldId: playerId, newId: `linger-${shipInstanceId}` });
    this.h.wingmen().attachWingman(shipInstanceId);
    // Same ship, new key: its locks (held on it and its own) follow it to the AI pilot.
    this.shipKeyMoved(playerId, shipInstanceId, this.h.locks(), this.h.fleet.isAttached(shipInstanceId) ? this.h.wingmanLocks() : null);
    serverLogEvent('pilot_swap_displaced', { playerId, shipInstanceId, sectorKey: this.h.sectorKey() });
  }

  /**
   * Reclaim one of the player's OWN lingering hulls parked in THIS sector and
   * make it their active hull — the server half of the in-world Pilot action
   * (Phase 4 WS-A2). SAME-SECTOR INSTANT swap: no leave/rejoin, no spool, no
   * curtain. The hull keeps its LIVE pose; only its visibility + the session
   * binding change.
   *
   * Owner-gated by construction:
   *   - the target must be a `lingeringSlots` entry (a DISPLACED / combat-death /
   *     boot-reconstructed lingering hull) present in THIS room,
   *   - whose schema entry is owned by `playerId` and `isActive=false` (a hull
   *     someone else is piloting is `isActive=true` and never in `lingeringSlots`,
   *     so a request for a foreign / active hull is dropped here),
   *   - in a galaxy room, the roster row must be owned by `playerId` too. A room
 *     with no sector key (engineering / test rooms) keeps no roster: the schema
 *     and `lingeringSlots` checks above are the whole gate there, and the hull
 *     keeps its live alloc / mounts (nothing to re-read).
   *
   * On success: the player's current active hull (if any) is displaced first,
   * then the target body is rekeyed `linger-<id>` → `playerId`, its slot moves
   * back into the active maps, the lingering bookkeeping is torn down, the roster
   * row is `markActive`'d at the live pose, and a fresh `welcome` re-anchors the
   * client (which then clears spectator + smooth-lerps the camera + re-enables
   * self-prediction). Routed through the unified `pendingJoin` handshake so
   * `client_ready` → `warp_in` → arrivalTick → `isActive=true` exactly as a
   * rebind does (no second activation path — Invariant #12).
   */
  reclaimLingeringHull(client: Client, playerId: string, shipId: string): void {
    const target = this.h.state().ships.get(shipId);
    const slot = this.h.lingeringSlots.get(shipId);
    // Validate: a lingering hull (isActive=false), present in this room, owned
    // by the requester, alive. A foreign / active / unknown id falls through.
    if (target === undefined || slot === undefined) return;
    if (target.playerId !== playerId || target.isActive || !target.alive) return;
    if (target.shipInstanceId !== shipId || shipId === '') return;
    // Defence-in-depth: the roster row must be owned by this player too. Rooms
    // with no sector key keep no roster (`rec` stays null; the checks above gate).
    const rec = this.h.sectorKey() === null ? null : getPlayerShipStore().get(shipId);
    if (this.h.sectorKey() !== null && (rec === null || rec.playerId !== playerId)) return;
    const lastFireClientTick = rec?.lastFireClientTick ?? this.h.lastFireClientTick.get(playerId) ?? 0;

    // The ship AI pilots engage as this pilot right now (flown, or parked by Spectate).
    const engagedBefore = this.h.getActiveShip(playerId)?.shipInstanceId ?? this.h.spectateParkedHull.get(playerId);
    // Displace the player's current active hull (if they were piloting one) into
    // a lingering hull, so they don't keep two active hulls.
    this.displaceActiveHullToLingering(playerId);
    // Piloting again: they are no longer spectating a parked hull.
    this.h.spectateParkedHull.delete(playerId);
    this.h.pendingCommandStart.delete(playerId);

    // Reclaim the target's slot from the lingering maps back into the active maps.
    const b = slotBase(slot);
    const livePose = {
      x:      this.h.sabF32()[b + SLOT_X_OFF]!,
      y:      this.h.sabF32()[b + SLOT_Y_OFF]!,
      vx:     this.h.sabF32()[b + SLOT_VX_OFF]!,
      vy:     this.h.sabF32()[b + SLOT_VY_OFF]!,
      angle:  this.h.sabF32()[b + SLOT_ANGLE_OFF]!,
      angvel: this.h.sabF32()[b + SLOT_ANGVEL_OFF]!,
    };
    // Same ship, new key: its locks (held on it and its own) follow it from the
    // AI pilot to the owner, BEFORE `detachWingman` forgets the AI pilot's.
    this.shipKeyMoved(shipId, playerId, this.h.wingmanLocks(), this.h.locks());
    // AI pilots' locks on this pilot name the pilot, not a ship: they hold on
    // only if the pilot stays with the ship they were on.
    if (engagedBefore !== shipId) this.h.npcLocks().forget(playerId);
    // RTS fleet warp (owner rule): taking the controls of a spooling ship keeps
    // it in the warp and the pilot goes with them; tell the orchestrator before
    // the detach below reaches its drop point.
    this.h.transitOrchestrator()?.noteTakeControls(playerId, shipId);
    // The owner takes the helm: a squad member stays in its squad, which forms
    // up on it (pilot-led) and gets it back as AI leader on release (4b).
    this.h.wingmen().detachWingman(shipId, true);
    this.h.lingeringSlots.delete(shipId);
    this.h.lingeringPoseCache.delete(shipId);
    const ownerlessTimer = this.h.ownerlessShips.get(shipId);
    if (ownerlessTimer) clearTimeout(ownerlessTimer); // R2.26: persist-forever marker is null
    this.h.ownerlessShips.delete(shipId);
    this.h.playerToSlot().set(playerId, slot);
    this.h.slotToPlayer().set(slot, playerId);
    this.h.playerToActiveShipInstance.set(playerId, shipId);
    // REKEY the worker body `linger-<id>` → `playerId` so input + the per-tick
    // SAB write resume under the player's key (the displace inverse).
    this.h.postToWorker({ type: 'REKEY_SHIP', oldId: `linger-${shipId}`, newId: playerId });
    // Phase 4 WS-B2 — re-seed the reclaimed hull's stat allocation + push its
    // physics multipliers under the new (playerId) body key so the resumed
    // prediction scales movement by the upgraded factors from the first tick.
    if (rec !== null) target.statAlloc = rec.statAlloc ?? {};
    this.h.applyStatMulToWorker(playerId, target.statAlloc);
    // Review must-fix #1 — recompute the NON-PHYSICS caps from the (re-read)
    // alloc so the reclaimed hull's maxHull/shield match its current upgrade,
    // and clamp the live hull/shield down to the new max (a respec that lowers
    // a cap must not leave the current value above it). One source: the
    // `effectiveShip*` helpers.
    const reclaimKind = getShipKind(target.kind);
    target.maxHealth = this.h.shipHullMax(reclaimKind.maxHealth, target.statAlloc, target.shipInstanceId);
    if (target.health > target.maxHealth) target.health = target.maxHealth;
    const reclaimShieldMax = effectiveShipShieldMax(reclaimKind.shieldMax, target.statAlloc);
    if (target.shield > reclaimShieldMax) target.shield = reclaimShieldMax;
    // WS-B3 — re-seed the reclaimed hull's activated dynamic mounts so it fires
    // + renders its extra turrets from the first tick under the new body key.
    if (rec !== null) target.mounts = rec.mounts ?? [];
    // Seed the pose cache + roster so any synchronous reader + a later restore
    // see the live pose (NOT a stale abandon pose — WS-A2 "lands at its live pose").
    this.h.shipPoseCache.set(playerId, { ...livePose });
    this.h.lastFireClientTick.set(playerId, lastFireClientTick);
    // `markActive` the roster row at the live pose (the design's "reuse the
    // markActive machinery"). bind() with the preferred shipId hits markActive
    // (a no-op in a room with no sector key).
    this.h.rosterPersistence().bind(playerId, this.h.playerToUser.get(playerId) ?? rec?.userId ?? null, target.kind, {
      ...livePose,
      health: target.health,
      lastFireClientTick,
    }, shipId);
    this.h.shipPoseCache.set(playerId, { ...livePose });

    // Re-drive the unified join handshake so visibility flips through the SAME
    // `client_ready` → `warp_in` → arrivalTick path a rebind uses (no second
    // activation path). The hull stays at its live pose (no SAB reset).
    const tick = Atomics.load(this.h.sabU32(), TICK_IDX);
    target.isActive = false;
    const welcome: WelcomeMessage = {
      type: 'welcome',
      playerId,
      serverTick: tick,
      sectorKey: this.h.sectorKey(),
      shipInstanceId: shipId,
    };
    client.send('welcome', withShipScale({ ...welcome, ...this.h.shellWelcomeFields(client, playerId), ...this.h.wreckWelcomeFields(), ...this.h.cutField()?.welcome, ...factionLooksWelcomeField() }));
    this.h.pendingJoin().set(playerId, {
      joinTick: tick,
      watchdogTick: tick + CLIENT_READY_TIMEOUT_TICKS,
      arrivalTick: null,
      spawnX: livePose.x,
      spawnY: livePose.y,
      sessionId: client.sessionId,
      inWorld: true,
    });
    this.h.setForceBroadcastUntilTick(tick + JOIN_BROADCAST_GRACE_TICKS);
    this.h.bus().emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: livePose.x, y: livePose.y });
    serverLogEvent('pilot_swap_reclaimed', { playerId, shipInstanceId: shipId, sectorKey: this.h.sectorKey(), x: livePose.x, y: livePose.y });
    auditEvent({ event: 'player_joined', sector: this.h.sectorKey() ?? undefined, playerId });
    this.h.logger.info({ playerId, shipInstanceId: shipId, sectorKey: this.h.sectorKey() }, 'pilot swap — reclaimed lingering hull in-room');
  }
}
