/**
 * LootSubsystem — loot pods + fly-over pickup + spill-on-death for ONE sector
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
import type { Hold } from '../../shared-types/goods.js';
import { cloneHold, holdBestTier, isHoldEmpty, mergeInto, transferInto, transferUpTo } from '../../core/cargo/hold.js';
import { POD_TIER_SPILL } from '../../shared-types/shipKinds/cargoPod.js';
import type { HoldRecord, HoldStore } from './HoldStore.js';

/** Max live loot pods per sector — a separate budget from `MAX_LIVE_SCRAP`. */
export const MAX_LIVE_LOOT_PER_SECTOR = 64;
/** A new drop within this distance of an existing pod MERGES into it. */
export const LOOT_MERGE_RADIUS = 60;
/** Fly-over pickup radius (pod centre to ship centre). */
export const LOOT_PICKUP_RADIUS = 80;
/** Pods expire (value destroyed) after this long untouched. */
export const LOOT_POD_TTL_MS = 15 * 60_000;
/** Re-persist a pod's drifted pose when it moved further than this. */
const POSE_RESAVE_EPS = 5;

export interface PodPose { x: number; y: number }

export interface LootCollector {
  playerId: string;
  shipInstanceId: string;
  x: number;
  y: number;
  /** Cargo capacity (weight units) of the collecting hull's kind. */
  capacity: number;
  /** Living World P3b — an NPC collector (robot harvester): its hold is an
   *  ownerless `hauler`-type record keyed by its swarm id (spilled on death by
   *  the kill path), and it gets no player popup. */
  npc?: boolean;
}

export interface LootSubsystemDeps {
  holdStore: HoldStore;
  /** Persistent sector identity (null ⇒ engineering room: memory-only holds). */
  sectorKey: () => string | null;
  now: () => number;
  /** Spawn the pod's swarm entity at a pose with a glow tier. */
  spawnPodEntity: (id: string, x: number, y: number, vx: number, vy: number, tier: number) => boolean;
  /** Remove a pod's swarm entity (pickup emptied it / TTL). Not a combat death. */
  despawnPodEntity: (id: string) => void;
  /** Re-tint a live pod (its contents' best tier changed after a merge). */
  setPodTier: (id: string, tier: number) => void;
  /** Live pose of a pod entity (null if gone). */
  podPose: (id: string) => PodPose | null;
  /** Visit every hull that may collect THIS tick: ACTIVE hulls WITH a roster
   *  row (liveness #17 — lingering / dead hulls never collect; no roster row ⇒
   *  no hold ⇒ no pickup). Visitor style: no per-tick allocation (#14). */
  forEachCollector: (visit: (c: LootCollector) => void) => void;
  /** Discrete notifications (UI accelerator + audit). */
  onCollected?: (c: LootCollector, moved: Hold, podId: string) => void;
  onDropped?: (podId: string, hold: Hold, cause: string) => void;
  onDestroyed?: (podId: string, hold: Hold, cause: 'destroyed' | 'expired') => void;
}

interface LivePod {
  tier: number;
  /** Last persisted pose (for the drift re-save). */
  savedX: number;
  savedY: number;
  /** Living World P1a-2 — a DERELICT (an abandoned ship's hulk): salvaged over
   *  time (rate-limited per collect step, contestable), never merged into, and
   *  longer-lived than a normal pod. */
  derelict: boolean;
}

