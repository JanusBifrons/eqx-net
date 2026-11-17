/**
 * LootSubsystem — loot pods + fly-over / hull-touch (or tractor hold-zone) pickup, the wreck-piece store (tractored, or consumable and touching the hull) + spill-on-death for ONE sector
 * (plan peppy-jumping-pinwheel P1a-1). Decision logic over injected hooks, so it
 * is unit-testable without a room (the `TransitOrchestrator` pattern).
 *
 * Value model: every pod's contents live in the global `HoldStore` (keyed by the
 * pod id). Every movement of value is an atomic `HoldStore.commit` of ABSOLUTE
 * records — a pickup writes the emptier pod + the fuller ship hold in one GROUP,
 * so a crash can never leave the loot in both places (hostile-review A5).
 *
 * Pods are SCRAP-kind swarm entities (`parentShipKind='cargo-pod'`,
 * `componentIndex` = glow tier) — rendered by the existing scrap path, but kept
 * OUT of the scrap FIFO and OUT of the sector snapshot (they persist only via
 * the holds table — hostile-review A3).
 */
import { randomUUID } from 'node:crypto';
import type { GoodId, Hold } from '../../shared-types/goods.js';
import { ROCK_CHUNK_PRODUCT } from '../../shared-types/items.js';
import type { ShipKind } from '../../shared-types/shipKinds/types.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { salvageConsumable, salvageConsumeMass } from '../../core/combat/salvageTargeting.js';
import type { PieceStoreView } from '../rooms/wreckLineage.js';
import type { WreckOre } from '../rooms/capitalWreckTypes.js';
import { cloneHold, emptyHold, extractRequested, holdBestTier, holdWeight, isHoldEmpty, mergeInto, rollDeathLoss, transferInto, type CargoRequest } from '../../core/cargo/hold.js';
import { stream } from '../../core/random/rng.js';
import { hashString } from '../../core/bases/baseProfile.js';
import { POD_TIER_SPILL, podComponentIndex } from '../../shared-types/shipKinds/cargoPod.js';
import type { HoldRecord, HoldStore } from './HoldStore.js';
import { shipHitBound, shipWithinHullReach } from '../../core/combat/shipHitShape.js';
import { withinLootOpenReach } from '../../core/cargo/lootReach.js';

/** Max live loot pods per sector — a separate budget from `MAX_LIVE_SCRAP`. */
export const MAX_LIVE_LOOT_PER_SECTOR = 64;
/** A new drop within this distance of an existing pod MERGES into it. */
export const LOOT_MERGE_RADIUS = 60;
/** Pods expire (value destroyed) after this long untouched. */
export const LOOT_POD_TTL_MS = 15 * 60_000;
/** Re-persist a pod's drifted pose when it moved further than this. */
const POSE_RESAVE_EPS = 5;

export interface PodPose { x: number; y: number }

/** `take`'s answer: what moved, or why nothing did. */
export type TakeResult = { ok: true; moved: Hold } | { ok: false; reason: 'gone' | 'out_of_reach' | 'hold_full' };

export interface LootCollector {
  playerId: string;
  shipInstanceId: string;
  x: number;
  y: number;
  /** Hull heading (rad) and shield state: the touch pickup measures to the
   *  ship's real outer surface (the shield bubble while up: what a pod or
   *  piece physically meets, `shipWithinHullReach`). */
  angle: number;
  shieldUp: boolean;
  /** Cargo capacity (weight units) of the collecting hull's kind. */
  capacity: number;
  /** The collecting hull's kind: its mounts decide whether it takes
   *  hold-size wreck pieces in by proximity (`salvageConsumeMass`). */
  kind: ShipKind;
  /** Living World P3b — an NPC collector (robot harvester): its hold is an
   *  ownerless `hauler`-type record keyed by its swarm id (spilled on death by
   *  the kill path), and it gets no player popup. */
  npc?: boolean;
}

