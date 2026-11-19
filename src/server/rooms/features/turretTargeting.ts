/**
 * A1/B2/C2 + coastal defences — who a structure turret may shoot: the
 * player-turret drone grid, the NPC-turret relation grid, every hostile in
 * reach for per-mount fire control, and the hostile-pilot scan. Moved verbatim
 * out of `SectorRoom`; the room hands in live accessors. Per-tick path (#14):
 * grids, pools and result objects are allocated once, here.
 */
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import type { HostileActLedger } from '../../../core/relations/HostileActLedger.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { TurretTargetView } from '../../structures/StructureMountTicker.js';
import { NearestPointGrid } from '../../../core/spatial/NearestPointGrid.js';
import { targetClass } from '../../../core/combat/mountTargeting.js';
import { fillRangeShape } from '../../../core/combat/fireControlBearing.js';
import { mayBeInReach, maxShipRangeBound, type MountRangeTarget } from '../../../core/combat/mountReach.js';
import { isNpcOwner, parseOwner, relationOf, type RelationContext } from '../../../shared-types/relations.js';
import { allegianceOfKind, getShipKind } from '../../../shared-types/shipKinds.js';
import type { NpcAllegianceId } from '../../../shared-types/allegiances.js';
import { policyActsOnStanding, type FactionPolicy } from '../../../shared-types/factions.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF } from '../../../shared-types/sabLayout.js';

/** What turret targeting needs from the room; getters read the live field. */
export interface TurretTargetingHost {
  swarmRegistry: Pick<SwarmEntityRegistry, 'all'>;
  sabF32(): Float32Array;
  playerToSlot(): ReadonlyMap<string, number>;
  getActiveShip(playerId: string): ShipState | undefined;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  spectateParkedHull: ReadonlyMap<string, string>;
  engageablePilotHull(playerId: string): { ship: ShipState; pose: ShipPhysicsState } | null;
  visitParkedPilotHulls(visit: (pid: string, x: number, y: number) => void): void;
  relationCtx: RelationContext;
  hostileActs: Pick<HostileActLedger, 'size'>;
  isTurretTargetable(rec: SwarmEntityRecord): boolean;
  writeSwarmRangeShape(v: { -readonly [K in keyof MountRangeTarget]: MountRangeTarget[K] }, rec: SwarmEntityRecord): void;
  npcSideParty: Readonly<Record<NpcAllegianceId, string>>;
  policyOf(faction: string): FactionPolicy;
  /** Extent of the target grids (the sector's playable width). */
  gridBounds: number;
}

export class TurretTargeting {
  constructor(private readonly h: TurretTargetingHost) {}

  /**
   * A1 (plan soft-leaping-truffle v2) — turret targets via a uniform grid.
   * The A0 measurement put the per-turret linear scan of EVERY swarm entity at
   * 5 ms median / 12.6 ms max per 10 Hz tick at citadel scale. The grid holds
   * the turret-targetable kind-1 records (same filter, same registry order, so
   * `NearestPointGrid`'s tie rule reproduces the scan's winner exactly), built
   * once per turret tick in O(E) and rebuilt after any eviction. Allocation-free
   * in steady state: the result object is reused (callers consume it at once —
   * `tickTurrets` keeps only the entityId).
   */
  private readonly turretTargetGrid = new NearestPointGrid(512, this.h.gridBounds, 512);
  private readonly turretTargetRecs: SwarmEntityRecord[] = [];
  turretTargetGridFresh = false;
  private readonly turretTargetOut: { id: string; entityId: number; x: number; y: number; radius: number; playerId?: string } =
    { id: '', entityId: 0, x: 0, y: 0, radius: 0, playerId: undefined };

  /**
   * B2 (plan soft-leaping-truffle v3) — targets for NPC-owned turrets: every
   * NPC ship (drones, robots, traders) plus every ACTIVE player ship (#17:
   * lingering and pending hulls are not turret targets, the same set that opens
   * gates). Built lazily once per turret tick, like the drone grid; a turret
   * then keeps only candidates `relationOf` says are hostile to its owner.
   */
  private readonly npcTargetGrid = new NearestPointGrid(512, this.h.gridBounds, 512);
  private readonly npcTargetParty: string[] = [];
  private readonly npcTargetRecs: (SwarmEntityRecord | null)[] = [];
  npcTargetGridFresh = false;
  private npcTurretOwner = '';
  private readonly _npcTargetAccept = (i: number): boolean =>
    relationOf(this.npcTargetParty[i]!, this.npcTurretOwner, this.h.relationCtx) === 'hostile';

