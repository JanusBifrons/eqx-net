/**
 * Fleet command subsystem (RTS command layer): the owner-checked facade over
 * the ships a player owns but is not flying (the room's LINGERING hulls).
 *
 * The shared AI pilot brain (`HostileDroneBehaviour`, registered by the room)
 * flies each hull. This subsystem only keeps each ship's ORDERS as plain data
 * (`FleetShipOrders`: mode, stance, order, post, route, escort target) and its
 * squad, takes the owner's commands (orders / modes / stances / squads) and
 * tells the room through the hooks, which hands each change to the brain.
 *
 * Decision logic over injected hooks, the `SelectionStatsSubsystem` /
 * `TransitOrchestrator` shape: no live room needed to test it.
 *
 * Commands are owner-validated PER SHIP through `hooks.ownerOf`: a foreign or
 * unknown id is silently dropped (never an error to the client), and at most
 * `FLEET_MAX_IDS_PER_COMMAND` ids are read per command.
 *
 * Allocation-free per tick (#14): entries live in a dense array and the squad
 * refresh is event-driven. Command handlers (`onMessage`, #14) reuse one
 * accepted-ids scratch array; the returned array is valid until the next call.
 *
 * Kill switch: `EQX_DISABLE_WINGMEN=1` (read at construction) makes `attach`
 * a no-op, so no ship is ever AI-flown.
 */
import { deriveStatMultipliers, effectiveShipEnergyMax, type StatAlloc } from '../../core/leveling/shipStats.js';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { shipTuning } from '../../shared-types/shipScale/tuning.js';
import type { FleetActivity, FleetMode, FleetOrder, FleetStance } from '../../shared-types/messages/fleetStatusMessages.js';
import {
  parseSavedMode,
  parseSavedSquad,
  parseSavedStance,
  type FleetSavedModeData,
  type FleetSavedShip,
  type FleetSavedSquad,
} from './fleetPersistence.js';
import {
  clearFleetOrder,
  fleetOrderKeyMoved,
  fleetOrderTarget,
  makeFleetShipOrders,
  savedModeDataOf,
  setFleetMode,
  type FleetModeData,
  type FleetShipOrders,
} from './fleetShipOrders.js';

export type { FleetModeData, FleetShipOrders } from './fleetShipOrders.js';

/** Most ship ids read from one command (the rest are ignored). */
export const FLEET_MAX_IDS_PER_COMMAND = 64;
/** Squad size limits. */
export const FLEET_SQUAD_MIN = 2;
export const FLEET_SQUAD_MAX = 24;

/** `EQX_DISABLE_WINGMEN=1|true` turns the whole wingman layer off. */
export function isWingmenDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env['EQX_DISABLE_WINGMEN'];
  return v === '1' || v === 'true';
}

/** Mutable pose the room writes a ship's live SAB pose into. */
export interface FleetPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

export interface FleetCommandHooks {
  /** The ship's owning playerId, or null if unknown / gone. The authority for
   *  every command's ownership check. */
  ownerOf(shipId: string): string | null;
  /** Write the ship's live pose into `out`; false if it is gone (a group
   *  move then spreads it from the target point). */
  readPose(shipId: string, out: FleetPose): boolean;
  /** The ship `playerId` is flying right now, or null. Escort may follow it,
   *  and when it is a member of one of their squads that squad is PILOT-LED:
   *  the members form up on it. */
  pilotShipOf?(playerId: string): string | null;
  /** An order was given to `shipId` (after any group-move spread: `order` is
   *  that ship's own). The room forwards it to the AI pilot brain that flies
   *  the hull (RTS Part B). Absent ⇒ ignored. */
  orderIssued?(shipId: string, order: Readonly<FleetOrder>): void;
  /** `shipId` took a new standing mode or squad role (read it back through
   *  `ordersOf`, which has resolved the post). The room forwards it to the AI
   *  pilot brain (`applyHullMode`). Absent ⇒ ignored. */
  modeSet?(shipId: string): void;
  /** `shipId` took a new stance (`set_stance` or a restore; read it back
   *  through `ordersOf`). The room forwards the attitude to the AI pilot
   *  brain (RTS Part B slice 6). Absent ⇒ ignored. */
  stanceSet?(shipId: string): void;
  /** What `shipId` is doing, from the AI pilot brain that flies it (RTS
   *  Part B slice 9: travelling, fighting, guarding, searching), for the
   *  status stream. Null / absent ⇒ 'idle'. */
  activityOf?(shipId: string): FleetActivity | null;
}

export interface FleetCommandOptions {
  /** Override the env kill switch (tests). */
  disabled?: boolean;
}

/** What the fleet needs from the ship: its kind (sizes, #18). */
export interface FleetShipInputs {
  kind: ShipKind;
}