export interface LootSubsystemDeps {
  holdStore: HoldStore;
  /** Persistent sector identity (null ⇒ engineering room: memory-only holds). */
  sectorKey: () => string | null;
  /** Test rooms only: a death keeps every stack (no coin flip), for tests
   *  that pin exact pod contents rather than the death loss. */
  keepAllOnDeath?: boolean;
  now: () => number;
  /** Spawn the pod's swarm entity at a pose; `tier` is its `componentIndex`
   *  (size class and glow tier, `podComponentIndex`). */
  spawnPodEntity: (id: string, x: number, y: number, vx: number, vy: number, tier: number) => boolean;
  /** Remove a pod's swarm entity (pickup emptied it / TTL). Not a combat death. */
  despawnPodEntity: (id: string) => void;
  /** Re-tint a live pod (its contents' best tier changed after a merge);
   *  `tier` is the new `componentIndex` (same size class). */
  setPodTier: (id: string, tier: number) => void;
  /** Live pose of a pod entity (null if gone). */
  podPose: (id: string) => PodPose | null;
  /** Visit every hull that may collect THIS tick: ACTIVE hulls WITH a roster
   *  row (liveness #17 — lingering / dead hulls never collect; no roster row ⇒
   *  no hold ⇒ no pickup). Visitor style: no per-tick allocation (#14). */
  forEachCollector: (visit: (c: LootCollector) => void) => void;
  /** Fill `c` with ship `shipId`'s collector (`LootCollectors.fill`): true =
   *  filled; false = a ship that is not collecting; null = not a ship. Absent:
   *  a pod contact is never a hull touch. */
  fillCollector?: (shipId: string, c: LootCollector) => boolean | null;
  /** Salvage plan PR 12, hold-zone pickup: is pod `podId` (at x, y) held by a
   *  tractor beam of collector `c` close enough to take it
   *  (`ForceFieldSubsystem.inTractorHold`)? Such a pod is loaded whole (until
   *  plan cargo-pods F ends ore pods: then a tractor only moves a pod). */
  inTractorHold?: (c: LootCollector, podId: string, x: number, y: number) => boolean;
  /** Piece store: a piece goes whole into a collector's hold when its own
   *  tractor holds it in the hold zone, or (the factory line) when it is
   *  CONSUMABLE for that ship (`salvageConsumable`) and touches the hull
   *  (`shipWithinHullReach`, to the piece's edge). A wreck piece goes in as
   *  salvage, a rock piece as one rock chunk (`chunkOre`). Absent ⇒ pods only. */
  heldPieces?: {
    /** Any tractor lease or live piece (cheap gate for the pass). */
    any: () => boolean;
    /** Visit the wreck pieces collector `c`'s own beams hold in the zone
     *  (`ForceFieldSubsystem.forEachHeldPiece`). */
    forEach: (c: LootCollector, visit: (pieceId: string) => void) => void;
    /** Visit live pieces of mass ≤ `maxMass` whose edge is within `reach`
     *  of (x, y), with their radius (`CapitalWreckSubsystem.forEachPieceNear`). */
    near: (x: number, y: number, reach: number, maxMass: number, visit: (pieceId: string, px: number, py: number, pr: number) => void) => void;
    /** The piece's whole-store worth (`CapitalWreckSubsystem.pieceStore`); false: gone. */
    store: (pieceId: string, out: PieceStoreView) => boolean;
    /** Remove the stored piece (`CapitalWreckSubsystem.storePiece`). */
    remove: (pieceId: string) => void;
  };
  /** A rock chunk's hidden ore (`OreDraw.chunkYield`, the one ore path).
   *  Absent: a rock piece is never taken in. */
  chunkOre?: (ore: WreckOre, x: number, y: number, weight: number) => Partial<Record<GoodId, number>>;
  /** Discrete notifications (UI accelerator + audit). */
  onCollected?: (c: LootCollector, moved: Hold, podId: string) => void;
  onDropped?: (podId: string, hold: Hold, cause: string) => void;
  onDestroyed?: (podId: string, hold: Hold, cause: 'expired') => void;
}

