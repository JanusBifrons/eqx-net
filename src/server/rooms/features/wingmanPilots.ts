/**
 * RTS — AI pilots on lingering hulls: attach / detach, the owner's orders,
 * modes and stances reaching the AI pilot brain, the hull's control keys,
 * and the ~10 Hz target step and per-tick fire of every AI-flown hull. The
 * room-side half of the fleet (`FleetCommandSubsystem` keeps the orders and
 * squads; this flies them). Moved verbatim out of `SectorRoom`; the room
 * hands in live accessors. Per-tick path (#14): the scratch poses, the pack
 * ids and the INPUT command are allocated once, here.
 */
import type { MapSchema } from '@colyseus/schema';
import type { AiController } from '../../../core/ai/AiController.js';
import { HostileDroneBehaviour } from '../../../core/ai/HostileDroneBehaviour.js';
import { decodeAiInputBits, type AiEntityPoseOut, type AiInputBits, type IAiBehaviour } from '../../../core/contracts/IAiBehaviour.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import { hasTurretFireControl } from '../../../core/combat/mountReach.js';
import type { FleetOrder } from '../../../shared-types/messages/fleetStatusMessages.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { PLAYERS_SIDE } from '../../../shared-types/allegiances.js';
import { SWARM_KIND_DRONE } from '../../../shared-types/swarmWireFormat.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF } from '../../../shared-types/sabLayout.js';
import { pilotKindFor, type FleetCommandSubsystem, type FleetPose, type FleetShipOrders } from '../../fleet/FleetCommandSubsystem.js';
import { clearFleetOrder, defendAt, stepFleetPatrol } from '../../fleet/fleetShipOrders.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { TransitOrchestrator } from '../../transit/TransitOrchestrator.js';
import type { ShipState } from '../schema/SectorState.js';
import type { LockSubsystem } from '../LockSubsystem.js';
import type { WeaponMountTicker } from '../WeaponMountTicker.js';
import type { PlayerFireResolver } from '../PlayerFireResolver.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';

/** RTS slice 4b — `fleet.detach` options when the owner takes a member's helm. */
const KEEP_SQUAD = Object.freeze({ keepSquad: true });
/** RTS Part B: an owned hull's AI controller registration (keys as pilot
 *  INPUT, no AI fire path). */
const HULL_AI_REGISTRATION = Object.freeze({ hull: true });

/** What the wingman pilots need from the room; getters read the live field. */
export interface WingmanPilotsHost {
  state(): { ships: MapSchema<ShipState> };
  fleet: FleetCommandSubsystem;
  lingeringSlots: ReadonlyMap<string, number>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  playerToActiveShipInstance: ReadonlyMap<string, string>;
  playerToSlot(): ReadonlyMap<string, number>;
  boostingPlayers: Set<string>;
  lastFireClientTick: Map<string, number>;
  lockActivated(): Map<string, unknown>;
  swarmRegistry: Pick<SwarmEntityRegistry, 'get' | 'getByEntityId'>;
  sabF32(): Float32Array;
  serverTick(): number;
  aiController(): AiController;
  wingmanLocks(): LockSubsystem;
  locks(): Pick<LockSubsystem, 'isInstant'>;
  mountTicker(): Pick<WeaponMountTicker, 'playerMountAngles' | 'tickHull'>;
  playerFireResolver(): Pick<PlayerFireResolver, 'fireHull'>;
  transitOrchestrator(): Pick<TransitOrchestrator, 'dropHull'> | null;
  postToWorker(cmd: WorkerCmd): void;
  getActiveShip(playerId: string): ShipState | undefined;
  swarmEntityPoseInto(id: string, out: AiEntityPoseOut): boolean;
  resolveActiveShipKey(playerId: string): string | undefined;
  fleetStatusSoonFor(playerId: string): void;
}

export class WingmanPilots {
  constructor(private readonly h: WingmanPilotsHost) {}