/** One ship's line in the status stream. */
export interface FleetShipStatus {
  id: string;
  mode: FleetMode;
  stance: FleetStance;
  activity: FleetActivity;
  targetId: string | null;
  order: FleetOrder | null;
  squadId: string | null;
  /** The squad's leader (AI- or pilot-flown), or null when not in a squad. */
  squadLeaderId: string | null;
}

export interface FleetSquad {
  readonly id: string;
  readonly ownerId: string;
  /** The ship the squad forms up on. Usually an AI-flown member; the ship
   *  its owner is flying when that is a member (pilot-led). */
  leaderId: string;
  readonly memberIds: string[];
  /** The squad-wide standing mode (the last one given to the whole squad),
   *  or null: the leader keeps whatever it was doing. Re-applied to a new
   *  AI leader (leader died, pilot released the controls). */
  readonly mode: FleetMode | null;
}

/** Internal squad record (dense list + command scratch). */
interface SquadState extends FleetSquad {
  mode: FleetMode | null;
  /** Owned copy of the squad-wide mode data (route array by reference). */
  readonly modeData: FleetModeData;
  /** Leader the members were last told to follow (null = none yet). */
  appliedLeader: string | null;
  /** Membership / attachment / squad mode changed: re-apply the roles on
   *  the next tick. */
  dirty: boolean;
  /** Index in the dense `squadList`. */
  index: number;
  /** Command classification scratch: stamp + "the command covers every
   *  AI-flown member". */
  cmdStamp: number;
  cmdWhole: boolean;
}

const ROLE_NONE = 0;
const ROLE_LEADER = 1;
const ROLE_MEMBER = 2;

interface FleetEntry {
  readonly id: string;
  ownerId: string;
  /** The owner's word for this ship (data; the AI pilot brain flies it). */
  readonly orders: FleetShipOrders;
  squadId: string | null;
  /** Squad role last applied (ROLE_*). */
  role: number;
  /** Index in the dense `entries` array (kept on swap-remove). */
  index: number;
  /** Command de-dup stamp. */
  stamp: number;
  /** Gap this hull keeps to its neighbours when several ships are sent to
   *  one point (`shipTuning(kind).flockSeparation`, #18). */
  readonly spacing: number;
  /** This ship's own move order (a group move gives each ship its own
   *  point round the target); reused, so a command allocates nothing. */
  readonly moveOrder: { kind: 'move'; x: number; y: number };
}

/**
 * The kind as this ship flies it: the catalogue kind with the ship's upgrades
 * folded in, exactly as `applyShipInput` applies them (`topSpeed` scales the
 * thrust and the speed cap, `turnRate` the turn rate and torque) and the
 * pool cap `effectiveShipEnergyMax` gives. The AI pilot brain flying an owned
 * hull is built from it (`makePilotHandling`, its energy cap), so an upgraded
 * ship is flown as the ship it is. A fresh object (attach time, never per tick).
 */
export function pilotKindFor(kind: ShipKind, statAlloc?: StatAlloc): ShipKind {
  const mul = deriveStatMultipliers(statAlloc);
  return {
    ...kind,
    thrustImpulse: kind.thrustImpulse * mul.topSpeed,
    maxSpeed: kind.maxSpeed * mul.topSpeed,
    maxAngvel: kind.maxAngvel * mul.turnRate,
    ...(kind.turnTorque !== undefined ? { turnTorque: kind.turnTorque * mul.turnRate } : {}),
    energyMax: effectiveShipEnergyMax(kind.energyMax ?? 100, statAlloc),
  };
}

/** Patrol: a waypoint counts as passed inside this (u): two arrive radii, or
 *  a quarter of the guard radius on a big hull (#18). */
export function patrolPassRadiusFor(kind: ShipKind): number {
  const t = shipTuning(kind);
  return Math.max(t.wingmanArrive * 2, t.guardRadiusMin * 0.25);
}

export class FleetCommandSubsystem {
  private readonly byId = new Map<string, FleetEntry>();
  private readonly entries: FleetEntry[] = [];
  private readonly squads = new Map<string, SquadState>();
  /** Dense squad list for the per-tick leader check (no Map iterator, #14). */
  private readonly squadList: SquadState[] = [];
  /** Squad of every member id, attached or not (a member the owner is flying
   *  stays in its squad while detached). */
  private readonly memberSquad = new Map<string, string>();
  private readonly disabled: boolean;
  private nextSquad = 1;
  private stampGen = 0;

  private readonly pose: FleetPose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly modeScratch: FleetModeData = {};
  private readonly accepted: string[] = [];
  /** `applyOrder` scratch: the ships that take the order (null once placed). */
  private readonly movers: (FleetEntry | null)[] = [];
  private readonly spreadOffX = new Float64Array(FLEET_MAX_IDS_PER_COMMAND);
  private readonly spreadOffY = new Float64Array(FLEET_MAX_IDS_PER_COMMAND);
  private readonly spreadSlotX = new Float64Array(FLEET_MAX_IDS_PER_COMMAND);
  private readonly spreadSlotY = new Float64Array(FLEET_MAX_IDS_PER_COMMAND);
  private readonly spreadUsed = new Uint8Array(FLEET_MAX_IDS_PER_COMMAND);
  private readonly statusOut: FleetShipStatus[] = [];
  private readonly statusPool: FleetShipStatus[] = [];