interface LivePod {
  tier: number;
  /** Size class (`podSizeClass` of the dead ship; 0 for any other drop). */
  size: number;
  /** Last persisted pose (for the drift re-save). */
  savedX: number;
  savedY: number;
  /** Living World P1a-2 — a DERELICT (an abandoned ship's hulk): salvaged over
   *  time (rate-limited per collect step, contestable), never merged into, and
   *  longer-lived than a normal pod. */
  derelict: boolean;
  /** The wreck lineage (`LiveWreck.root`) a rock's or wreck's worn-out
   *  piece dropped it from (a tractor's lock moves on through it); -1 none. */
  root: number;
}

/** Derelict hulks last an hour (a normal pod: 15 min). */
export const DERELICT_TTL_MS = 60 * 60_000;

export class LootSubsystem {
  private readonly pods = new Map<string, LivePod>();

  constructor(private readonly d: LootSubsystemDeps) {}

  isPod(id: string): boolean {
    return this.pods.has(id);
  }

  podCount(): number {
    return this.pods.size;
  }

  podIds(): IterableIterator<string> {
    return this.pods.keys();
  }

  /** The wreck lineage pod `id` was dropped from, or -1. */
  podRoot(id: string): number {
    return this.pods.get(id)?.root ?? -1;
  }

  private persist(): boolean {
    return this.d.sectorKey() !== null;
  }

  /** The hold carried by a ship instance (undefined ⇒ empty). */
  shipHold(shipInstanceId: string): Hold | undefined {
    return this.d.holdStore.get(shipInstanceId)?.hold;
  }

  /**
   * Drop a hold into the world at (x, y). Merges into a nearby pod (or, at the
   * per-sector cap, the NEAREST pod) instead of spawning — the cap never evicts
   * value. `extraDeletes` lets the caller fold the SOURCE holder's removal into
   * the same atomic group (e.g. a dying ship's hold). Returns the pod id that
   * now holds the value, or null if the hold was empty.
   */
  drop(
    hold: Hold,
    x: number, y: number, vx = 0, vy = 0,
    opts: { spill?: boolean; derelict?: boolean; alone?: boolean; size?: number; cause?: string; extraDeletes?: readonly string[]; root?: number } = {},
  ): string | null {
    const extraDeletes = opts.extraDeletes ?? [];
    if (isHoldEmpty(hold)) {
      if (extraDeletes.length > 0) this.d.holdStore.commit([], extraDeletes, this.persist());
      return null;
    }
    // A derelict is its own hulk, and a death pod is its ship's own black box
    // (`alone`, owner 2026-11-17: one pod per destroyed ship): never merged
    // into a nearby pod, only at the hard cap, where value must still never be
    // evicted.
    const derelict = opts.derelict === true;
    const target = derelict || opts.alone === true
      ? (this.pods.size >= MAX_LIVE_LOOT_PER_SECTOR ? this.nearestPod(x, y) : null)
      : this.findMergeTarget(x, y);
    if (target !== null) {
      const rec = this.d.holdStore.get(target)!;
      const merged: HoldRecord = { ...rec, hold: cloneHold(rec.hold) };
      mergeInto(merged.hold, cloneHold(hold));
      this.d.holdStore.commit([merged], extraDeletes, this.persist());
      // A player spill stays the bright "scramble" tier once merged into.
      const live = this.pods.get(target)!;
      if (live.root < 0 && opts.root !== undefined) live.root = opts.root;
      const tier = opts.spill || live.tier === POD_TIER_SPILL ? POD_TIER_SPILL : holdBestTier(merged.hold);
      if (tier !== live.tier) {
        live.tier = tier;
        this.d.setPodTier(target, podComponentIndex(live.size, tier));
      }
      this.d.onDropped?.(target, hold, opts.cause ?? 'drop');
      return target;
    }
    const id = `pod-${randomUUID().slice(0, 12)}`;
    const tier = opts.spill || derelict ? POD_TIER_SPILL : holdBestTier(hold);
    const size = opts.size ?? 0;
    if (!this.d.spawnPodEntity(id, x, y, vx, vy, podComponentIndex(size, tier))) {
      // Slot pool exhausted: never silently destroy value — fold into the
      // nearest pod if any, else leave it with its source (no delete).
      const nearest = this.nearestPod(x, y);
      if (nearest !== null) return this.forceMerge(nearest, hold, extraDeletes, opts.cause);
      return null;
    }
    this.pods.set(id, { tier, size, savedX: x, savedY: y, derelict, root: opts.root ?? -1 });
    this.d.holdStore.commit(
      [{
        holderUid: id, holderType: derelict ? 'derelict' : 'pod', ownerId: null, sectorKey: this.d.sectorKey(),
        x, y, hold: cloneHold(hold), expiresAt: this.d.now() + (derelict ? DERELICT_TTL_MS : LOOT_POD_TTL_MS),
      }],
      extraDeletes,
      this.persist(),
    );
    this.d.onDropped?.(id, hold, opts.cause ?? 'drop');
    return id;
  }

