/**
 * Server-side registry of placed structures (speed-dial-resource-structures
 * plan, Phase 2 + 3). Owns the per-structure bookkeeping the swarm registry does
 * NOT carry: ownership, the structure subtype, construction state, the stored
 * mineral pool, and (Phase 3) the connection adjacency map for the power grid.
 *
 * Session-scoped per `SectorRoom` (persistence is a noted follow-up).
 */
import type { RecipeId } from '../../shared-types/recipes.js';
import type { ProdState } from '../../shared-types/production.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { BlueprintItem, PackedItem } from '../../shared-types/items.js';
import type { Hold } from '../../shared-types/goods.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { TeleportPartner, TeleportRules, TeleportToll, TpPhase } from '../../shared-types/teleport.js';
import { CABLE_NO_SOCKET, Connection } from '../../core/structures/Connection.js';
import type { PlayingClip } from '../../core/articulation/evaluate.js';
import type { SavedDoor } from '../../core/structures/gateLogic.js';
import { noteBaseFall, orphanBaseOnCapitalLoss } from './ownerlessBase.js';
import { isNpcOwner } from '../../shared-types/relations.js';
import { PlateSet } from '../../core/hex/plateSet.js';

export interface StructureRecord {
  /** Swarm entity id (also the binary-wire id). */
  id: string;
  /** Owning playerId. */
  owner: string;
  /** Structure subtype. */
  kind: StructureKindId;
  /** Index into `STRUCTURE_KINDS_LIST` (the wire subtype byte). */
  subtypeIndex: number;
  /** World pose (structures are static — set once at placement). */
  x: number;
  y: number;
  /** Collider + sprite radius (from the kind catalogue). */
  radius: number;
  /** Phase V — rotation in degrees (0/90/180/270) and the rotated footprint's
   *  half extents (cached at placement; the box every rule reads). */
  rot?: number;
  /** Build mirror: placed left-right flipped (x → −x in its local frame,
   *  before `rot`; `structureLocalToWorld`). Absent ⇒ not mirrored. */
  mirror?: boolean;
  halfW?: number;
  halfH?: number;
  /** False while a blueprint; flips true when the grid finishes building it.
   *  The Capital is born `true` (pre-built). */
  isConstructed: boolean;
  /** Hologram pass-through: its body was spawned as a blueprint and still
   *  collides with nothing (`BLUEPRINT_COLLISION_GROUPS`). Cleared when it
   *  turns solid (`settleBlueprintBody`). Server-only, never saved. */
  ghostBody?: boolean;
  /** Minerals delivered so far (0..constructionCost). */
  constructionProgress: number;
  /** Total minerals to fully build. 0 for the pre-built Capital. */
  constructionCost: number;
  /** True while the player is reclaiming this structure (Phase 3 deconstruct). */
  isDeconstructing: boolean;
  /** Minerals currently stored here. Only the Capital has meaningful
   *  `storageCapacity`; it is the bank the construction stream draws from.
   *  A Miner buffers locally here before hauling toward the Capital. */
  minerals: number;
  /** Living World P1a-2 — a STABLE identity that survives a server restart
   *  (entity ids are re-minted on restore). Deterministic hash of
   *  (sector, owner, kind, rounded pose) — all persisted — so a restored
   *  structure recomputes the same uid with no snapshot field. Keys the
   *  structure's row in the `holds` table. Absent only on test fixtures. */
  uid?: string;
  /** A2 — cached decimal entityId: this structure's key in the room-state
   *  `structures` map (avoids a String() allocation per sync). */
  stateKey?: string;
  /** Living World P1a-2 — deposited cargo (goods / credits / blueprints) for a
   *  storage kind (`holdCapacity > 0`). Minerals DELIVERED to a Capital stay in
   *  `minerals` (they fund construction). Absent ⇒ empty. */
  hold?: Hold;
  /** v4 T1 — teleporters. The capacitor (charge so far), the partner, the
   *  owner's firing rules, the pad's own hold (NOT base storage), the running
   *  jump cycle, and the board/arrival bookkeeping. */
  tpCharge?: number;
  tpPartner?: TeleportPartner;
  tpRules?: TeleportRules;
  padHold?: Hold;
  tpPhase?: TpPhase;
  tpPhaseEndsAtMs?: number;
  /** True on the end that fired (it spends the charge at the swap). */
  tpInitiator?: boolean;
  /** When a ship first sat on the pad (for "when a ship boards"). */
  tpBoardedSinceMs?: number;
  /** Goods just arrived on the pad: unload them into storage next pulse. */
  tpArrived?: boolean;
  /** v4 A — an alien gate's next timetabled jump (ms since epoch). */
  tpNextJumpMs?: number;
  /** v4 A — the sector an alien gate leads to (its twin faces back here). */
  alienNeighbour?: string;
  /** v4 H — the transit link an NPC teleporter ends (its twin has the same id). */
  npcLink?: string;
  /** Capture plan 4E (S6) — the NPC base this structure was grown in (its
   *  seed owner, `npc:<faction>:<baseId>`). Kept when the base falls
   *  (`none:`) or is captured, so the seeder never regrows it. Persisted. */
  originBase?: string;
  /** T4 — its toll (credits per 1000 charge; what happens to non-payers). */
  tpToll?: TeleportToll;
  /** T2 — its iris walls and push field exist in the physics worker. */
  tpIrisSpawned?: boolean;
  /** Stored power for a Battery (0..the kind's `powerStorageCapacity`). It
   *  charges from the component's surplus each pulse, discharges to keep the
   *  component `powered` through a deficit, and is drained first by shield-wall
   *  hits. 0 on every non-battery kind (they have no `powerStorageCapacity`). */
  storedPower: number;
  /** Structure-restyle 2d: the rig clip playing on this structure (kinds with
   *  a rig, `rigForStructureKind`), the whole deterministic record
   *  `{clipId, startTick, target?}` (`PlayingClip`; game ticks, target in
   *  the structure's frame). Set ONLY by `startStructureRigClip`
   *  (structureRigClip.ts), which also tells the physics worker. Absent / null
   *  ⇒ the rig rests. Not on the wire yet: slice 2e adds it to the
   *  `structureStateWire.ts` row (late join, invariant #16). */
  rigClip?: PlayingClip | null;
  /** Gates: who the gate opens for (GATE_ACCESS_IDS index; absent ⇒ default). */
  gateAccess?: number;
  /** Gates: a hydrated save's door position, consumed by the GateController
   *  when it first builds the gate's state (door-power slice 12). */
  doorRestore?: SavedDoor;
  /** Phase 4 (Leveling & XP, WS-B4) — structure level (≥ 1). A fresh structure
   *  is level 1; a paid Upgrade build phase increments it and applies the
   *  per-level stat grant (HP / turret range+damage / power output / storage).
   *  Persisted in the sector snapshot; rides the live `structures[]` wire slice
   *  so the client shows the `LVL n` line + gates the Upgrade affordance. */
  level: number;
  /** Phase 4 (Leveling & XP, WS-B4) — while an UPGRADE build phase is running,
   *  the level being built TOWARD (`level + 1`). Set when the upgrade starts
   *  (which flips `isConstructed` false + resets `constructionProgress`); on the
   *  build's completion the subsystem increments `level` to this and clears it.
   *  Undefined for a normal (initial) construction — that completes without
   *  bumping the level. */
  upgradeTargetLevel?: number;
  /** Phase 4 — the asteroid entityId this Miner is currently extracting from
   *  (for the client beam). Transient; recomputed each pulse, undefined when
   *  not a miner / unpowered / no asteroid in range. */
  miningTargetEntityId?: number;
  /** WS-4 Phase 2 — cached pose of the target asteroid (static, so the 1 Hz
   *  pulse's value is stable between pulses), so the faster mining-beam tick
   *  can broadcast the beam endpoint without re-scanning. Cleared with the
   *  target. */
  miningTargetX?: number;
  miningTargetY?: number;
  /** P1b — cached radius of the target asteroid, so the mining beam can be
   *  CLIPPED at its surface (cut at impact) rather than driven to the centre. */
  miningTargetRadius?: number;
  /** P1b — the RESOLVED mining-beam endpoint: the asteroid surface, OR the nearest
   *  structure that blocks the line of sight to it (so the beam stops AT a
   *  building instead of shooting through). Cached by `processMining`, broadcast
   *  by `tickMiners`. */
  miningClipX?: number;
  miningClipY?: number;
  /** P1b — true when a built structure sits between the Miner and its target
   *  asteroid (the beam is blocked) ⇒ no ore is drawn that pulse. */
  miningBeamBlocked?: boolean;
  /** WS-4 — pre-built `swarm-<entityId>` wire id for the mining-beam target,
   *  cached so `tickMiners` (the ~5 Hz broadcast) never allocates a template
   *  string. Rebuilt by `processMining` ONLY when the target rock CHANGES (the
   *  steady-state mining a single rock allocates nothing). Cleared with the
   *  target. */
  miningTargetWireId?: string;
  /** WS-4 Phase 2 — wall-clock ms of this Miner's last mining-beam broadcast
   *  (the beam cadence gate, keeps the beam continuous without spamming wire). */
  lastMiningBeamMs?: number;
  /** Phase 5 — the drone entityId this Turret is aiming at (for the client aim
   *  line). Transient; recomputed each turret tick. */
  turretTargetEntityId?: number;
  /** B2 — playerId this turret is aiming at (NPC turrets only), or undefined.
   *  Mutually exclusive with `turretTargetEntityId`. */
  turretTargetPlayer?: string;
  /** Economy v2 W4b — placed from a PACKED item: its build costs only time
   *  (no minerals drawn) and deconstructing it reclaims none. Persisted. */
  prepaid?: boolean;
  /** Economy v2 — the packed item's quality (prepaid structures): a
   *  deconstruct repacks it at this quality. Persisted. */
  packedQuality?: number;
  // ── Production (plan soft-leaping-truffle v3, P2b) ──
  /** The recipe the owner picked (absent ⇒ the kind's default). Persisted. */
  recipe?: RecipeId;
  /** Inputs for the current cycle are taken (persisted with progress). */
  prodLoaded?: boolean;
  /** Pulses into the current cycle. */
  prodProgress?: number;
  /** Status (`PROD_STATE`), refreshed each pulse; rides room state. */
  prodState?: ProdState;
  /** The input a starved processor is waiting for. */
  prodMissing?: GoodId;
  /** Blueprint loaded in the processor slot (Living World W2 item). Persisted
   *  as the slot hold `bpslot:<uid>`. */
  blueprint?: BlueprintItem;
  /** Quality and yield bonus captured when the current cycle started. */
  prodQuality?: number;
  prodYield?: number;
  /** Cycles completed (seeds the deterministic yield roll). */
  prodCycles?: number;
  /** Build count (job 2E): outputs left before it stops (0 ⇒ done, state
   *  `done`). Absent ⇒ repeat forever. Persisted; rides room state. */
  prodCount?: number;
  /** Recipe queue (building panels B2): the entries AFTER the head (`recipe`),
   *  each ONE build. Present ⇒ queue mode (`productionQueue.ts`); cleared by
   *  `set_recipe`. Not persisted or on the wire yet. */
  prodQueue?: RecipeId[];
  /** Queue repeat: a finished head goes to the back instead of dropping off. */
  prodQueueRepeat?: boolean;
  /** Building panels B7: bit i = network storage holds a blueprint for the
   *  kind's recipe i (`blueprintStock.ts`, 1 Hz). Derived; not persisted. */
  bpAvail?: number;
  /** A chunk recipe's loaded item (a rock chunk) with the ore still to pay
   *  out; set while `prodLoaded`. Persisted (it holds value). */
  prodChunk?: PackedItem;
  /** T4b — standing import/export orders on a player's Freight Dock. */
  freightOrders?: Array<{ good: GoodId; mode: 'import' | 'export'; level: number }>;
  /** Cargo pods 14c — false: this storage refuses auto-unload (absent ⇒ accepts). */
  acceptAutoUnload?: boolean;
  /** Active power — drawing full consumption this pulse (else the idle trickle). */
  drawFull?: boolean;
  /** The owner switched it OFF: draws nothing and does no work (reads
   *  unpowered to every subsystem). Persisted; rides as STRUCTURE_FLAG_OFF. */
  switchedOff?: boolean;
  /** The owner's power throttle in tenths (0..9; absent ⇒ 100%): its draw
   *  scales with it (`structureDraw`). Persisted; rides bits of `flags`. */
  throttle?: number;
  /** D1 — a Reactor has fuel burning (its output counts). Rides room state as
   *  the inverse NO_FUEL flag. */
  fueled?: boolean;
  /** D1 — pulses until the Reactor burns its next unit of fuel. */
  fuelTimer?: number;
  /** P2d — shots left in the magazine (ammo-using turrets). */
  ammo?: number;
  /** P2d — the last shot found no munitions in storage. Rides room state. */
  noAmmo?: boolean;
  /** Phase 5 — wall-clock ms of this Turret's last shot (fire-rate cooldown). */
  lastTurretFireMs?: number;
}