  constructor(private readonly hooks: FleetCommandHooks, opts: FleetCommandOptions = {}) {
    this.disabled = opts.disabled ?? isWingmenDisabled();
  }

  get isDisabled(): boolean { return this.disabled; }
  get size(): number { return this.entries.length; }
  isAttached(shipId: string): boolean { return this.byId.has(shipId); }

  /** The AI-flown ship's orders, or null when it is not attached. The room
   *  reads them and completes orders through the `fleetShipOrders` helpers;
   *  owner commands go through the owner-checked methods below. */
  ordersOf(shipId: string): FleetShipOrders | null { return this.byId.get(shipId)?.orders ?? null; }

  squad(squadId: string): Readonly<FleetSquad> | null { return this.squads.get(squadId) ?? null; }

  /** The squad `shipId` belongs to (attached or owner-flown), or null. */
  squadOf(shipId: string): Readonly<FleetSquad> | null {
    const sqId = this.memberSquad.get(shipId);
    return sqId === undefined ? null : (this.squads.get(sqId) ?? null);
  }

  // ---- Lifecycle (low-frequency: hull parked / reclaimed) -----------------

  /**
   * Hand `shipId` to an AI pilot: fresh orders, Defend at `initialPose`,
   * Defensive stance. Re-attaching an attached ship replaces its orders.
   * No-op under the kill switch. A squad member (e.g. released by its pilot)
   * rejoins its squad: the next refresh gives it the squad mode (as leader)
   * or its place in the pack.
   */
  attach(shipId: string, ownerId: string, ship: FleetShipInputs, initialPose: { x: number; y: number }): void {
    if (this.disabled) return;
    if (this.byId.has(shipId)) this.detach(shipId, { keepSquad: true });
    const sqId = this.memberSquad.get(shipId) ?? null;
    const entry: FleetEntry = {
      id: shipId,
      ownerId,
      orders: makeFleetShipOrders(patrolPassRadiusFor(ship.kind), initialPose.x, initialPose.y),
      squadId: sqId,
      role: ROLE_NONE,
      index: this.entries.length,
      stamp: 0,
      spacing: shipTuning(ship.kind).flockSeparation,
      moveOrder: { kind: 'move', x: 0, y: 0 },
    };
    this.entries.push(entry);
    this.byId.set(shipId, entry);
    if (sqId !== null) this.squads.get(sqId)!.dirty = true;
  }

  /**
   * Stop flying `shipId` (its owner took the helm, or it is gone). By default
   * it also leaves its squad. `keepSquad: true` keeps the membership: use it
   * when the OWNER takes the controls of a squad member (the squad then forms
   * up on that ship, pilot-led, and it is the AI leader again on release).
   * A ship that is not attached but still a squad member (the owner was
   * flying it) leaves its squad unless `keepSquad`.
   */
  detach(shipId: string, opts?: { keepSquad?: boolean }): void {
    const keep = opts?.keepSquad === true;
    const e = this.byId.get(shipId);
    if (!e) {
      if (!keep && this.memberSquad.has(shipId)) this.removeFromSquad(shipId);
      return;
    }
    if (e.squadId !== null) {
      if (keep) this.squads.get(e.squadId)!.dirty = true;
      else this.removeFromSquad(shipId);
    }
    this.byId.delete(shipId);
    const last = this.entries.pop()!;
    if (last !== e) {
      this.entries[e.index] = last;
      last.index = e.index;
    }
  }

  /** A squad member left the world while its owner was flying it (death,
   *  abandon): drop it from its squad. Same as `detach` for a detached id. */
  forgetSquadMember(shipId: string): void {
    if (this.memberSquad.has(shipId)) this.removeFromSquad(shipId);
  }

  // ---- Commands (onMessage; owner-validated per id) -----------------------