  private forceMerge(target: string, hold: Hold, extraDeletes: readonly string[], cause?: string): string {
    const rec = this.d.holdStore.get(target)!;
    const merged: HoldRecord = { ...rec, hold: cloneHold(rec.hold) };
    mergeInto(merged.hold, cloneHold(hold));
    this.d.holdStore.commit([merged], extraDeletes, this.persist());
    this.d.onDropped?.(target, hold, cause ?? 'drop');
    return target;
  }

  /** Spill a ship's carried hold where it died. Pod creation + the ship-hold
   *  delete are ONE atomic group. No-op for an empty / absent hold.
   *  `player`: only a dead PLAYER's cargo is the bright spill tier (a
   *  scramble); an NPC's drop is an ordinary pod coloured by its contents
   *  (owner 2026-11-13: bright NPC pods read as live ships among the wreckage).
   *  `extra`: value the death adds to the same pod (a player hull's salvage
   *  roll, a vaporised ship's bonus salvage), in the same group; with no
   *  ship hold, `extra` alone drops as an ordinary pod.
   *  `deathLoss`: a DEATH (not an abandon) seeds this key into the EVE coin
   *  flip (`rollDeathLoss`, owner 2026-11-17): every stack, `extra`
   *  included, survives whole or is destroyed whole; nothing left ⇒ no pod. */
  spillShipHold(
    shipInstanceId: string, x: number, y: number, vx: number, vy: number, cause: string,
    opts: { player: boolean; derelict?: boolean; extra?: Hold; deathLoss?: string; size?: number },
  ): string | null {
    const rec = this.d.holdStore.get(shipInstanceId);
    if (rec === undefined && opts.extra === undefined) return null;
    let hold = rec !== undefined ? cloneHold(rec.hold) : emptyHold();
    if (opts.extra !== undefined) mergeInto(hold, opts.extra);
    if (opts.deathLoss !== undefined && this.d.keepAllOnDeath !== true) hold = rollDeathLoss(hold, stream(hashString(opts.deathLoss), 'death-loss'));
    const alone = opts.deathLoss !== undefined;
    const size = opts.size ?? 0;
    if (rec === undefined) return this.drop(hold, x, y, vx, vy, { cause, alone, size });
    return this.drop(hold, x, y, vx, vy, {
      spill: opts.player && !isHoldEmpty(rec.hold), derelict: opts.derelict === true, alone, size, cause, extraDeletes: [shipInstanceId],
    });
  }

  isDerelict(id: string): boolean {
    return this.pods.get(id)?.derelict === true;
  }

  /** Fly-over pickup pass — call every few ticks from the room update. */
  collectTick(): void {
    if (this.pods.size === 0 && this.d.heldPieces?.any() !== true) return;
    this.d.forEachCollector(this.visitCollector);
  }