  private readonly _addParkedNpcTarget = (pid: string, x: number, y: number): void => {
    const i = this.npcTargetGrid.add(x, y);
    this.npcTargetParty[i] = pid;
    this.npcTargetRecs[i] = null;
  };

  private buildNpcTargetGrid(): void {
    const g = this.npcTargetGrid;
    g.reset();
    for (const rec of this.h.swarmRegistry.all()) {
      if (rec.kind !== 1) continue;
      const base = slotBase(rec.slot);
      const i = g.add(this.h.sabF32()[base + SLOT_X_OFF]!, this.h.sabF32()[base + SLOT_Y_OFF]!);
      this.npcTargetParty[i] = this.h.npcSideParty[allegianceOfKind(rec.shipKind)];
      this.npcTargetRecs[i] = rec;
    }
    for (const [playerId] of this.h.playerToSlot()) {
      const ship = this.h.getActiveShip(playerId);
      if (!ship || !ship.alive || !ship.isActive) continue;
      const pose = this.h.shipPoseCache.get(playerId);
      if (!pose) continue;
      const i = g.add(pose.x, pose.y);
      this.npcTargetParty[i] = playerId;
      this.npcTargetRecs[i] = null;
    }
    // ...plus the spectate-parked LINGERING hulls (#17: the ENGAGEABLE pilot
    // hull class; owner decision 2026-11-12), under the pilot's id.
    this.h.visitParkedPilotHulls(this._addParkedNpcTarget);
    g.build();
    this.npcTargetGridFresh = true;
  }

  private findNearestNpcTurretTarget(
    x: number,
    y: number,
    range: number,
    owner: string,
  ): { id: string; entityId: number; x: number; y: number; radius: number; playerId?: string } | null {
    if (!this.npcTargetGridFresh) this.buildNpcTargetGrid();
    this.npcTurretOwner = owner;
    const g = this.npcTargetGrid;
    const i = g.nearestWhere(x, y, range, this._npcTargetAccept);
    if (i < 0) return null;
    const out = this.turretTargetOut;
    out.x = g.x(i);
    out.y = g.y(i);
    const rec = this.npcTargetRecs[i];
    if (rec) {
      out.id = rec.id;
      out.entityId = rec.entityId;
      out.radius = rec.radius;
      out.playerId = undefined;
    } else {
      const playerId = this.npcTargetParty[i]!;
      out.id = playerId;
      out.entityId = -1;
      out.radius = getShipKind(this.h.engageablePilotHull(playerId)?.ship.kind).radius;
      out.playerId = playerId;
    }
    return out;
  }

  /** A1 — the player-turret drone grid, built once per turret tick. */
  private ensureTurretTargetGrid(): void {
    if (this.turretTargetGridFresh) return;
    const g = this.turretTargetGrid;
    const recs = this.turretTargetRecs;
    g.reset();
    recs.length = 0;
    for (const rec of this.h.swarmRegistry.all()) {
      if (rec.kind !== 1 || !this.h.isTurretTargetable(rec)) continue;
      const base = slotBase(rec.slot);
      g.add(this.h.sabF32()[base + SLOT_X_OFF]!, this.h.sabF32()[base + SLOT_Y_OFF]!);
      recs.push(rec);
    }
    g.build();
    this.turretTargetGridFresh = true;
  }

  /** Coastal defences — pooled target views + grid-index scratch for
   *  `collectTurretTargets` (grow once, reused every tick, #14). */
  private readonly turretViewPool: TurretTargetView[] = [];
  private readonly turretIdxScratch: number[] = [];

  /** Write pool view `n` (made on first use) and return it. */
  private turretView(n: number): TurretTargetView {
    let v = this.turretViewPool[n];
    if (!v) { v = { id: '', entityId: -1, x: 0, y: 0, vx: 0, vy: 0, cls: 'small', signature: 1 }; this.turretViewPool[n] = v; }
    return v;
  }