  /** Scratch for a wingman attack target's pose (#14). */
  readonly wingmanTargetPose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  /** Scratch: a pack's member ids for `setFlockFollow` (it copies them). */
  private readonly hullPackIds: string[] = [];
  /** Reused wingman INPUT command (postMessage clones synchronously, #14). */
  private readonly wingmanInputCmd: Extract<WorkerCmd, { type: 'INPUT' }> = {
    type: 'INPUT', slot: 0, inputTick: 0, thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false,
  };

  /** Fleet hook: an owner's order reached the AI pilot brain flying hull `id`.
   *  Move (slice 9): travel there, shooting only what is in its sights on
   *  the way, then guard the point (`completeHullTravel` completes the
   *  order). Stop: brake to a halt and guard the spot (the guard leash,
   *  slice 5). Attack (slice 8): the target gets priority in the brain's
   *  pick (`syncHullOrder`); the post stays, so the ship goes back to it
   *  (an attack that replaces a Move holds where the hull is). */
  orderIssued(id: string, order: Readonly<FleetOrder>): void {
    const brain = this.h.aiController().getBehaviour(id);
    if (brain === null) return;
    this.syncHullOrder(brain, order);
    if (order.kind === 'move') {
      if (brain.setTravel !== undefined) brain.setTravel(order.x, order.y);
      else this.holdHullAt(brain, order.x, order.y);
      return;
    }
    const p = this.h.lingeringPoseCache.get(id);
    if (p === undefined) return;
    if (order.kind === 'stop') {
      if (brain.stopAt !== undefined) brain.stopAt(p.x, p.y, p.vx, p.vy);
      else this.holdHullAt(brain, p.x, p.y);
    } else if (brain.getTravelState?.() === 1) this.holdHullAt(brain, p.x, p.y);
  }

  // ── RTS — AI pilots on lingering hulls ────────────────────────────────────

  /**
   * Hand a just-parked lingering hull to an AI pilot (fresh orders: Defend
   * at its current spot, Defensive stance). Call right AFTER the hull's
   * `lingeringSlots.set` and any `REKEY_SHIP` / `SPAWN` for its body, so the
   * fresh (neutral) controls posted here land after the rekey cleared the
   * slot's held input. Re-attaching replaces the brain. No-op under
   * `EQX_DISABLE_WINGMEN`.
   */
  attachWingman(shipInstanceId: string): void {
    const ship = this.h.state().ships.get(shipInstanceId);
    const slot = this.h.lingeringSlots.get(shipInstanceId);
    if (ship === undefined || slot === undefined || this.h.fleet.isDisabled) return;
    const b = slotBase(slot);
    this.h.fleet.attach(
      shipInstanceId,
      ship.playerId,
      { kind: getShipKind(ship.kind) },
      { x: this.h.sabF32()[b + SLOT_X_OFF]!, y: this.h.sabF32()[b + SLOT_Y_OFF]! },
    );
    // RTS slice 5: the hull locks and fires through the player pipeline. Its
    // groups start in MAN (the stance picks targets); the owner's testMode
    // `instantLock` carries over. Fresh locks on every (re)attach.
    if (this.h.fleet.isAttached(shipInstanceId)) {
      this.h.wingmanLocks().forget(shipInstanceId);
      this.h.wingmanLocks().enable(shipInstanceId, this.h.locks().isInstant(ship.playerId), 'manual');
      // RTS Part B: the shared AI pilot brain flies the hull (players side,
      // the owner's, the hull's one energy pool), from the kind as this ship
      // flies it (upgrades in). It holds where it was parked: with no post an
      // idle brain orbits the world origin. The fleet keeps only the ship's
      // orders (data) and squad; this brain is the one that flies.
      const brain = new HostileDroneBehaviour(pilotKindFor(getShipKind(ship.kind), ship.statAlloc), {
        side: PLAYERS_SIDE, ownerId: ship.playerId, energyPool: ship,
      });
      this.holdHullAt(brain, this.h.sabF32()[b + SLOT_X_OFF]!, this.h.sabF32()[b + SLOT_Y_OFF]!);
      this.h.aiController().unregister(shipInstanceId);
      this.h.aiController().register(shipInstanceId, slot, brain, HULL_AI_REGISTRATION);
      // The ship's standing mode and attitude (a restored Hunt / Aggressive).
      this.applyHullMode(shipInstanceId);
      this.applyHullStance(shipInstanceId);
      // The unregister above cleared every guard post anchored to this ship.
      this.reapplyEscortsOf(shipInstanceId);
    }
    // Fresh neutral controls until the AI pilot's first keys arrive.
    const cmd = this.wingmanInputCmd;
    cmd.slot = slot;
    cmd.inputTick = this.h.serverTick();
    cmd.thrust = false; cmd.turnLeft = false; cmd.turnRight = false; cmd.boost = false; cmd.reverse = false;
    this.h.postToWorker(cmd);
    this.hullHeldBits.set(shipInstanceId, 0);
  }

