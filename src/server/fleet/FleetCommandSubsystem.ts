/**
 * Fleet command subsystem (RTS command layer, slice 3).
 *
 * Every ship a player owns is flown by a wingman brain unless the owner is
 * flying it. This subsystem holds one `WingmanBehaviour` per such ship (the
 * room's LINGERING hulls, wired in slice 4), takes the owner's commands
 * (orders / modes / stances / squads) and, on the room tick, re-plans each
 * brain at ~10 Hz and posts the resulting PLAYER CONTROL BITS through the same
 * physics-worker INPUT path a pilot's keys use (owner rule: AI ships fly with
 * player controls only).
 *
 * Decision logic over injected hooks, the `SelectionStatsSubsystem` /
 * `TransitOrchestrator` shape: no live room needed to test it.
 *
 * Commands are owner-validated PER SHIP through `hooks.ownerOf`: a foreign or
 * unknown id is silently dropped (never an error to the client), and at most
 * `FLEET_MAX_IDS_PER_COMMAND` ids are read per command.
 *
 * Hot path (`tick`) is allocation-free (#14): entries live in a dense array,
 * pose / view scratch are fields, each brain's last controls are copied into a
 * per-entry object it keeps. Command handlers (`onMessage`, #14) reuse one
 * accepted-ids scratch array; the returned array is valid until the next call.
 *
 * Kill switch: `EQX_DISABLE_WINGMEN=1` (read at construction) makes `attach`
 * a no-op, so no ship is ever AI-flown.
 */
import { WingmanBehaviour, type WingmanConfig } from '../../core/ai/WingmanBehaviour.js';
import {
  makeWingmanControls,
  reverseAccelFor,
  type WingmanControls,
  type WingmanMode,
  type WingmanOrder,
  type WingmanPoseOut,
  type WingmanShipStats,
  type WingmanStance,
  type WingmanActivity,
  type WingmanWorldView,
} from '../../core/ai/wingman/types.js';
import { fnv1a32 } from '../../core/random/rng.js';
import { deriveStatMultipliers, type StatAlloc } from '../../core/leveling/shipStats.js';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { massOf, shipTuning } from '../../shared-types/shipScale/tuning.js';

/** Most ship ids read from one command (the rest are ignored). */
export const FLEET_MAX_IDS_PER_COMMAND = 64;
/** Squad size limits. */
export const FLEET_SQUAD_MIN = 2;
export const FLEET_SQUAD_MAX = 24;
/** Re-plan each brain every Nth server tick (60 Hz / 6 = 10 Hz). */
export const FLEET_REPLAN_EVERY_TICKS = 6;

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
  /** Write the ship's live pose into `out`; false if it is gone (skip). */
  readPose(shipId: string, out: FleetPose): boolean;
  /** Post the controls as the ship's INPUT for `tick`. `controls` is the
   *  entry's own object: read it now, do not keep it. */
  postInput(shipId: string, controls: Readonly<WingmanControls>, tick: number): void;
  /** The energy gate that strips a pilot's boost bit (`canAfford(energy,
   *  BOOST_TICK_COST)`). Absent ⇒ boost always allowed. Re-checked every tick
   *  while a ship holds boost, so a drained pool stops it between re-plans. */
  canBoost?(shipId: string): boolean;
  /** Attack orders / escort: resolve another entity's live pose. Absent ⇒ an
   *  attack order completes at once and an escort defends where it is. */
  resolvePoseInto?(id: string, out: WingmanPoseOut): boolean;
  /** Hunt mode: the contact hostile to `shipId`'s owner that the ship should
   *  chase, within `maxRange` of (x, y): write its pose into `out`, return its
   *  id, or null. Target choice lives here (the targeting slice). Absent ⇒
   *  hunt defends. */
  nearestHostile?(shipId: string, x: number, y: number, maxRange: number, out: WingmanPoseOut): string | null;
  /** The ship `playerId` is flying right now (escort may follow it), or null. */
  pilotShipOf?(playerId: string): string | null;
}

/** `set_mode` parameters (the wire message's optional fields). */
export interface FleetModeData {
  x?: number;
  y?: number;
  route?: readonly (readonly [number, number])[];
  escortId?: string;
}