  /**
   * Issue `order` to every owned ship in `shipIds`. Returns the accepted ids.
   * Squads: when the ids cover every AI-flown member of a squad, the LEADER
   * takes the order and the members keep with it (their own orders are
   * dropped); a pilot-led squad ignores it (the pilot is flying). A subset of
   * a squad: just those ships, which rejoin the pack when it is done.
   *
   * A MOVE that sends several ships (loose ships and whole squads' leaders)
   * to one point gives each its own spot round it: a hex cluster `spacing`
   * apart (the largest mover's `flockSeparation`, #18), each ship taking the
   * free spot nearest where it sits in the group, so paths don't cross. Sent
   * to the very same point they arrived hull to hull and shoved each other
   * (RTS stop drift, 2026-11-14).
   */
  applyOrder(callerId: string, shipIds: readonly string[], order: FleetOrder): readonly string[] {
    const n = this.collect(callerId, shipIds);
    this.classifySquads(n);
    const movers = this.movers;
    movers.length = 0;
    for (let i = 0; i < n; i++) {
      const e = this.byId.get(this.accepted[i]!)!;
      const sq = e.squadId !== null ? this.squads.get(e.squadId)! : null;
      if (sq !== null && sq.cmdWhole && e.id !== this.squadLeader(sq)) { clearFleetOrder(e.orders); continue; }
      movers.push(e);
    }
    if (order.kind === 'move' && movers.length > 1) this.spreadMove(order.x, order.y);
    else for (let i = 0; i < movers.length; i++) {
      movers[i]!.orders.order = order;
      this.hooks.orderIssued?.(movers[i]!.id, order);
    }
    movers.length = 0;
    return this.accepted;
  }

  /** Give each of `this.movers` its own move point round (tx, ty). */
  private spreadMove(tx: number, ty: number): void {
    const movers = this.movers;
    const n = movers.length;
    const p = this.pose;
    const ox = this.spreadOffX, oy = this.spreadOffY;
    let spacing = 0, cx = 0, cy = 0;
    for (let i = 0; i < n; i++) {
      const e = movers[i]!;
      if (e.spacing > spacing) spacing = e.spacing;
      if (this.hooks.readPose(e.id, p)) { ox[i] = p.x; oy[i] = p.y; } else { ox[i] = tx; oy[i] = ty; }
      cx += ox[i]!; cy += oy[i]!;
    }
    cx /= n; cy /= n;
    for (let i = 0; i < n; i++) { ox[i] = ox[i]! - cx; oy[i] = oy[i]! - cy; }
    // The first n spots of a hex cluster: the point, then rings of 6r.
    const sx = this.spreadSlotX, sy = this.spreadSlotY, used = this.spreadUsed;
    let m = 0;
    for (let r = 0; m < n; r++) {
      if (r === 0) { sx[0] = tx; sy[0] = ty; used[0] = 0; m = 1; continue; }
      for (let side = 0; side < 6 && m < n; side++) {
        const a0 = (side * Math.PI) / 3, a1 = ((side + 1) * Math.PI) / 3;
        const x0 = Math.cos(a0) * r * spacing, y0 = Math.sin(a0) * r * spacing;
        const x1 = Math.cos(a1) * r * spacing, y1 = Math.sin(a1) * r * spacing;
        for (let j = 0; j < r && m < n; j++) {
          sx[m] = tx + x0 + ((x1 - x0) * j) / r;
          sy[m] = ty + y0 + ((y1 - y0) * j) / r;
          used[m] = 0;
          m++;
        }
      }
    }
    // Outermost ships pick first, each the free spot nearest its place in
    // the group (target + its offset from the group's centre).
    for (let k = 0; k < n; k++) {
      let pick = -1, far = -1;
      for (let i = 0; i < n; i++) {
        if (movers[i] === null) continue;
        const d = ox[i]! * ox[i]! + oy[i]! * oy[i]!;
        if (d > far) { far = d; pick = i; }
      }
      const e = movers[pick]!;
      const wx = tx + ox[pick]!, wy = ty + oy[pick]!;
      let best = -1, bestD = Infinity;
      for (let s = 0; s < n; s++) {
        if (used[s] === 1) continue;
        const dx = sx[s]! - wx, dy = sy[s]! - wy;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      }
      used[best] = 1;
      e.moveOrder.x = sx[best]!;
      e.moveOrder.y = sy[best]!;
      e.orders.order = e.moveOrder;
      this.hooks.orderIssued?.(e.id, e.moveOrder);
      movers[pick] = null;
    }
  }