  /** RTS Part B slice 9: the travel half of order completion (the attack
   *  half is in `tickWingmanTargets`, slice 8). A Move whose travel ended
   *  (arrived, or replaced in the brain) is done: the fleet orders' post
   *  becomes the point and the mode resumes from there (`applyHullMode`:
   *  Defend guards it, Hunt searches from it, Retreat carries on). A Stop
   *  is done at once: Defend the halt spot (the old wingman's rule; a squad
   *  member just clears it). A Retreat that arrived defends its point. Each
   *  sends the owner's status soon. */
  completeHullTravel(i: number, sid: string, hb: IAiBehaviour): void {
    const fleet = this.h.fleet;
    const w = fleet.ordersAt(i);
    const o = w.order;
    const travel = hb.getTravelState!();
    if (o !== null && o.kind === 'move') {
      if (travel === 1) return;
      clearFleetOrder(w);
      w.guardPostX = o.x;
      w.guardPostY = o.y;
      this.applyHullMode(sid);
    } else if (o !== null && o.kind === 'stop') {
      clearFleetOrder(w);
      if (fleet.squadFollowOf(sid) === null) {
        const p = this.h.lingeringPoseCache.get(sid);
        defendAt(w, hb.getGuardPostX?.() ?? p?.x ?? 0, hb.getGuardPostY?.() ?? p?.y ?? 0);
      } else this.applyHullMode(sid);
    } else if (o === null && w.mode === 'retreat' && travel === 2) {
      const p = this.h.lingeringPoseCache.get(sid);
      defendAt(w, hb.getGuardPostX?.() ?? p?.x ?? 0, hb.getGuardPostY?.() ?? p?.y ?? 0);
    } else return;
    this.h.fleetStatusSoonFor(fleet.ownerAt(i));
  }

  /** RTS Part B slice 11: an owned hull in Patrol mode at (x, y) walks its
   *  fleet route (the ONE route, on its fleet orders): `stepFleetPatrol` steps it
   *  with the shared `stepRoute` (the garrison patrols' stepper), looping;
   *  a new waypoint (or a brain no longer on its leg: a fight lost it, a
   *  travel arrived) gets a fresh patrol leg from the last waypoint (from the
   *  hull on the first leg). `fresh` forces the leg (the mode was just set).
   *  Called from `applyHullMode` and the ~10 Hz target step. */
  private stepHullPatrol(w: FleetShipOrders, brain: IAiBehaviour, x: number, y: number, fresh: boolean): void {
    if (brain.setPatrolLeg === undefined) return;
    const before = w.routeIdx;
    const i = stepFleetPatrol(w, x, y);
    if (i < 0) return;
    const moved = i !== before;
    if (!fresh && !moved && brain.isPatrolling?.() === true) return;
    const fromLast = moved && !fresh;
    const r = w.route;
    brain.setPatrolLeg(
      fromLast ? r[before * 2]! : x, fromLast ? r[before * 2 + 1]! : y,
      r[i * 2]!, r[i * 2 + 1]!,
    );
  }

  /** RTS Part B: an owned hull's brain holds at (x, y): its move target, and
   *  its guard post (the guard leash: it engages only inside the guard
   *  radius round it; a broadside capital fights from it). A squad's AI
   *  leader (`leads`, slice 10) takes it as the flock leader's course, so it
   *  cruises slower than its pack and they keep up, as an AI pilots' pack. */
  private holdHullAt(brain: IAiBehaviour, x: number, y: number, leads = false): void {
    if (leads && brain.setFlockLeaderCourse !== undefined) brain.setFlockLeaderCourse(x, y);
    else brain.setMoveTarget?.(x, y);
    brain.setGuardPost?.(x, y, 0);
  }