export interface FleetCommandOptions {
  /** Re-plan cadence in server ticks (default {@link FLEET_REPLAN_EVERY_TICKS}). */
  replanEvery?: number;
  /** Override the env kill switch (tests). */
  disabled?: boolean;
}

/** What the brain needs from the ship: its (scaled) kind and its upgrades. */
export interface FleetShipInputs {
  kind: ShipKind;
  statAlloc?: StatAlloc;
  /** The ship's fire range (u) for the role sensor range (hunt). Absent ⇒
   *  the `ON_SIGHT_ENGAGE_RANGE` floor. */
  fireRange?: number;
}

/** One ship's line in the status stream. */
export interface FleetShipStatus {
  id: string;
  mode: WingmanMode;
  stance: WingmanStance;
  activity: WingmanActivity;
  targetId: string | null;
  order: WingmanOrder | null;
  squadId: string | null;
}

export interface FleetSquad {
  readonly id: string;
  readonly ownerId: string;
  leaderId: string;
  readonly memberIds: string[];
}

interface FleetEntry {
  readonly id: string;
  ownerId: string;
  readonly brain: WingmanBehaviour;
  squadId: string | null;
  /** Re-plan phase: the brain re-plans when (tick + phase) % N === 0. */
  readonly phase: number;
  /** Index in the dense `entries` array (kept on swap-remove). */
  index: number;
  /** Last posted controls (held between re-plans). */
  readonly controls: WingmanControls;
  /** Command de-dup stamp. */
  stamp: number;
}

/**
 * The wingman config for a kind + upgrade allocation: the same multipliers
 * `applyShipInput` applies (topSpeed scales thrust and the speed cap, turnRate
 * the turn), mass from the catalogue exactly as `World.spawnShip` sets it, and
 * the size-dependent radii from `shipTuning` (#18).
 */
export function wingmanConfigFor(kind: ShipKind, statAlloc?: StatAlloc, fireRange?: number): WingmanConfig {
  const mul = deriveStatMultipliers(statAlloc);
  const mass = massOf(kind, 1);
  const stats: WingmanShipStats = {
    maxSpeed: kind.maxSpeed * mul.topSpeed,
    linearDamping: kind.linearDamping,
    maxAngvel: kind.maxAngvel * mul.turnRate,
    angularDamping: kind.angularDamping,
    ...(kind.turnTorque !== undefined ? { turnTorque: kind.turnTorque * mul.turnRate } : {}),
    reverseAccel: reverseAccelFor(kind, mass, mul.topSpeed),
  };
  const t = shipTuning(kind);
  return {
    stats,
    arriveRadius: t.wingmanArrive,
    guardRadius: t.guardRadiusMin,
    aiRole: kind.aiRole,
    ...(fireRange !== undefined ? { fireRange } : {}),
  };
}

export class FleetCommandSubsystem {
  private readonly byId = new Map<string, FleetEntry>();
  private readonly entries: FleetEntry[] = [];
  private readonly squads = new Map<string, FleetSquad>();
  private readonly replanEvery: number;
  private readonly disabled: boolean;
  private nextPhase = 0;
  private nextSquad = 1;
  private stampGen = 0;

  private readonly pose: FleetPose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
  private readonly view: WingmanWorldView & { tick: number };
  /** The ship whose brain is ticking (the view's hunt query is per ship). */
  private tickingId = '';
  private readonly modeScratch: FleetModeData = {};
  private readonly accepted: string[] = [];
  private readonly statusOut: FleetShipStatus[] = [];
  private readonly statusPool: FleetShipStatus[] = [];

  constructor(private readonly hooks: FleetCommandHooks, opts: FleetCommandOptions = {}) {
    this.replanEvery = Math.max(1, Math.floor(opts.replanEvery ?? FLEET_REPLAN_EVERY_TICKS));
    this.disabled = opts.disabled ?? isWingmenDisabled();
    this.view = { tick: 0 };
    if (hooks.resolvePoseInto) this.view.resolvePoseInto = (id, out) => hooks.resolvePoseInto!(id, out);
    if (hooks.nearestHostile) {
      this.view.nearestHostile = (x, y, r, out) => hooks.nearestHostile!(this.tickingId, x, y, r, out);
    }
  }