  /** The collector the piece-store visit runs for (no closure per pass, #14). */
  private pieceCollector: LootCollector | null = null;

  /** Bound once (no per-tick closure allocation, #14). */
  private readonly visitCollector = (c: LootCollector): void => {
    if (this.d.heldPieces !== undefined) {
      this.pieceCollector = c;
      this.d.heldPieces.forEach(c, this.storeHeldPiece);
      const maxM = salvageConsumeMass(c.kind);
      if (maxM > 0) this.d.heldPieces.near(c.x, c.y, shipHitBound(c.kind.id), maxM, this.consumeNearPiece);
      this.pieceCollector = null;
    }
    // Plan cargo-pods slice 14: no fly-over or touch pickup; a pilot opens a
    // pod (`take`). An AI harvester has no window: it takes all within the
    // same reach. A pod in the collector's own tractor hold zone loads whole.
    for (const [podId] of this.pods) {
      const pose = this.d.podPose(podId);
      if (pose === null) continue;
      if (c.npc === true && this.inOpenReach(c, podId)) this.moveOut(c, podId, null);
      else if (this.d.inTractorHold?.(c, podId, pose.x, pose.y) === true) this.moveOut(c, podId, null);
    }
  };

  /** Reused collector for `hullContact` (no per-contact alloc, #14). */
  private readonly contactCollector: LootCollector = { playerId: '', shipInstanceId: '', x: 0, y: 0, angle: 0, shieldUp: false, capacity: 0, kind: getShipKind(null) };

  /** A physics contact between `podId` and `otherId`. When `podId` is a loot
   *  pod and `otherId` a ship, the bump never destroys the pod (true: skip
   *  its ram damage). Touching never picks up (plan cargo-pods slice 14:
   *  pickup is the loot window, or a tractor hold). */
  hullContact(podId: string, otherId: string): boolean {
    if (!this.pods.has(podId) || this.d.fillCollector === undefined) return false;
    return this.d.fillCollector(otherId, this.contactCollector) !== null;
  }

  /**
   * Take from an opened pod (the loot window, plan cargo-pods slice 10):
   * `want` = the items dragged or clicked, `null` = Take all. Free for all;
   * the ship must be within `LOOT_OPEN_REACH` of its hull. Weight is the only
   * limit: what does not fit stays in the pod. The same atomic commit as the
   * fly-over pickup (ship gains + pod loses in ONE group).
   */
  take(c: LootCollector, podId: string, want: CargoRequest | null): TakeResult {
    const podRec = this.d.holdStore.get(podId);
    const pose = this.d.podPose(podId);
    if (!this.pods.has(podId) || podRec === undefined || pose === null) return { ok: false, reason: 'gone' };
    if (!this.inOpenReach(c, podId)) return { ok: false, reason: 'out_of_reach' };
    return this.moveOut(c, podId, want);
  }

  /** Move `want` (null = everything) from pod `podId` into `c`'s hold, as
   *  much as its weight allows: the one pod → ship move (no reach check). */
  private moveOut(c: LootCollector, podId: string, want: CargoRequest | null): TakeResult {
    const podRec = this.d.holdStore.get(podId);
    if (podRec === undefined) return { ok: false, reason: 'gone' };
    const shipRec = this.d.holdStore.get(c.shipInstanceId);
    const shipHold = shipRec ? cloneHold(shipRec.hold) : emptyHold();
    const podHold = cloneHold(podRec.hold);
    const picked = want === null ? podHold : extractRequested(podHold, want);
    const { moved } = transferInto(shipHold, picked, c.capacity);
    if (picked !== podHold) mergeInto(podHold, picked); // what did not fit goes back
    if (isHoldEmpty(moved)) return { ok: false, reason: isHoldEmpty(podRec.hold) ? 'gone' : 'hold_full' };
    this.commitMove(c, podId, podRec, shipHold, podHold, isHoldEmpty(podHold));
    this.d.onCollected?.(c, moved, podId);
    return { ok: true, moved };
  }