  /** RTS Part B slice 8: the hull's order → its AI pilot brain's ordered
   *  target (an attack order's target, by the id the brain's candidates
   *  carry: a swarm ship by its record id), else none. Idempotent; a no-op
   *  while unchanged. Called on every order and from the ~10 Hz target step,
   *  so a completed, replaced or re-keyed order follows. */
  private syncHullOrder(brain: IAiBehaviour, order: Readonly<FleetOrder> | null): void {
    if (brain.setOrderedTarget === undefined) return;
    let t: string | null = null;
    if (order !== null && order.kind === 'attack') t = this.swarmRecByAnyId(order.targetId)?.id ?? order.targetId;
    if (brain.getOrderedTarget?.() !== t) brain.setOrderedTarget(t, this.h.serverTick());
  }

  /** RTS Part B: the fleet orders' mode → the AI pilot brain flying hull
   *  `id`. A Move order in hand owns the brain (slice 9): it travels on, and
   *  the mode applies when the order completes. Defend guards its post (the
   *  given point, else where the hull is; slice 5). Hunt lifts the leash and
   *  searches the sector (slice 6). Retreat (slice 9) travels to its point
   *  (else the post) like a Move, then defends there. Patrol (slice 11)
   *  flies the fleet route leg by leg from the waypoint nearest the hull
   *  (`stepHullPatrol`).
   *
   *  Squads and Escort (slice 10), on the AI pilots' pack seams: a squad
   *  member flies as a loose pack on its leader (`setFlockFollow`; the AI
   *  leader flies the squad mode, `holdHullAt` `leads`, a patrol on its
   *  legs). Escort (a ship's own, or its squad's) packs on the escorted ship
   *  and guards a zone that follows it (`setGuardPost` anchored to it, as a
   *  flagship's escorts); hits on it turn the escorts (`ownedHullRetaliates`).
   *  An escorted ship that cannot be found: hold where the hull is. */
  applyHullMode(id: string): void {
    const brain = this.h.aiController().getBehaviour(id);
    const fleet = this.h.fleet;
    const w = fleet.ordersOf(id);
    if (brain === null || w === null) return;
    const o = w.order;
    if (o !== null && o.kind === 'move' && brain.setTravel !== undefined) { brain.setTravel(o.x, o.y); return; }
    const sq = fleet.squadOf(id);
    const pack = this.hullPackIds;
    const esc = fleet.escortTargetOf(id);
    if (esc !== null && brain.setFlockFollow !== undefined && this.entityPoseInto(esc, this.wingmanTargetPose)) {
      pack.length = 0;
      if (sq !== null) for (let k = 0; k < sq.memberIds.length; k++) pack.push(sq.memberIds[k]!);
      else pack.push(id);
      pack.push(esc);
      brain.setHunt?.(false);
      brain.setFlockFollow(esc, pack);
      brain.setGuardPost?.(this.wingmanTargetPose.x, this.wingmanTargetPose.y, 0, esc);
      return;
    }
    const lead = fleet.squadFollowOf(id);
    if (lead !== null && sq !== null && brain.setFlockFollow !== undefined) {
      brain.setHunt?.(false);
      brain.clearGuardPost?.();
      brain.setFlockFollow(lead, sq.memberIds);
      return;
    }
    if (w.mode === 'hunt') { brain.setHunt?.(true); return; }
    brain.setHunt?.(false);
    const p = this.h.lingeringPoseCache.get(id);
    if (w.mode === 'patrol' && w.routeLen > 0 && brain.setPatrolLeg !== undefined) {
      w.routeSeek = true;
      this.stepHullPatrol(w, brain, p?.x ?? w.route[0]!, p?.y ?? w.route[1]!, true);
      return;
    }
    const rx = w.mode === 'retreat' ? w.retreatPointX : null;
    const x = rx ?? w.guardPostX ?? p?.x;
    const y = (rx !== null ? w.retreatPointY : null) ?? w.guardPostY ?? p?.y;
    if (x === undefined || y === undefined) return;
    if (w.mode === 'retreat' && brain.setTravel !== undefined) brain.setTravel(x, y);
    else this.holdHullAt(brain, x, y, sq !== null && sq.leaderId === id);
  }