  /**
   * Set the standing mode. `data`: `x`/`y` = the defend / hunt post or the
   * retreat point; `route` = patrol waypoints; `escortId` = the ship to
   * escort. An escort target must be one of the caller's own ships or the
   * ship the caller is flying (`pilotShipOf`), and never the ship itself;
   * otherwise the id is dropped and that ship defends where it is.
   *
   * Squads: ids covering every AI-flown member ⇒ it becomes the SQUAD mode:
   * the leader flies it (stored for a pilot-led squad, applied on release),
   * the members fly with it. A subset of a squad: those ships LEAVE the
   * squad and take the mode (a standing job has no end to rejoin after).
   */
  setMode(
    callerId: string,
    shipIds: readonly string[],
    mode: FleetMode,
    data?: FleetModeData,
  ): readonly string[] {
    const n = this.collect(callerId, shipIds);
    this.classifySquads(n);
    const escortId = mode === 'escort' && data?.escortId !== undefined ? data.escortId : undefined;
    const escortOk = escortId !== undefined && (
      this.hooks.ownerOf(escortId) === callerId
      || (this.hooks.pilotShipOf !== undefined && this.hooks.pilotShipOf(callerId) === escortId)
    );
    const md = this.modeScratch;
    md.x = data?.x;
    md.y = data?.y;
    md.route = data?.route;
    for (let i = 0; i < n; i++) {
      const id = this.accepted[i]!;
      const e = this.byId.get(id)!;
      md.escortId = escortOk && escortId !== id ? escortId : undefined;
      if (e.squadId !== null) {
        const sq = this.squads.get(e.squadId)!;
        if (sq.cmdWhole) {
          if (sq.cmdStamp > 0) {
            // First member seen: store the squad mode once.
            sq.cmdStamp = -sq.cmdStamp;
            sq.mode = mode;
            const sd = sq.modeData;
            sd.x = md.x; sd.y = md.y; sd.route = md.route;
            sd.escortId = escortOk && !this.memberSquad.has(escortId!) ? escortId : undefined;
            // An escort squad's members all follow the escorted ship (and a
            // squad leaving escort follows its leader again): re-apply roles.
            sq.dirty = true;
          }
          if (id === this.squadLeader(sq)) {
            setFleetMode(e.orders, mode, sq.modeData);
            this.hooks.modeSet?.(id);
          }
          continue;
        }
        this.removeFromSquad(id);
      }
      setFleetMode(e.orders, mode, md);
      this.hooks.modeSet?.(id);
    }
    md.route = undefined;
    return this.accepted;
  }

  /**
   * A ship's key moved (its owner took or let go of its controls: playerId
   * <-> shipInstanceId). The attack orders that name it follow it
   * (`fleetOrderKeyMoved`; escort ids are shipInstanceIds and never move).
   * Called only from the room's one "ship key moved" seam. Rare, never per tick.
   */
  shipKeyMoved(from: string, to: string): void {
    const list = this.entries;
    for (let i = 0; i < list.length; i++) fleetOrderKeyMoved(list[i]!.orders, from, to);
  }

  /** Dense iteration over the AI-flown ships (`i < size`): id, owner, orders. */
  idAt(i: number): string { return this.entries[i]!.id; }
  ownerAt(i: number): string { return this.entries[i]!.ownerId; }
  ordersAt(i: number): FleetShipOrders { return this.entries[i]!.orders; }
  ownerOfAttached(shipId: string): string | null { return this.byId.get(shipId)?.ownerId ?? null; }

  /** Stance per ship (a whole squad: every member, so they engage per stance
   *  when the leader engages). */
  setStance(callerId: string, shipIds: readonly string[], stance: FleetStance): readonly string[] {
    const n = this.collect(callerId, shipIds);
    for (let i = 0; i < n; i++) {
      const id = this.accepted[i]!;
      this.byId.get(id)!.orders.stance = stance;
      this.hooks.stanceSet?.(id);
    }
    return this.accepted;
  }

  /**
   * Group the caller's owned, AI-flown ships into a new squad (first accepted
   * id leads). Ships leave any squad they were in. Fewer than
   * {@link FLEET_SQUAD_MIN} or more than {@link FLEET_SQUAD_MAX} accepted ids
   * ⇒ nothing changes and null. From the next tick the members fly as a loose
   * pack on the leader (the AI pilot brain's flocking); the leader keeps what
   * it was doing.
   */
  formSquad(callerId: string, shipIds: readonly string[]): { squadId: string; memberIds: readonly string[] } | null {
    const n = this.collect(callerId, shipIds);
    if (n < FLEET_SQUAD_MIN || n > FLEET_SQUAD_MAX) return null;
    const memberIds = this.accepted.slice(0, n);
    for (const id of memberIds) {
      if (this.memberSquad.has(id)) this.removeFromSquad(id);
    }
    const squadId = `sq-${this.nextSquad++}`;
    const sq: SquadState = {
      id: squadId,
      ownerId: callerId,
      leaderId: memberIds[0]!,
      memberIds,
      mode: null,
      modeData: {},
      appliedLeader: null,
      dirty: true,
      index: this.squadList.length,
      cmdStamp: 0,
      cmdWhole: false,
    };
    this.squads.set(squadId, sq);
    this.squadList.push(sq);
    for (const id of memberIds) {
      this.byId.get(id)!.squadId = squadId;
      this.memberSquad.set(id, squadId);
    }
    return { squadId, memberIds };
  }

  /** Disband the caller's squad. Returns its former members (empty if not theirs). */
  disbandSquad(callerId: string, squadId: string): readonly string[] {
    const sq = this.squads.get(squadId);
    if (!sq || sq.ownerId !== callerId) return EMPTY;
    this.dissolve(sq);
    return sq.memberIds;
  }