/** Derelict hulks last an hour (a normal pod: 15 min). */
export const DERELICT_TTL_MS = 60 * 60_000;
/** Salvage-over-time: cargo weight transferred per collect step (~10 Hz). */
export const DERELICT_SALVAGE_STEP = 15;
/** Throttle derelict pickup popups to one per this many steps. */
const DERELICT_NOTIFY_STEPS = 10;

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
    opts: { spill?: boolean; derelict?: boolean; cause?: string; extraDeletes?: readonly string[] } = {},
  ): string | null {
    const extraDeletes = opts.extraDeletes ?? [];
    if (isHoldEmpty(hold)) {
      if (extraDeletes.length > 0) this.d.holdStore.commit([], extraDeletes, this.persist());
      return null;
    }
    // A derelict is its own hulk — never merged into a nearby pod (only at the
    // hard cap, where value must still never be evicted).
    const derelict = opts.derelict === true;
    const target = derelict
      ? (this.pods.size >= MAX_LIVE_LOOT_PER_SECTOR ? this.nearestPod(x, y) : null)
      : this.findMergeTarget(x, y);
    if (target !== null) {
      const rec = this.d.holdStore.get(target)!;
      const merged: HoldRecord = { ...rec, hold: cloneHold(rec.hold) };
      mergeInto(merged.hold, cloneHold(hold));
      this.d.holdStore.commit([merged], extraDeletes, this.persist());
      // A player spill stays the bright "scramble" tier once merged into.
      const live = this.pods.get(target)!;
      const tier = opts.spill || live.tier === POD_TIER_SPILL ? POD_TIER_SPILL : holdBestTier(merged.hold);
      if (tier !== live.tier) {
        live.tier = tier;
        this.d.setPodTier(target, tier);
      }
      this.d.onDropped?.(target, hold, opts.cause ?? 'drop');
      return target;
    }
    const id = `pod-${randomUUID().slice(0, 12)}`;
    const tier = opts.spill || derelict ? POD_TIER_SPILL : holdBestTier(hold);
    if (!this.d.spawnPodEntity(id, x, y, vx, vy, tier)) {
      // Slot pool exhausted: never silently destroy value — fold into the
      // nearest pod if any, else leave it with its source (no delete).
      const nearest = this.nearestPod(x, y);
      if (nearest !== null) return this.forceMerge(nearest, hold, extraDeletes, opts.cause);
      return null;
    }
    this.pods.set(id, { tier, savedX: x, savedY: y, derelict });
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
   *  delete are ONE atomic group. No-op for an empty / absent hold. */
  spillShipHold(
    shipInstanceId: string, x: number, y: number, vx: number, vy: number, cause: string, derelict = false,
  ): string | null {
    const rec = this.d.holdStore.get(shipInstanceId);
    if (rec === undefined) return null;
    return this.drop(cloneHold(rec.hold), x, y, vx, vy, { spill: true, derelict, cause, extraDeletes: [shipInstanceId] });
  }

  isDerelict(id: string): boolean {
    return this.pods.get(id)?.derelict === true;
  }

  /** Fly-over pickup pass — call every few ticks from the room update. */
  collectTick(): void {
    if (this.pods.size === 0) return;
    this.d.forEachCollector(this.visitCollector);
  }

  /** Bound once (no per-tick closure allocation, #14). */
  private readonly visitCollector = (c: LootCollector): void => {
    for (const [podId] of this.pods) {
      const pose = this.d.podPose(podId);
      if (pose === null) continue;
      const dx = pose.x - c.x;
      const dy = pose.y - c.y;
      if (dx * dx + dy * dy > LOOT_PICKUP_RADIUS * LOOT_PICKUP_RADIUS) continue;
      this.pickUp(c, podId);
    }
  };

  private pickUp(c: LootCollector, podId: string): void {
    const podRec = this.d.holdStore.get(podId);
    if (podRec === undefined) return;
    const shipRec = this.d.holdStore.get(c.shipInstanceId);
    const shipHold = shipRec ? cloneHold(shipRec.hold) : { goods: {}, blueprints: [] };
    const podHold = cloneHold(podRec.hold);
    // A DERELICT is salvaged over time — a bounded weight per step, so two ships
    // alongside it genuinely contest the haul. A normal pod is taken at once.
    const live = this.pods.get(podId);
    const { moved, srcEmptied } = live?.derelict
      ? transferUpTo(shipHold, podHold, c.capacity, DERELICT_SALVAGE_STEP)
      : transferInto(shipHold, podHold, c.capacity);
    if (isHoldEmpty(moved)) return; // hold full — the pod stays
    const shipNext: HoldRecord = c.npc === true
      ? { holderUid: c.shipInstanceId, holderType: 'hauler', ownerId: null, sectorKey: this.d.sectorKey(), x: null, y: null, hold: shipHold, expiresAt: null }
      : { holderUid: c.shipInstanceId, holderType: 'ship', ownerId: c.playerId, sectorKey: null, x: null, y: null, hold: shipHold, expiresAt: null };
    if (srcEmptied) {
      // ONE atomic group: ship gains + pod row deleted.
      this.d.holdStore.commit([shipNext], [podId], this.persist());
      this.pods.delete(podId);
      this.d.despawnPodEntity(podId);
    } else {
      this.d.holdStore.commit([shipNext, { ...podRec, hold: podHold }], [], this.persist());
    }
    if (live?.derelict) {
      // Throttle salvage popups: accumulate, notify on empty or every N steps.
      const key = `${c.playerId}|${podId}`;
      let acc = this.salvageAcc.get(key);
      if (acc === undefined) { acc = { hold: { goods: {}, blueprints: [] }, steps: 0 }; this.salvageAcc.set(key, acc); }
      transferInto(acc.hold, moved, Infinity);
      acc.steps++;
      if (srcEmptied || acc.steps >= DERELICT_NOTIFY_STEPS) {
        this.d.onCollected?.(c, acc.hold, podId);
        this.salvageAcc.delete(key);
      }
      return;
    }
    this.d.onCollected?.(c, moved, podId);
  }

  /** Derelict salvage popup accumulator: `${playerId}|${podId}` → moved so far. */
  private readonly salvageAcc = new Map<string, { hold: Hold; steps: number }>();

  /** A pod was destroyed by combat damage — its contents are gone. */
  onPodDestroyed(podId: string): void {
    if (!this.pods.delete(podId)) return;
    const rec = this.d.holdStore.get(podId);
    this.d.holdStore.delete(podId, this.persist());
    if (rec) this.d.onDestroyed?.(podId, rec.hold, 'destroyed');
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
        this.pods.delete(podId);
        this.d.holdStore.delete(podId, this.persist());
        this.d.despawnPodEntity(podId);
        this.d.onDestroyed?.(podId, rec.hold, 'expired');
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
        this.pods.set(rec.holderUid, { tier, savedX: rec.x, savedY: rec.y, derelict });
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