  /** Slice 10: the ship `gone` left the AI controller (its owner took the
   *  controls, or it died). Unregistering it cleared the guard post of every
   *  brain anchored to it (`noteEntityGone`): re-apply each escort of it,
   *  which packs on it again where its pilot flies it, else holds where it
   *  is. Rare (a hand-over or a death), never per tick. */
  private reapplyEscortsOf(gone: string): void {
    const fleet = this.h.fleet;
    for (let i = 0; i < fleet.size; i++) {
      const id = fleet.idAt(i);
      if (id !== gone && fleet.escortTargetOf(id) === gone) this.applyHullMode(id);
    }
  }

  /** RTS Part B slice 6: the stance's attitude → the AI pilot brain. Aggressive
   *  engages anything hostile it sees (robots and drones hostile to players,
   *  and whatever is hostile to the owner); Defensive only hits back (the
   *  retaliation ledger). Hold fire (slice 7) picks no target at all: no
   *  fire, no chase, the ship flies its job; attackers stay on the ledger,
   *  so a switch back to Defensive answers a recent one. Leaving hold fire
   *  restores the attitude of the stance chosen. */
  applyHullStance(id: string): void {
    const brain = this.h.aiController().getBehaviour(id);
    const w = this.h.fleet.ordersOf(id);
    if (brain === null || w === null) return;
    brain.setHoldFire?.(w.stance === 'holdFire');
    if (w.stance === 'aggressive') brain.setEngageOnSight?.(true);
    else if (w.stance === 'defensive') brain.setEngageOnSight?.(false);
  }

  /** Stop flying a hull: its owner reclaimed it, or it left the world. Call
   *  next to every `lingeringSlots.delete` (BEFORE it, and before a reclaim's
   *  REKEY back). Posts neutral controls last, so a wingman INPUT still queued
   *  in the worker can't become the reclaimed hull's held input (the worker
   *  holds the last input until the pilot's first arrives). Idempotent. */
  detachWingman(shipInstanceId: string, keepSquad = false): void {
    // RTS fleet warp: the ONE drop point. A hull leaving lingering leaves any
    // fleet warp it is spooling in (the orchestrator ignores its own commit's
    // removals and a reclaim it was told about via `noteTakeControls`).
    this.h.transitOrchestrator()?.dropHull(shipInstanceId);
    this.h.boostingPlayers.delete(shipInstanceId);
    // RTS Part B: the AI pilot brain lets go (idempotent).
    this.h.aiController().unregister(shipInstanceId);
    this.reapplyEscortsOf(shipInstanceId);
    this.hullHeldBits.delete(shipInstanceId);
    this.hullTrigger.delete(shipInstanceId);
    if (!this.h.fleet.isAttached(shipInstanceId)) return;
    this.h.fleet.detach(shipInstanceId, keepSquad ? KEEP_SQUAD : undefined);
    // RTS slice 5: drop the hull's wingman fire state (locks, turret angles,
    // cooldown ledger, target cache). A reclaimed hull fires as its pilot.
    this.h.wingmanLocks().forget(shipInstanceId);
    this.h.mountTicker().playerMountAngles.delete(shipInstanceId);
    this.h.lastFireClientTick.delete(shipInstanceId);
    this.h.lockActivated().delete(shipInstanceId);
    this.wingmanFireKeys.delete(shipInstanceId);
    const slot = this.h.lingeringSlots.get(shipInstanceId);
    if (slot === undefined) return;
    const cmd = this.wingmanInputCmd;
    cmd.slot = slot;
    cmd.inputTick = this.h.serverTick();
    cmd.thrust = false; cmd.turnLeft = false; cmd.turnRight = false; cmd.boost = false; cmd.reverse = false;
    this.h.postToWorker(cmd);
  }