  // ---- Persistence (RTS slice 9; off the tick: the 60 s sector save) --------

  /**
   * The standing job of the AI-flown `shipId` (mode + its data, stance, squad),
   * or null when it is not attached. Direct orders are never exported.
   */
  exportShip(shipId: string): FleetSavedShip | null {
    const e = this.byId.get(shipId);
    if (e === undefined) return null;
    const o = e.orders;
    const out: FleetSavedShip = { mode: o.mode, stance: o.stance };
    const md = savedModeDataOf(o);
    if (md !== null) out.modeData = md;
    const sqId = this.memberSquad.get(shipId);
    if (sqId !== undefined) out.squadId = sqId;
    return out;
  }

  /** Every squad, members in order (pilot-flown members included). */
  exportSquads(): FleetSavedSquad[] {
    const out: FleetSavedSquad[] = [];
    for (const sq of this.squadList) {
      const s: FleetSavedSquad = {
        id: sq.id,
        ownerId: sq.ownerId,
        leaderId: sq.leaderId,
        memberIds: sq.memberIds.slice(),
      };
      if (sq.mode !== null) {
        s.mode = sq.mode;
        const md = copyModeData(sq.modeData);
        if (md !== null) s.modeData = md;
      }
      out.push(s);
    }
    return out;
  }

  /** Everything `exportShip` / `exportSquads` would write (tests, diagnostics). */
  exportState(): { ships: Array<FleetSavedShip & { id: string }>; squads: FleetSavedSquad[] } {
    const ships: Array<FleetSavedShip & { id: string }> = [];
    for (const e of this.entries) ships.push({ id: e.id, ...this.exportShip(e.id)! });
    return { ships, squads: this.exportSquads() };
  }

  /**
   * Re-apply a saved standing job to the attached `shipId` (hydrate). Each part
   * is validated on its own and dropped when invalid: the mode (with its data)
   * and the stance. The checks of a live `set_mode` hold: the ship must still
   * belong to its owner (`ownerOf`), and an escort target must be a ship that
   * owner owns and not the ship itself, else it defends where it is. Returns
   * true when anything was applied.
   */
  restoreShip(shipId: string, saved: { mode?: unknown; modeData?: unknown; stance?: unknown }): boolean {
    const e = this.byId.get(shipId);
    if (e === undefined || this.hooks.ownerOf(shipId) !== e.ownerId) return false;
    let applied = false;
    const m = parseSavedMode(saved);
    if (m !== null) {
      setFleetMode(e.orders, m.mode, this.validatedModeData(e.ownerId, m.mode, m.modeData, shipId));
      this.hooks.modeSet?.(shipId);
      applied = true;
    }
    const st = parseSavedStance(saved.stance);
    if (st !== null) {
      e.orders.stance = st;
      this.hooks.stanceSet?.(shipId);
      applied = true;
    }
    return applied;
  }

  /**
   * Re-form saved squads (hydrate, after every hull is attached and its ship
   * restored). Each squad keeps only members that are attached, owned by the
   * squad's owner (`ownerOf`) and not already in a squad; fewer than
   * {@link FLEET_SQUAD_MIN} left ⇒ the squad is dropped. The leader is the
   * saved one when it survived, else the first member. The squad mode is
   * re-validated like `setMode` (an escort target must be the owner's and not
   * a member). Returns the number of squads formed.
   */
  restoreSquads(saved: readonly unknown[]): number {
    let formed = 0;
    for (const raw of saved) {
      const s = parseSavedSquad(raw);
      if (s === null) continue;
      const members: string[] = [];
      for (const id of s.memberIds) {
        if (members.length >= FLEET_SQUAD_MAX) break;
        if (members.includes(id) || !this.byId.has(id) || this.memberSquad.has(id)) continue;
        if (this.hooks.ownerOf(id) !== s.ownerId) continue;
        members.push(id);
      }
      if (members.length < FLEET_SQUAD_MIN) continue;
      let squadId = s.id;
      if (this.squads.has(squadId)) squadId = `sq-${this.nextSquad++}`;
      const num = /^sq-(\d+)$/.exec(squadId);
      if (num !== null) this.nextSquad = Math.max(this.nextSquad, Number(num[1]) + 1);
      let mode: FleetMode | null = null;
      let modeData: FleetModeData = {};
      if (s.mode !== undefined) {
        mode = s.mode;
        modeData = this.validatedModeData(s.ownerId, s.mode, s.modeData, null) ?? {};
        if (modeData.escortId !== undefined && members.includes(modeData.escortId)) {
          modeData = { ...modeData, escortId: undefined };
        }
      }
      const sq: SquadState = {
        id: squadId,
        ownerId: s.ownerId,
        leaderId: members.includes(s.leaderId) ? s.leaderId : members[0]!,
        memberIds: members,
        mode,
        modeData,
        appliedLeader: null,
        dirty: true,
        index: this.squadList.length,
        cmdStamp: 0,
        cmdWhole: false,
      };
      this.squads.set(squadId, sq);
      this.squadList.push(sq);
      for (const id of members) {
        this.byId.get(id)!.squadId = squadId;
        this.memberSquad.set(id, squadId);
      }
      formed++;
    }
    return formed;
  }