/**
 * structure-restyle 3c — the goods a freight dock takes in on a deposit: the
 * goods its import orders name (`freightOrders`, the dock's import/export
 * list). Export orders only ⇒ an EMPTY set: an outlet takes nothing in. NO
 * orders at all ⇒ undefined (no filter): a freshly built dock takes a new
 * player's whole hold (3b). Pass it to `StorageService.deposit` as `intake`.
 */
export function dockIntakeGoods(rec: Pick<StructureRecord, 'freightOrders'>): Set<GoodId> | undefined {
  if ((rec.freightOrders?.length ?? 0) === 0) return undefined;
  const out = new Set<GoodId>();
  for (const o of rec.freightOrders ?? []) if (o.mode === 'import') out.add(o.good);
  return out;
}

export class StructureRegistry {
  private readonly byId = new Map<string, StructureRecord>();
  /** Adjacency: structureId → its connections (each appears in BOTH endpoints'
   *  lists). O(1) neighbour lookup for BFS/A*. */
  private readonly adjacency = new Map<string, Connection[]>();
  /** Flat connectionId → Connection (for the wire + flash lookups). */
  private readonly connById = new Map<number, Connection>();
  private connCounter = 0;
  /** Phase 5 — ids of structures that have had at least one connection at some
   *  point. The 1 Hz auto-reconnect sweep (`processReconnect`) skips these so a
   *  DELIBERATELY-cleared or hub-death-orphaned structure stays orphaned until
   *  the player manually reconnects ("clearing connections instantly reconnects,
   *  so it's pointless"). A NEVER-connected placement (a leaf placed before its
   *  hub, Issue 2 2026-06-10) is absent here and stays sweep-eligible. Session-
   *  scoped: a server restart re-derives the whole grid via the restore sweep,
   *  which is the intended cold-start behaviour. */
  private readonly everConnected = new Set<string>();
  /** Set whenever topology changes (add/sever/construct); the grid subsystem
   *  rebuilds components + drops the route cache only when this is true. */
  topologyDirty = true;
  /** Told of every structure added or really removed, and again (`added`
   *  true) when its body turns solid (discrete; navigation's static
   *  obstacles). Structures never move after placement. */
  private readonly changeListeners: Array<(rec: StructureRecord, added: boolean) => void> = [];
  /** Capture 4E (S6) — the NPC bases (seed owners, `npc:<faction>:<baseId>`)
   *  that fell in this sector: their last built Capital left the world
   *  (`noteBaseFall`). Saved with the sector (`fallenBases`), so a fallen
   *  base never regrows, even once every piece of it is gone. */
  readonly fallenBases = new Set<string>();
  /** Base platforms — the derived plate set (`core/hex/plateSet.ts`): owner
   *  O has plate (i, j) while O owns a connector, built or blueprint, on that
   *  plate's centre. Kept on add / remove / owner change; the client mirror
   *  keeps the same set from room state (#15). */
  readonly plates = new PlateSet<string>();
  /** Base platforms — the room's deck flag (`SectorState.deck`, set at room
   *  create): `canConnect`'s plate-anchor link rule reads it (#15). */
  deck = false;