  /** Is pod `podId` within `LOOT_OPEN_REACH` of `c`'s hull (the loot window's open rule)? */
  inOpenReach(c: LootCollector, podId: string): boolean {
    const pose = this.d.podPose(podId);
    return pose !== null && withinLootOpenReach(c.kind.id, c.shieldUp, pose.x, pose.y, c.x, c.y, c.angle);
  }

  /** Commit one pod → ship move as ONE atomic group; an emptied pod's row is
   *  deleted in that group and its entity despawned. */
  private commitMove(c: LootCollector, podId: string, podRec: HoldRecord, shipHold: Hold, podHold: Hold, podEmptied: boolean): void {
    const shipNext = this.shipRecord(c, shipHold);
    if (podEmptied) {
      this.d.holdStore.commit([shipNext], [podId], this.persist());
      this.pods.delete(podId);
      this.d.despawnPodEntity(podId);
    } else {
      this.d.holdStore.commit([shipNext, { ...podRec, hold: podHold }], [], this.persist());
    }
  }

  /** Collector `c`'s next hold record (a pilot's ship row, or an NPC's
   *  ownerless `hauler` row). */
  private shipRecord(c: LootCollector, hold: Hold): HoldRecord {
    return c.npc === true
      ? { holderUid: c.shipInstanceId, holderType: 'hauler', ownerId: null, sectorKey: this.d.sectorKey(), x: null, y: null, hold, expiresAt: null }
      : { holderUid: c.shipInstanceId, holderType: 'ship', ownerId: c.playerId, sectorKey: null, x: null, y: null, hold, expiresAt: null };
  }

  /** Reused piece view (`heldPieces.store`, #14). */
  private readonly pieceView: PieceStoreView = { mass: 0, radius: 0, qty: 0, ore: undefined, holdWeight: 0 };

  /** A piece the collector's own tractor holds in its hold zone. Bound once. */
  private readonly storeHeldPiece = (pieceId: string): void => {
    const c = this.pieceCollector;
    if (c !== null) this.storePiece(c, pieceId, false, c.x, c.y);
  };

  /** A piece near the collector (the factory line): taken in only when it
   *  touches the hull and is consumable for this ship. Bound once. */
  private readonly consumeNearPiece = (pieceId: string, px: number, py: number, pr: number): void => {
    const c = this.pieceCollector;
    if (c !== null && shipWithinHullReach(c.kind.id, c.shieldUp, px, py, c.x, c.y, c.angle, pr)) this.storePiece(c, pieceId, true, px, py);
  };

  /**
   * Piece store: a piece goes WHOLE into `c`'s hold (`heldPieces.store`): a
   * WRECK piece as the salvage it would leave when worn out, a ROCK piece
   * (`ore`) as one rock chunk of its weight carrying its hidden ore
   * (`chunkOre`; owner 2026-11-17: never a pod, never ore until refined). One
   * `HoldStore` commit of the fuller ship record, then the piece leaves
   * through the wreck system's removal path. All or nothing: a hold without
   * room for all of it changes nothing and the piece stays. `consume`: only a
   * piece consumable for this ship (`salvageConsumable`). The room check
   * allocates nothing, so a full hold costs nothing per pass (#14).
   */
  private storePiece(c: LootCollector, pieceId: string, consume: boolean, x: number, y: number): void {
    const hp = this.d.heldPieces;
    const v = this.pieceView;
    if (hp === undefined || !hp.store(pieceId, v) || v.qty <= 0) return; // gone, or worth nothing
    if (v.ore !== undefined && this.d.chunkOre === undefined) return;
    const shipRec = this.d.holdStore.get(c.shipInstanceId);
    const free = c.capacity - (shipRec !== undefined ? holdWeight(shipRec.hold) : 0) + 1e-9;
    if (consume ? !salvageConsumable(v, salvageConsumeMass(c.kind), free) : v.holdWeight > free) return; // no room: it stays
    const moved: Hold = v.ore === undefined
      ? { goods: { salvage: v.qty }, blueprints: [] }
      : { goods: {}, blueprints: [], packed: [{
        product: ROCK_CHUNK_PRODUCT, quality: 0, uid: `rc-${randomUUID()}`, weight: v.holdWeight,
        ore: this.d.chunkOre!(v.ore, x, y, v.holdWeight) as Record<string, number>,
      }] };
    const shipHold = shipRec !== undefined ? cloneHold(shipRec.hold) : emptyHold();
    mergeInto(shipHold, cloneHold(moved));
    this.d.holdStore.commit([this.shipRecord(c, shipHold)], [], this.persist());
    hp.remove(pieceId);
    this.d.onCollected?.(c, moved, pieceId);
  }