  /** Saved mode data made safe to apply: an escort target must be owned by
   *  `ownerId` and never `selfId`, else it is dropped (escort ⇒ defend here). */
  private validatedModeData(
    ownerId: string, mode: FleetMode, md: FleetSavedModeData | undefined, selfId: string | null,
  ): FleetModeData | undefined {
    if (md === undefined) return undefined;
    const escortOk = mode === 'escort' && md.escortId !== undefined && md.escortId !== selfId
      && this.hooks.ownerOf(md.escortId) === ownerId;
    return {
      ...(md.x !== undefined ? { x: md.x } : {}),
      ...(md.y !== undefined ? { y: md.y } : {}),
      ...(md.route !== undefined ? { route: md.route } : {}),
      ...(escortOk ? { escortId: md.escortId } : {}),
    };
  }

  // ---- Per-tick ------------------------------------------------------------

  /**
   * Room tick: resolve each squad's leader (a member the owner is flying
   * leads) and re-apply the roles when it or the membership changed. The AI
   * pilot brain flies the hulls; this is bookkeeping only.
   */
  refreshSquads(): void {
    const sqs = this.squadList;
    for (let i = 0; i < sqs.length; i++) {
      const sq = sqs[i]!;
      const leader = this.squadLeader(sq);
      if (sq.dirty || leader !== sq.appliedLeader) this.refreshSquad(sq, leader);
    }
  }

  // ---- Status (low-frequency stream) ---------------------------------------