  /** Fleet hook: a lingering hull's live SAB pose; false once it isn't one. */
  readLingeringPose(shipInstanceId: string, out: FleetPose): boolean {
    const slot = this.h.lingeringSlots.get(shipInstanceId);
    if (slot === undefined) return false;
    const b = slotBase(slot);
    out.x = this.h.sabF32()[b + SLOT_X_OFF]!;
    out.y = this.h.sabF32()[b + SLOT_Y_OFF]!;
    out.vx = this.h.sabF32()[b + SLOT_VX_OFF]!;
    out.vy = this.h.sabF32()[b + SLOT_VY_OFF]!;
    out.angle = this.h.sabF32()[b + SLOT_ANGLE_OFF]!;
    out.angvel = this.h.sabF32()[b + SLOT_ANGVEL_OFF]!;
    return true;
  }

  /** Fleet hook: a pilot's ACTIVE ship's live SAB pose, keyed by playerId
   *  (escort / attack target). False when they have no live active ship. */
  private readActiveShipPose(playerId: string, out: FleetPose): boolean {
    const slot = this.h.playerToSlot().get(playerId);
    if (slot === undefined || !this.h.getActiveShip(playerId)?.alive) return false;
    const b = slotBase(slot);
    out.x = this.h.sabF32()[b + SLOT_X_OFF]!;
    out.y = this.h.sabF32()[b + SLOT_Y_OFF]!;
    out.vx = this.h.sabF32()[b + SLOT_VX_OFF]!;
    out.vy = this.h.sabF32()[b + SLOT_VY_OFF]!;
    out.angle = this.h.sabF32()[b + SLOT_ANGLE_OFF]!;
    out.angvel = this.h.sabF32()[b + SLOT_ANGVEL_OFF]!;
    return true;
  }

  /** Last control keys posted per AI-flown hull (the worker holds them). */
  private readonly hullHeldBits = new Map<string, AiInputBits>();
  /** RTS Part B: hulls whose AI pilot holds the trigger THIS tick, and at
   *  what (its `intent.fire`, via the sink's `postHullFire`). Filled by
   *  the AI tick, consumed and cleared by `tickWingmanFire` the same tick. */
  readonly hullTrigger = new Map<string, string>();
  /** Running total of AI pilot decisions for owned hulls (perf scene count). */
  hullBrainTicksTotal = 0;

  /**
   * RTS Part B — THE hull branch of the AI input sink: an owned hull's control
   * keys go to its slot as the pilot INPUT command (the same command a pilot's
   * keys produce), never `AI_INPUTS`, so the slot's flame flags show and a
   * reclaim's own INPUT simply replaces them. Posted only when the keys
   * change (the worker holds the last INPUT, input-queue rule #3). Boost is
   * paid by the brain from the hull's pool (`HostileDroneBehaviour.fly`), so the
   * hull never joins `boostingPlayers`. One reused command (#14).
   */
  postHullInput(shipInstanceId: string, bits: AiInputBits): void {
    this.hullBrainTicksTotal++;
    const slot = this.h.lingeringSlots.get(shipInstanceId);
    if (slot === undefined) return;
    if (this.hullHeldBits.get(shipInstanceId) === bits) return;
    this.hullHeldBits.set(shipInstanceId, bits);
    const cmd = this.wingmanInputCmd;
    cmd.slot = slot;
    cmd.inputTick = this.h.serverTick();
    decodeAiInputBits(bits, cmd);
    this.h.postToWorker(cmd);
  }

  // ── RTS slice 5 — wingmen fight ────────────────────────────────────────────
  //
  // Fire path: the PLAYER pipeline (`wingmanLocks` → `WeaponMountTicker.tickHull`
  // → `PlayerFireResolver.fireHull`), never `AiFireResolver`: a parked hull is
  // a player's ship, so it locks, aims, spends energy and scales damage exactly
  // as its pilot would (owner rule), and the player side keeps its one resolver.