  /** Re-read the owner of every plate-anchoring structure (after an owner
   *  flip: capture, orphaning, adoption). Discrete; touches anchors only. */
  syncPlateOwners(): void {
    for (const id of this.plates.anchorIds()) {
      const rec = this.byId.get(id);
      if (rec && this.plates.anchorOwner(id) !== rec.owner) this.plates.upsert(id, rec.owner, rec.kind, rec.x, rec.y);
    }
  }

  /** Hydrate: the saved `fallenBases` (unvalidated JSON; non-`npc:` dropped). */
  restoreFallenBases(origins: readonly unknown[]): void {
    for (const o of origins) if (typeof o === 'string' && isNpcOwner(o)) this.fallenBases.add(o);
  }

  /** Subscribes to adds / removes; returns the unsubscribe. */
  onChange(fn: (rec: StructureRecord, added: boolean) => void): () => void {
    this.changeListeners.push(fn);
    return () => { const i = this.changeListeners.indexOf(fn); if (i >= 0) this.changeListeners.splice(i, 1); };
  }

  add(rec: StructureRecord): void {
    this.byId.set(rec.id, rec);
    this.plates.upsert(rec.id, rec.owner, rec.kind, rec.x, rec.y);
    this.topologyDirty = true;
    for (const fn of this.changeListeners) fn(rec, true);
  }