  /**
   * Status of every AI-flown ship `ownerId` owns. Pooled: the array and its
   * objects are reused, valid until the next call.
   */
  statusFor(ownerId: string): readonly FleetShipStatus[] {
    const out = this.statusOut;
    out.length = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (e.ownerId !== ownerId) continue;
      let s = this.statusPool[out.length];
      if (s === undefined) {
        s = {
          id: '', mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null, order: null,
          squadId: null, squadLeaderId: null,
        };
        this.statusPool.push(s);
      }
      const o = e.orders;
      s.id = e.id;
      s.mode = o.mode;
      s.stance = o.stance;
      s.activity = this.hooks.activityOf?.(e.id) ?? 'idle';
      s.targetId = fleetOrderTarget(o);
      s.order = o.order;
      s.squadId = e.squadId;
      s.squadLeaderId = e.squadId !== null ? (this.squads.get(e.squadId)?.leaderId ?? null) : null;
      out.push(s);
    }
    return out;
  }

  // ---- Internals -------------------------------------------------------------

  /** Fill `accepted` with the de-duplicated, attached ids the caller owns
   *  (first {@link FLEET_MAX_IDS_PER_COMMAND} ids only). Returns the count. */
  private collect(callerId: string, shipIds: readonly string[]): number {
    const acc = this.accepted;
    acc.length = 0;
    const gen = ++this.stampGen;
    const n = Math.min(shipIds.length, FLEET_MAX_IDS_PER_COMMAND);
    for (let i = 0; i < n; i++) {
      const id = shipIds[i]!;
      const e = this.byId.get(id);
      if (e === undefined || e.stamp === gen) continue;
      if (this.hooks.ownerOf(id) !== callerId) continue;
      e.stamp = gen;
      e.ownerId = callerId;
      acc.push(id);
    }
    return acc.length;
  }

  /** After `collect`: mark each touched squad whole (the command names every
   *  AI-flown member) or not. Sets `cmdStamp` = the collect generation. */
  private classifySquads(n: number): void {
    const gen = this.stampGen;
    for (let i = 0; i < n; i++) {
      const e = this.byId.get(this.accepted[i]!)!;
      if (e.squadId === null) continue;
      const sq = this.squads.get(e.squadId)!;
      if (sq.cmdStamp === gen) continue;
      sq.cmdStamp = gen;
      let whole = true;
      for (let k = 0; k < sq.memberIds.length; k++) {
        const m = this.byId.get(sq.memberIds[k]!);
        if (m !== undefined && m.stamp !== gen) { whole = false; break; }
      }
      sq.cmdWhole = whole;
    }
  }

  /** The ship the squad forms up on: the owner's piloted ship when it is a
   *  member (pilot-led; it also becomes the AI leader on release), else the
   *  squad's leader. */
  private squadLeader(sq: SquadState): string {
    const pilot = this.hooks.pilotShipOf !== undefined ? this.hooks.pilotShipOf(sq.ownerId) : null;
    if (pilot !== null && pilot !== sq.leaderId && !this.byId.has(pilot) && this.memberSquad.get(pilot) === sq.id) {
      sq.leaderId = pilot;
    }
    return sq.leaderId;
  }

  /** Give every attached member its role for `leader`: the leader (if AI-
   *  flown) flies the squad mode; the others follow it as a loose pack (RTS
   *  Part B slice 10: the room hands each role to the AI pilot brain through
   *  `modeSet`, read back with `squadFollowOf` / `escortTargetOf`).
   *  Event-driven (membership, leader or squad mode changed), never per tick. */
  private refreshSquad(sq: SquadState, leader: string): void {
    sq.dirty = false;
    sq.appliedLeader = leader;
    const ids = sq.memberIds;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k]!;
      const m = this.byId.get(id);
      if (m === undefined) continue;
      if (id === leader) {
        if (m.role !== ROLE_LEADER) {
          const wasMember = m.role === ROLE_MEMBER;
          if (sq.mode !== null) setFleetMode(m.orders, sq.mode, sq.modeData);
          else if (wasMember) setFleetMode(m.orders, 'defend');
          m.role = ROLE_LEADER;
        }
      } else m.role = ROLE_MEMBER;
      this.hooks.modeSet?.(id);
    }
  }

  /**
   * The ship `shipId` follows in its squad's pack: the squad leader (AI- or
   * pilot-flown) for a member, null for the leader, a ship outside a squad,
   * or before the roles are applied. An escort squad's ships follow the
   * escorted ship instead (`escortTargetOf`).
   */
  squadFollowOf(shipId: string): string | null {
    const e = this.byId.get(shipId);
    if (e === undefined || e.role !== ROLE_MEMBER || e.squadId === null) return null;
    return this.squads.get(e.squadId)?.appliedLeader ?? null;
  }

  /**
   * The ship `shipId` escorts: its squad's escort target when the squad
   * mode is Escort (every member, the leader too), else its own Escort mode's
   * ship, else null. Attached ships only.
   */
  escortTargetOf(shipId: string): string | null {
    const e = this.byId.get(shipId);
    if (e === undefined) return null;
    if (e.squadId !== null) {
      const sq = this.squads.get(e.squadId);
      if (sq !== undefined && sq.mode === 'escort') return sq.modeData.escortId ?? null;
      if (e.role === ROLE_MEMBER) return null;
    }
    return e.orders.mode === 'escort' ? e.orders.escortId : null;
  }

  /** Remove `shipId` from its squad (attached or not). The squad dissolves
   *  below {@link FLEET_SQUAD_MIN}; a removed leader hands over to the first
   *  AI-flown member. */
  private removeFromSquad(shipId: string): void {
    const sqId = this.memberSquad.get(shipId);
    if (sqId === undefined) return;
    this.memberSquad.delete(shipId);
    const e = this.byId.get(shipId);
    if (e) this.leaveRole(e);
    const sq = this.squads.get(sqId);
    if (!sq) return;
    const k = sq.memberIds.indexOf(shipId);
    if (k >= 0) sq.memberIds.splice(k, 1);
    if (sq.memberIds.length < FLEET_SQUAD_MIN) {
      this.dissolve(sq);
      return;
    }
    if (sq.leaderId === shipId) {
      let next = sq.memberIds[0]!;
      for (let i = 0; i < sq.memberIds.length; i++) {
        if (this.byId.has(sq.memberIds[i]!)) { next = sq.memberIds[i]!; break; }
      }
      sq.leaderId = next;
    }
    sq.dirty = true;
  }

  private dissolve(sq: SquadState): void {
    this.squads.delete(sq.id);
    const last = this.squadList.pop()!;
    if (last !== sq) {
      this.squadList[sq.index] = last;
      last.index = sq.index;
    }
    for (const id of sq.memberIds) {
      this.memberSquad.delete(id);
      const m = this.byId.get(id);
      if (m) this.leaveRole(m);
    }
  }

  /** The entry is no longer in a squad: drop the pack role (its mode
   *  resumes from where it is). */
  private leaveRole(e: FleetEntry): void {
    e.squadId = null;
    const had = e.role !== ROLE_NONE;
    e.role = ROLE_NONE;
    if (had) this.hooks.modeSet?.(e.id);
  }
}

const EMPTY: readonly string[] = [];

/** A JSON-safe copy of squad mode data, or null when empty. */
function copyModeData(md: FleetModeData): FleetSavedModeData | null {
  const out: FleetSavedModeData = {};
  if (md.x !== undefined && md.y !== undefined) { out.x = md.x; out.y = md.y; }
  if (md.route !== undefined) out.route = md.route.map((p) => [p[0], p[1]] as [number, number]);
  if (md.escortId !== undefined) out.escortId = md.escortId;
  return Object.keys(out).length > 0 ? out : null;
}