  /** Per wingman: the target it is locking and that target's lock key. */
  readonly wingmanFireKeys = new Map<string, { id: string; key: string }>();
  /** A swarm record by registry id or wire id (`swarm-<entityId>`, what the
   *  client's attack order names). Alloc-free digit parse. */
  private swarmRecByAnyId(id: string): SwarmEntityRecord | null {
    const rec = this.h.swarmRegistry.get(id);
    if (rec) return rec;
    if (!id.startsWith('swarm-') || id.length <= 6) return null;
    let n = 0;
    for (let i = 6; i < id.length; i++) {
      const c = id.charCodeAt(i) - 48;
      if (c < 0 || c > 9) return null;
      n = n * 10 + c;
    }
    return this.h.swarmRegistry.getByEntityId(n);
  }

  /** Live pose of any entity a wingman may name: a lingering hull, a pilot's
   *  active ship (by playerId) or a swarm entity (registry or wire id). */
  entityPoseInto(id: string, out: FleetPose): boolean {
    if (this.readLingeringPose(id, out) || this.readActiveShipPose(id, out)) return true;
    // A pilot's ACTIVE ship by its shipInstanceId (slice 4b: `pilotShipOf`).
    const owner = this.h.state().ships.get(id)?.playerId;
    if (owner !== undefined && this.h.playerToActiveShipInstance.get(owner) === id && this.readActiveShipPose(owner, out)) return true;
    const rec = this.swarmRecByAnyId(id);
    return rec !== null && this.h.swarmEntityPoseInto(rec.id, out);
  }

  /** RTS slice 5: whose hostility a hit counts for — the owning player of a
   *  hull (keyed by shipInstanceId: a wingman's shot), else the source. */
  hostileActorOf(sourceId: string): string {
    return this.h.state().ships.get(sourceId)?.playerId ?? sourceId;
  }

  /** Lock key for a wingman target id: `s:<entityId>` (NPC ship / structure)
   *  or `p:<id>` (another player's ship: a pilot's active ship by playerId or
   *  an AI-flown hull by shipInstanceId; only ever an explicit order or a
   *  retaliation). Cached per wingman: a string is built only when the target
   *  changes. Null ⇒ not lockable (asteroid, scrap). `resolveLockTarget`
   *  still refuses the owner's own ships. */
  private wingmanLockKey(sid: string, targetId: string): string | null {
    const cached = this.wingmanFireKeys.get(sid);
    if (cached !== undefined && cached.id === targetId) return cached.key;
    let key: string | null = null;
    const rec = this.swarmRecByAnyId(targetId);
    if (rec !== null) {
      if (rec.kind === SWARM_KIND_DRONE || rec.kind === 2) key = `s:${rec.entityId}`;
    } else if (this.h.getActiveShip(targetId)?.alive || this.h.lingeringSlots.has(targetId)) {
      key = `p:${targetId}`;
    } else {
      // A ship named by its shipInstanceId that its owner now flies: its lock
      // key is the pilot's (`resolveLockTarget`), so the lock follows the ship.
      const ship = this.h.state().ships.get(targetId);
      if (ship?.alive && ship.playerId !== '' && this.h.resolveActiveShipKey(ship.playerId) === targetId) key = `p:${ship.playerId}`;
    }
    if (key === null) return null;
    if (cached !== undefined) { cached.id = targetId; cached.key = key; } else this.wingmanFireKeys.set(sid, { id: targetId, key });
    return key;
  }