  get isDisabled(): boolean { return this.disabled; }
  get size(): number { return this.entries.length; }
  isAttached(shipId: string): boolean { return this.byId.has(shipId); }

  /** Read-only peek at a ship's brain (tests / diagnostics). */
  brainOf(shipId: string): WingmanBehaviour | null { return this.byId.get(shipId)?.brain ?? null; }

  squad(squadId: string): Readonly<FleetSquad> | null { return this.squads.get(squadId) ?? null; }

  // ---- Lifecycle (low-frequency: hull parked / reclaimed) -----------------

  /**
   * Hand `shipId` to a wingman: Defend at `initialPose`, Defensive stance.
   * Re-attaching an attached ship replaces its brain. No-op under the kill
   * switch.
   */
  attach(shipId: string, ownerId: string, ship: FleetShipInputs, initialPose: { x: number; y: number }): void {
    if (this.disabled) return;
    if (this.byId.has(shipId)) this.detach(shipId);
    const brain = new WingmanBehaviour({
      ...wingmanConfigFor(ship.kind, ship.statAlloc, ship.fireRange),
      mode: 'defend',
      stance: 'defensive',
      moraleSeedId: fnv1a32(shipId),
    });
    brain.setGuardPost(initialPose.x, initialPose.y);
    const entry: FleetEntry = {
      id: shipId,
      ownerId,
      brain,
      squadId: null,
      phase: this.nextPhase,
      index: this.entries.length,
      controls: makeWingmanControls(),
      stamp: 0,
    };
    this.nextPhase = (this.nextPhase + 1) % this.replanEvery;
    this.entries.push(entry);
    this.byId.set(shipId, entry);
  }

  /** Stop flying `shipId` (its owner took the helm, or it is gone). */
  detach(shipId: string): void {
    const e = this.byId.get(shipId);
    if (!e) return;
    if (e.squadId !== null) this.leaveSquad(e);
    this.byId.delete(shipId);
    const last = this.entries.pop()!;
    if (last !== e) {
      this.entries[e.index] = last;
      last.index = e.index;
    }
  }

  // ---- Commands (onMessage; owner-validated per id) -----------------------

  /** Issue `order` to every owned ship in `shipIds`. Returns the accepted ids. */
  applyOrder(callerId: string, shipIds: readonly string[], order: WingmanOrder): readonly string[] {
    const n = this.collect(callerId, shipIds);
    for (let i = 0; i < n; i++) this.byId.get(this.accepted[i]!)!.brain.issueOrder(order);
    return this.accepted;
  }