  /** A structure's body changed (a blueprint turned solid, hologram
   *  pass-through): listeners hear it as a re-add. */
  bodyChanged(rec: StructureRecord): void {
    if (this.byId.get(rec.id) !== rec) return;
    for (const fn of this.changeListeners) fn(rec, true);
  }

  get(id: string): StructureRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Remove a structure AND sever every connection touching it (no leaks).
   *  Returns the removed record (or undefined). */
  remove(id: string): StructureRecord | undefined {
    const rec = this.byId.get(id);
    // Capture plan 4E — the base a lost last Capital held turns ownerless (the
    // ONE seam: combat, pack and take-down all end here). Before disconnect.
    if (rec) { orphanBaseOnCapitalLoss(this, rec); noteBaseFall(this, rec); this.syncPlateOwners(); }
    this.disconnect(id);
    if (rec) {
      this.byId.delete(id);
      this.plates.remove(id);
      this.everConnected.delete(id); // structure gone — no leak
      this.topologyDirty = true;
      for (const fn of this.changeListeners) fn(rec, false);
    }
    return rec;
  }

  all(): IterableIterator<StructureRecord> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  // ── Connections (Phase 3) ────────────────────────────────────────────────

  /** Connections touching `id` (empty array if none). */
  connectionsOf(id: string): readonly Connection[] {
    return this.adjacency.get(id) ?? [];
  }