  private writeSwarmTurretView(n: number, rec: SwarmEntityRecord): TurretTargetView {
    const v = this.turretView(n);
    const b = slotBase(rec.slot);
    v.id = rec.id; v.entityId = rec.entityId; v.playerId = undefined;
    v.x = this.h.sabF32()[b + SLOT_X_OFF]!; v.y = this.h.sabF32()[b + SLOT_Y_OFF]!;
    v.vx = this.h.sabF32()[b + SLOT_VX_OFF]!; v.vy = this.h.sabF32()[b + SLOT_VY_OFF]!;
    const kind = getShipKind(rec.shipKind);
    v.cls = targetClass(kind);
    v.signature = rec.kind === 1 ? kind.radius : rec.radius;
    this.h.writeSwarmRangeShape(v, rec);
    return v;
  }

  private writePilotTurretView(n: number, playerId: string): TurretTargetView | null {
    // #17: the ENGAGEABLE pilot hull (ACTIVE, or parked by Spectate).
    const h = this.h.engageablePilotHull(playerId);
    if (!h) return null;
    const pose = h.pose;
    const v = this.turretView(n);
    v.id = playerId; v.entityId = -1; v.playerId = playerId;
    v.x = pose.x; v.y = pose.y; v.vx = pose.vx; v.vy = pose.vy;
    const kind = getShipKind(h.ship.kind);
    v.cls = targetClass(kind);
    v.signature = kind.radius;
    fillRangeShape(v, pose.angle, true, h.ship.kind, h.ship.shield > 0, 0);
    return v;
  }

  /**
   * Coastal defences (plan coastal-defences) — EVERY target hostile to `owner`
   * within `range` of (x, y), with its velocity and target class, for the
   * per-mount fire control (each gun picks by its calibre's priority). Same
   * target rules as `findNearestTurretTarget`: an NPC turret takes whatever
   * `relationOf` says is hostile (players included); a player turret takes
   * combat drones/robots (never traders) and, once anyone has committed a
   * hostile act or by policy, hostile pilots. Allocation-free in steady state.
   */
  collectTurretTargets(x: number, y: number, range: number, owner: string, out: TurretTargetView[]): number {
    const idx = this.turretIdxScratch;
    let n = 0;
    // Fire range is measured from each mount to the target's hull (owner
    // 2026-11-14): gather every ship whose hull MAY come within `range`
    // (grid query widened by the largest ship bound, then each candidate by
    // its own bound, `mountRangeBound`); the mounts' `mountCanEngage` decides.
    const wide = range + maxShipRangeBound();
    if (isNpcOwner(owner)) {
      if (!this.npcTargetGridFresh) this.buildNpcTargetGrid();
      this.npcTurretOwner = owner;
      const k = this.npcTargetGrid.within(x, y, wide, idx);
      for (let j = 0; j < k; j++) {
        const i = idx[j]!;
        if (!this._npcTargetAccept(i)) continue;
        const rec = this.npcTargetRecs[i];
        const v = rec ? this.writeSwarmTurretView(n, rec) : this.writePilotTurretView(n, this.npcTargetParty[i]!);
        if (v && mayBeInReach(v.x - x, v.y - y, range, v)) out[n++] = v;
      }
      return n;
    }
    this.ensureTurretTargetGrid();
    const k = this.turretTargetGrid.within(x, y, wide, idx);
    for (let j = 0; j < k; j++) {
      const v = this.writeSwarmTurretView(n, this.turretTargetRecs[idx[j]!]!);
      if (mayBeInReach(v.x - x, v.y - y, range, v)) out[n++] = v;
    }
    if (this.h.hostileActs.size() > 0 || policyActsOnStanding(this.h.policyOf(parseOwner(owner).faction))) {
      const r2 = wide * wide;
      for (const [pid] of this.h.playerToSlot()) {
        if (pid === owner) continue;
        const ship = this.h.getActiveShip(pid);
        if (!ship?.alive || !ship.isActive) continue;
        const pose = this.h.shipPoseCache.get(pid);
        if (!pose || (pose.x - x) ** 2 + (pose.y - y) ** 2 > r2) continue;
        if (relationOf(pid, owner, this.h.relationCtx) !== 'hostile') continue;
        const v = this.writePilotTurretView(n, pid);
        if (v && mayBeInReach(v.x - x, v.y - y, range, v)) out[n++] = v;
      }
      // #17 ENGAGEABLE pilot hulls: the spectate-parked LINGERING ones too.
      for (const pid of this.h.spectateParkedHull.keys()) {
        if (pid === owner) continue;
        const h = this.h.engageablePilotHull(pid);
        if (!h || h.ship.isActive) continue; // ACTIVE: covered above
        if ((h.pose.x - x) ** 2 + (h.pose.y - y) ** 2 > r2) continue;
        if (relationOf(pid, owner, this.h.relationCtx) !== 'hostile') continue;
        const v = this.writePilotTurretView(n, pid);
        if (v && mayBeInReach(v.x - x, v.y - y, range, v)) out[n++] = v;
      }
    }
    return n;
  }