  /**
   * Set the standing mode. `data`: `x`/`y` = the defend / hunt post or the
   * retreat point; `route` = patrol waypoints; `escortId` = the ship to
   * escort. An escort target must be one of the caller's own ships or the
   * ship the caller is flying (`pilotShipOf`), and never the ship itself;
   * otherwise the id is dropped and that ship defends where it is.
   */
  setMode(
    callerId: string,
    shipIds: readonly string[],
    mode: WingmanMode,
    data?: FleetModeData,
  ): readonly string[] {
    const n = this.collect(callerId, shipIds);
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
      md.escortId = escortOk && escortId !== id ? escortId : undefined;
      this.byId.get(id)!.brain.setMode(mode, md);
    }
    md.route = undefined;
    return this.accepted;
  }

  /**
   * The AI-flown `shipId` took damage (the room's damage path calls this).
   * Feeds its morale; a FallBack / Flee roll makes it break off and retreat
   * away from (threatX, threatY). Unknown ids are ignored.
   */
  noteDamage(shipId: string, amount: number, maxHull: number, hullFrac: number, threatX?: number, threatY?: number): void {
    this.byId.get(shipId)?.brain.reportDamage(amount, maxHull, hullFrac, threatX, threatY);
  }

  setStance(callerId: string, shipIds: readonly string[], stance: WingmanStance): readonly string[] {
    const n = this.collect(callerId, shipIds);
    for (let i = 0; i < n; i++) this.byId.get(this.accepted[i]!)!.brain.setStance(stance);
    return this.accepted;
  }

  /**
   * Group the caller's owned, AI-flown ships into a new squad (first accepted
   * id leads). Ships leave any squad they were in. Fewer than
   * {@link FLEET_SQUAD_MIN} or more than {@link FLEET_SQUAD_MAX} accepted ids
   * ⇒ nothing changes and null. Data only: formation flying is a later slice.
   */
  formSquad(callerId: string, shipIds: readonly string[]): { squadId: string; memberIds: readonly string[] } | null {
    const n = this.collect(callerId, shipIds);
    if (n < FLEET_SQUAD_MIN || n > FLEET_SQUAD_MAX) return null;
    const memberIds = this.accepted.slice(0, n);
    for (const id of memberIds) {
      const e = this.byId.get(id)!;
      if (e.squadId !== null) this.leaveSquad(e);
    }
    const squadId = `sq-${this.nextSquad++}`;
    this.squads.set(squadId, { id: squadId, ownerId: callerId, leaderId: memberIds[0]!, memberIds });
    for (const id of memberIds) this.byId.get(id)!.squadId = squadId;
    return { squadId, memberIds };
  }

  /** Disband the caller's squad. Returns its former members (empty if not theirs). */
  disbandSquad(callerId: string, squadId: string): readonly string[] {
    const sq = this.squads.get(squadId);
    if (!sq || sq.ownerId !== callerId) return EMPTY;
    this.squads.delete(squadId);
    for (const id of sq.memberIds) {
      const e = this.byId.get(id);
      if (e) e.squadId = null;
    }
    return sq.memberIds;
  }

  // ---- Per-tick ------------------------------------------------------------

  /**
   * Room tick. Each brain re-plans every `replanEvery` ticks, staggered by its
   * attach phase, and posts its controls; between re-plans the worker holds
   * the last input (input-queue rule #3). A held boost is re-checked against
   * the energy gate every tick and re-posted without it once unaffordable.
   */
  tick(serverTick: number): void {
    const list = this.entries;
    if (list.length === 0) return;
    const hooks = this.hooks;
    const N = this.replanEvery;
    const r = ((serverTick % N) + N) % N;
    this.view.tick = serverTick;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const c = e.controls;
      if ((r + e.phase) % N === 0) {
        if (!hooks.readPose(e.id, this.pose)) continue;
        this.tickingId = e.id;
        const out = e.brain.tick(this.pose, this.view);
        c.thrust = out.thrust;
        c.reverse = out.reverse;
        c.turnLeft = out.turnLeft;
        c.turnRight = out.turnRight;
        c.boost = out.boost && (hooks.canBoost === undefined || hooks.canBoost(e.id));
        hooks.postInput(e.id, c, serverTick);
      } else if (c.boost && hooks.canBoost !== undefined && !hooks.canBoost(e.id)) {
        c.boost = false;
        hooks.postInput(e.id, c, serverTick);
      }
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
        s = { id: '', mode: 'defend', stance: 'defensive', activity: 'idle', targetId: null, order: null, squadId: null };
        this.statusPool.push(s);
      }
      const b = e.brain;
      s.id = e.id;
      s.mode = b.mode;
      s.stance = b.stance;
      s.activity = b.activity;
      s.targetId = b.targetId;
      s.order = b.order;
      s.squadId = e.squadId;
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

  private leaveSquad(e: FleetEntry): void {
    const sq = this.squads.get(e.squadId!);
    e.squadId = null;
    if (!sq) return;
    const k = sq.memberIds.indexOf(e.id);
    if (k >= 0) sq.memberIds.splice(k, 1);
    if (sq.memberIds.length < FLEET_SQUAD_MIN) {
      this.squads.delete(sq.id);
      for (const id of sq.memberIds) {
        const m = this.byId.get(id);
        if (m) m.squadId = null;
      }
      return;
    }
    if (sq.leaderId === e.id) sq.leaderId = sq.memberIds[0]!;
  }
}

const EMPTY: readonly string[] = [];