  connectionCount(id: string): number {
    return this.adjacency.get(id)?.length ?? 0;
  }

  /** Phase 5 — true once a structure has had ≥1 connection. The auto-reconnect
   *  sweep skips these (a cleared/orphaned established structure stays orphaned);
   *  a never-connected placement stays sweep-eligible. NOT reset by `disconnect`/
   *  `clearConnections` (that's the whole point) — only by `remove` (structure
   *  gone). */
  hasEverConnected(id: string): boolean {
    return this.everConnected.has(id);
  }

  hasConnection(aId: string, bId: string): boolean {
    return (this.adjacency.get(aId) ?? []).some((c) => c.getOtherNode(aId) === bId);
  }

  /** The full adjacency view (read-only) for `canConnect` / grid rebuild. */
  adjacencyMap(): ReadonlyMap<string, readonly Connection[]> {
    return this.adjacency;
  }

  allConnections(): IterableIterator<Connection> {
    return this.connById.values();
  }

  getConnection(id: number): Connection | undefined {
    return this.connById.get(id);
  }

  /** Create + register a connection between two structures. `socketA` /
   *  `socketB` are the cable sockets `canConnect` picked for `aId` / `bId`
   *  (0d cable sockets; `CABLE_NO_SOCKET` for a fence link). */
  addConnection(
    aId: string, bId: string, throughput: number,
    socketA: number = CABLE_NO_SOCKET, socketB: number = CABLE_NO_SOCKET,
  ): Connection {
    // Phase 5 — both endpoints have now connected at least once (sweep-skip).
    this.everConnected.add(aId);
    this.everConnected.add(bId);
    const c = new Connection(this.connCounter++, aId, bId, throughput, socketA, socketB);
    let aList = this.adjacency.get(aId);
    if (!aList) { aList = []; this.adjacency.set(aId, aList); }
    aList.push(c);
    let bList = this.adjacency.get(bId);
    if (!bList) { bList = []; this.adjacency.set(bId, bList); }
    bList.push(c);
    this.connById.set(c.id, c);
    this.topologyDirty = true;
    return c;
  }

  /** Move link `c` to the socket pair `socketA` / `socketB` (a `canConnect`
   *  re-seat, `CableReseat`): the same link (id, ends, flow) on new sockets. */
  reseatConnection(c: Connection, socketA: number, socketB: number): void {
    const moved = new Connection(c.id, c.aId, c.bId, c.throughput, socketA, socketB);
    moved.flowMaterial = c.flowMaterial;
    moved.flashUntilMs = c.flashUntilMs;
    for (const end of [c.aId, c.bId]) {
      const list = this.adjacency.get(end);
      const i = list ? list.indexOf(c) : -1;
      if (i >= 0) list![i] = moved;
    }
    this.connById.set(c.id, moved);
    this.topologyDirty = true;
  }

  /** Sever the one link `c` (base platforms slice 21: a deck gate replaces
   *  its seam's post-to-post link). No-op when it is not registered. */
  removeConnection(c: Connection): void {
    if (this.connById.get(c.id) !== c) return;
    this.connById.delete(c.id);
    for (const end of [c.aId, c.bId]) {
      const list = this.adjacency.get(end);
      const i = list ? list.indexOf(c) : -1;
      if (i >= 0) list!.splice(i, 1);
    }
    this.topologyDirty = true;
  }

  /** Sever every connection touching `id`. Returns the severed connection ids. */
  disconnect(id: string): number[] {
    const conns = this.adjacency.get(id);
    if (!conns || conns.length === 0) return [];
    const severed: number[] = [];
    for (const c of conns) {
      severed.push(c.id);
      this.connById.delete(c.id);
      const other = c.getOtherNode(id);
      if (other !== null) {
        const otherList = this.adjacency.get(other);
        if (otherList) {
          const i = otherList.indexOf(c);
          if (i >= 0) otherList.splice(i, 1);
        }
      }
    }
    this.adjacency.delete(id);
    this.topologyDirty = true;
    return severed;
  }
}