  /** Expire a pod now, as its TTL would: contents gone, entity despawned.
   *  Pods are indestructible (owner 2026-11-17), so this is the only way a
   *  full pod leaves early (tests clearing a kill's loot). */
  expireNow(podId: string): void {
    const rec = this.d.holdStore.get(podId);
    if (!this.pods.has(podId) || rec === undefined) return;
    this.expire(podId, rec.hold);
  }

  private expire(podId: string, hold: Hold): void {
    this.pods.delete(podId);
    this.d.holdStore.delete(podId, this.persist());
    this.d.despawnPodEntity(podId);
    this.d.onDestroyed?.(podId, hold, 'expired');
  }

  /** ~1 Hz housekeeping: TTL expiry + drifted-pose re-save. */
  sweep(): void {
    const now = this.d.now();
    for (const [podId, live] of this.pods) {
      const rec = this.d.holdStore.get(podId);
      if (rec === undefined) {
        this.pods.delete(podId);
        this.d.despawnPodEntity(podId);
        continue;
      }
      if (rec.expiresAt !== null && now >= rec.expiresAt) {
        this.expire(podId, rec.hold);
        continue;
      }
      const pose = this.d.podPose(podId);
      if (pose !== null && Math.hypot(pose.x - live.savedX, pose.y - live.savedY) > POSE_RESAVE_EPS) {
        live.savedX = pose.x;
        live.savedY = pose.y;
        this.d.holdStore.put({ ...rec, x: pose.x, y: pose.y }, this.persist());
      }
    }
  }

  /** Room hydrate — respawn this sector's persisted pods (A3: from the holds
   *  table only, never the sector snapshot). */
  restore(): number {
    const key = this.d.sectorKey();
    if (key === null) return 0;
    let n = 0;
    for (const type of ['pod', 'derelict'] as const) {
      const derelict = type === 'derelict';
      for (const rec of this.d.holdStore.inSector(key, type)) {
        if (rec.x === null || rec.y === null) continue;
        const tier = derelict ? POD_TIER_SPILL : holdBestTier(rec.hold);
        if (!this.d.spawnPodEntity(rec.holderUid, rec.x, rec.y, 0, 0, tier)) continue;
        // Size is not persisted: a restored pod comes back at size 0.
        this.pods.set(rec.holderUid, { tier, size: 0, savedX: rec.x, savedY: rec.y, derelict, root: -1 });
        n++;
      }
    }
    return n;
  }

  private findMergeTarget(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD2 = LOOT_MERGE_RADIUS * LOOT_MERGE_RADIUS;
    for (const [id, live] of this.pods) {
      if (live.derelict) continue; // a hulk is its own thing — never a merge target
      const p = this.d.podPose(id);
      if (p === null) continue;
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d2 <= bestD2) { bestD2 = d2; best = id; }
    }
    if (best !== null) return best;
    return this.pods.size >= MAX_LIVE_LOOT_PER_SECTOR ? this.nearestPod(x, y) : null;
  }

  private nearestPod(x: number, y: number): string | null {
    let best: string | null = null;
    let bestD2 = Infinity;
    for (const [id] of this.pods) {
      const p = this.d.podPose(id);
      if (p === null) continue;
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = id; }
    }
    return best;
  }
}