  /**
   * Every ~10 Hz (the lock step cadence): each AI-flown hull points every
   * weapon group's lock at its AI pilot brain's target (`getTargetId`; MAN
   * groups: `requestLock`; a new target drops the old locks). Hold fire, or
   * no target ⇒ every lock is cancelled (RTS Part B slice 2). The trigger is
   * the brain's `intent.fire` (`tickWingmanFire`). The lock still takes the
   * time a pilot's would (fights aren't instant), and a neutral target runs
   * the failsafe.
   */
  tickWingmanTargets(): void {
    const fleet = this.h.fleet;
    for (let i = 0; i < fleet.size; i++) {
      const sid = fleet.idAt(i);
      const ship = this.h.state().ships.get(sid);
      const pose = this.h.lingeringPoseCache.get(sid);
      if (!ship?.alive || !pose) continue;
      // Slice 8: an attack order whose target is gone is done (the status
      // shows the ship's mode again); otherwise the brain follows the order
      // (a replaced order, a squad command, a re-keyed target).
      const w = fleet.ordersAt(i);
      const o = w.order;
      const hb = this.h.aiController().getBehaviour(sid);
      let ordered: string | null = null;
      if (o !== null && o.kind === 'attack') {
        if (this.entityPoseInto(o.targetId, this.wingmanTargetPose)) ordered = o.targetId;
        else {
          clearFleetOrder(w);
          // A Retreat carries on to its point (slice 9).
          if (w.mode === 'retreat') this.applyHullMode(sid);
          this.h.fleetStatusSoonFor(fleet.ownerAt(i));
        }
      } else if (hb !== null && hb.getTravelState !== undefined) this.completeHullTravel(i, sid, hb);
      // Slice 11: a patrolling hull walks its route.
      if (hb !== null && w.order === null && w.mode === 'patrol' && fleet.squadFollowOf(sid) === null) this.stepHullPatrol(w, hb, pose.x, pose.y, false);
      if (hb !== null) this.syncHullOrder(hb, w.order);
      // The brain's target; with none, a live ordered target keeps the locks
      // (its pilot's take-controls handshake hides it from the brain's
      // candidates for a few ticks; the lock must not restart).
      // Hold fire locks only an ordered target (an attack order is obeyed).
      const target = w.stance === 'holdFire'
        ? ordered
        : (hb?.getTargetId?.() ?? ordered);
      const key = target === null ? null : this.wingmanLockKey(sid, target);
      const groups = this.h.wingmanLocks().wireFor(sid);
      if (key === null) {
        if (groups !== undefined) for (let g = 0; g < groups.length; g++) {
          if (groups[g]!.l.length > 0) this.h.wingmanLocks().cancelLock(sid, groups[g]!.id);
        }
        continue;
      }
      const gs = groups ?? this.h.wingmanLocks().ensureGroups(sid);
      if (gs === undefined) continue;
      for (let g = 0; g < gs.length; g++) {
        const grp = gs[g]!;
        if (grp.l.length === 1 && grp.l[0]!.t === key) continue;
        if (grp.l.length > 0) this.h.wingmanLocks().cancelLock(sid, grp.id);
        this.h.wingmanLocks().requestLock(sid, grp.id, key);
      }
    }
  }

  /**
   * Every tick: each owned hull's turrets slew to their group locks (the
   * pilot's `tickPlayer` rule), and the hull pulls its trigger through the
   * player resolver (lock gate, bearing, line of fire, cooldown and energy are
   * its own) on every group holding a LOCKED target, but only while its AI
   * pilot holds the trigger (RTS Part B slice 3): the brain's `intent.fire`
   * at the target the locks follow, so the hull fires only when the brain
   * would (aim tolerance, range, charge wind-up room). A turret-fire-control
   * hull (a capital) has no brain trigger (its brain never fires; the
   * turrets do as each bears, like an AI pilot's capital), so its trigger is
   * its lock. Liveness: LINGERING hulls with a brain only (#17).
   */
  tickWingmanFire(): void {
    const fleet = this.h.fleet;
    for (let i = 0; i < fleet.size; i++) {
      const sid = fleet.idAt(i);
      const ship = this.h.state().ships.get(sid);
      const pose = this.h.lingeringPoseCache.get(sid);
      if (!ship?.alive || !pose) continue;
      this.h.mountTicker().tickHull(sid, ship, pose);
      const groups = this.h.wingmanLocks().wireFor(sid);
      if (groups === undefined) continue;
      if (!hasTurretFireControl(getShipKind(ship.kind))) {
        const held = this.hullTrigger.get(sid);
        if (held === undefined || this.wingmanFireKeys.get(sid)?.id !== held) continue;
      }
      for (let g = 0; g < groups.length; g++) {
        const grp = groups[g]!;
        if (grp.l.length === 0 || !this.h.wingmanLocks().hasLocked(sid, grp.id)) continue;
        this.h.playerFireResolver().fireHull(sid, ship, grp.id);
      }
    }
    this.hullTrigger.clear();
  }
}