  findNearestTurretTarget(
    x: number,
    y: number,
    range: number,
    owner: string,
  ): { id: string; entityId: number; x: number; y: number; radius: number; playerId?: string } | null {
    // B2 — NPC-owned turrets engage by relation (players included); player
    // turrets keep the A1 drone grid below, unchanged.
    if (isNpcOwner(owner)) return this.findNearestNpcTurretTarget(x, y, range, owner);
    this.ensureTurretTargetGrid();
    const i = this.turretTargetGrid.nearest(x, y, range);
    // C2 — a player's turrets also engage pilots hostile to their owner (a
    // break-in is a hostile act). Skipped entirely while nobody has committed
    // one, so the A1 drone path stays byte-identical.
    // F3 — a player whose policy fires on low standing scans pilots too.
    const pilot = this.h.hostileActs.size() > 0 || policyActsOnStanding(this.h.policyOf(parseOwner(owner).faction))
      ? this.nearestHostilePilot(x, y, range, owner)
      : null;
    if (pilot !== null) {
      const droneD2 = i < 0 ? Infinity : (this.turretTargetGrid.x(i) - x) ** 2 + (this.turretTargetGrid.y(i) - y) ** 2;
      if (pilot.d2 <= droneD2) {
        const out = this.turretTargetOut;
        out.id = pilot.playerId;
        out.entityId = -1;
        out.x = pilot.x;
        out.y = pilot.y;
        out.radius = getShipKind(this.h.engageablePilotHull(pilot.playerId)?.ship.kind).radius;
        out.playerId = pilot.playerId;
        return out;
      }
    }
    if (i < 0) return null;
    const rec = this.turretTargetRecs[i]!;
    const out = this.turretTargetOut;
    out.playerId = undefined;
    out.id = rec.id;
    out.entityId = rec.entityId;
    out.x = this.turretTargetGrid.x(i);
    out.y = this.turretTargetGrid.y(i);
    out.radius = rec.radius;
    return out;
  }

  /** C2 — the nearest ENGAGEABLE pilot hull (#17: ACTIVE alive, or parked by
   *  Spectate) within range whose pilot is hostile to `owner` (an act in the
   *  ledger). Few players: a plain scan. */
  private nearestHostilePilot(x: number, y: number, range: number, owner: string): { playerId: string; x: number; y: number; d2: number } | null {
    const out = this._hostilePilotOut;
    let best = range * range;
    let found = false;
    for (const [pid] of this.h.playerToSlot()) {
      if (pid === owner) continue;
      const ship = this.h.getActiveShip(pid);
      if (!ship?.alive || !ship.isActive) continue;
      const pose = this.h.shipPoseCache.get(pid);
      if (!pose) continue;
      const d2 = (pose.x - x) ** 2 + (pose.y - y) ** 2;
      if (d2 > best) continue;
      if (relationOf(pid, owner, this.h.relationCtx) !== 'hostile') continue;
      best = d2;
      out.playerId = pid; out.x = pose.x; out.y = pose.y; out.d2 = d2;
      found = true;
    }
    // #17 ENGAGEABLE pilot hulls: the spectate-parked LINGERING ones too.
    for (const pid of this.h.spectateParkedHull.keys()) {
      if (pid === owner) continue;
      const h = this.h.engageablePilotHull(pid);
      if (!h || h.ship.isActive) continue; // ACTIVE: covered above
      const d2 = (h.pose.x - x) ** 2 + (h.pose.y - y) ** 2;
      if (d2 > best) continue;
      if (relationOf(pid, owner, this.h.relationCtx) !== 'hostile') continue;
      best = d2;
      out.playerId = pid; out.x = h.pose.x; out.y = h.pose.y; out.d2 = d2;
      found = true;
    }
    return found ? out : null;
  }
  private readonly _hostilePilotOut = { playerId: '', x: 0, y: 0, d2: 0 };
}
