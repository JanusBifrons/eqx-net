/**
 * Robot territory + the robot NEXUS (Living World P3, plan peppy-jumping-pinwheel).
 *
 * Composed with the robot `LivingWorldDirector` through its hooks:
 *   - `respawnAnchor` — while the nexus lives, killed robots respawn AT it (the
 *     robots-only ingress exception) instead of entering from the galaxy edge;
 *   - `onTick`        — each control tick: respawn a destroyed nexus when due,
 *     then step every sector's control meter for EVERY side
 *     (`core/territory/sectorControl` `stepMultiControl`): robots are one side
 *     among the players, the powers, the Traders, the drones and the rest;
 *   - `sectorOwner`   — handed to the DRONE director (the `/galaxy/snapshot`
 *     provider) so the map shows whichever side holds each sector.
 *
 * Each sector starts held by its static controller (`core/galaxy/control`:
 * Sol holds the core, each power its region heart); the rest start neutral.
 * An empty sector keeps its holder. A living nexus LOCKS a robot-held sector:
 * nobody can flip it until the nexus dies (`stepMultiControl` `lockedBy`).
 *
 * The nexus is a single `robot-nexus` swarm entity (`rbot-nexus`, so it is an
 * NPC id and the robot director's own pool ignores it). It lives in an ENTRY
 * sector (robots come from outside known space), is never load-shed, and when
 * destroyed drops the nexus loot table and returns after `nexusRespawnMs` in a
 * different entry sector. Off the 60 Hz tick (control cadence) — no netgate on
 * this module itself; the nexus rides the existing swarm wire.
 */
import { sectorSpace } from '../../shared-types/sectorBounds.js';
import type { SectorOwner } from '../../shared-types/galaxySnapshot.js';
import { cargoCapacityForMaxHealth, type GoodId } from '../../shared-types/goods.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { Bus } from '../../core/events/Bus.js';
import {
  CONTROL_MAX,
  freshMultiControl,
  isMultiContested,
  stepMultiControl,
  type MultiControlState,
  type SidePresence,
} from '../../core/territory/sectorControl.js';
import { sectorController } from '../../core/galaxy/control.js';
import { controlOpposes, fillSectorPresence, ROBOT_SIDE } from './factionPresence.js';
import { liveEntrySectors, type Rng } from './population.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { LivingWorldRoom, SectorLiveCounts } from './LivingWorldRoom.js';
import { gameNow } from '../time/gameTime.js';
import type { PersistedSectorControl } from './DirectorPersistence.js';

/** The running meter, so a room can ask who holds its sector (the Territory
 *  Lock placement rule) without a director reference. Set in `start()`. */
let activeTerritory: RobotTerritory | null = null;
function setActiveTerritory(t: RobotTerritory | null): void {
  activeTerritory = t;
}

/** The live holder of `sectorKey` (null = neutral), or undefined when no
 *  control meter is running (tests, robots off). Placement cadence. */
export function liveSectorHolder(sectorKey: string): string | null | undefined {
  return activeTerritory?.controlState(sectorKey)?.holder;
}

/** Saved shares below this are dropped (keeps the persisted row small). */
const SAVE_MIN_SHARE = 0.5;

/** True when rounded `shares` + `holder` equal the sector's static seed. */
function isSeedState(sectorKey: string, holder: string | null, shares: ReadonlyArray<[string, number]>): boolean {
  const seed = sectorController(sectorKey);
  if (holder !== seed) return false;
  if (seed === null) return shares.length === 0;
  return shares.length === 1 && shares[0]![0] === seed && shares[0]![1] === CONTROL_MAX;
}

export const NEXUS_ID = 'rbot-nexus';
/** A destroyed nexus returns after this long (a real win for the players). */
export const NEXUS_RESPAWN_MS = 20 * 60_000;
/** Distance of the nexus from its sector centre (clear of the central spawn). */
export const NEXUS_RADIUS = sectorSpace(2400);
export const ROBOT_FACTION_ID = ROBOT_SIDE;

/** P3b — harvesters: robot scavengers that bank loot into the nexus. */
export const HARVESTERS_PER_NEXUS = 2;
export const HARVESTER_ID_PREFIX = 'rbot-harv-';
/** Cargo weight a harvester carries — its kind's cargo capacity (the same
 *  number the loot collector clamps to, `cargoCapacityForMaxHealth`). */
export const HARVESTER_CAPACITY = cargoCapacityForMaxHealth(getShipKind('robot-harvester'));
/** A harvester heads home once this full (or when no pod is left to chase). */
export const HARVESTER_RETURN_FRAC = 0.75;
/** Within this distance of the nexus, a harvester banks its whole hold. */
export const HARVESTER_BANK_RADIUS = 260;
export const HARVESTER_RESPAWN_MS = 90_000;

/** P3c — raids: with no pod to chase, a harvester raids player storage within
 *  RAID_RANGE of its nexus, stealing up to RAID_STEP_WEIGHT per control tick
 *  (rarest goods first) while within RAID_DOCK_RADIUS. Credits are virtual
 *  (economy v2) — a raid can never take them. */
export const RAID_RANGE = sectorSpace(3000);
/** Harvesters hunt any hauler (trade or convoy) within this range of them. They
 *  are hostile to traders on sight, so closing in starts the attack; a killed
 *  hauler spills its cargo as a pod, which the harvester then scoops. */
export const HAULER_HUNT_RANGE = sectorSpace(2500);
export const RAID_DOCK_RADIUS = 200;
export const RAID_STEP_WEIGHT = 30;
export const RAID_PRIORITY: readonly GoodId[] = ['core', 'alloy', 'salvage', 'minerals'];
/** W6 — mining: with nothing else to do, a harvester mines the nearest rock
 *  with ore left within MINE_RANGE of itself, MINE_STEP_UNITS of ore per
 *  control tick (~1.5 s) while within MINE_REACH of the rock's surface, and
 *  banks it at the nexus once full. Same pool and yield as a Miner (20 a s). */
export const MINE_RANGE = sectorSpace(3000);
export const MINE_STEP_UNITS = 30;
export const MINE_REACH = 120;
/** The owner is warned at most this often per room. */
export const RAID_NOTICE_THROTTLE_MS = 60_000;

export interface RobotTerritoryOptions {
  rng?: Rng;
  nowMs?: () => number;
  nexusRespawnMs?: number;
  /** First nexus sector (tests); default = a random live entry sector. */
  nexusSector?: string;
  harvesterRespawnMs?: number;
}

export class RobotTerritory {
  private readonly control = new Map<string, MultiControlState>();
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly nexusRespawnMs: number;
  private nexus: { sectorKey: string; x: number; y: number; alive: boolean; respawnAtMs: number } | null = null;
  private lastTickMs: number;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];
  /** One sector's presence (reused; the meter reads it synchronously). */
  private readonly presence = new Map<string, SidePresence>();
  private readonly presencePool: SidePresence[] = [];
  /** One sector's live locks (reused; see `locksFor`). */
  private readonly locks = new Set<string>();
  /** P3b — harvester id → where it lives + when it may respawn. */
  private readonly harvesters = new Map<string, { alive: boolean; sectorKey: string | null; respawnAtMs: number; mining: boolean }>();
  private readonly harvesterRespawnMs: number;

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    private readonly robotCounts: () => ReadonlyMap<string, number>,
    private readonly opts: RobotTerritoryOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? gameNow;
    this.nexusRespawnMs = opts.nexusRespawnMs ?? NEXUS_RESPAWN_MS;
    this.harvesterRespawnMs = opts.harvesterRespawnMs ?? HARVESTER_RESPAWN_MS;
    this.lastTickMs = this.now();
    for (const key of rooms.keys()) this.control.set(key, freshMultiControl(sectorController(key)));
    for (let i = 0; i < HARVESTERS_PER_NEXUS; i++) {
      this.harvesters.set(`${HARVESTER_ID_PREFIX}${i}`, { alive: false, sectorKey: null, respawnAtMs: 0, mining: false });
    }
  }

  start(): void {
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId === NEXUS_ID) this.onNexusDestroyed();
        else if (e.entityId.startsWith(HARVESTER_ID_PREFIX)) this.onHarvesterDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
    this.placeNexus(this.opts.nexusSector ?? this.pickNexusSector(null));
    setActiveTerritory(this);
  }

  stop(): void {
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
    if (activeTerritory === this) setActiveTerritory(null);
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  respawnAnchor(): { sectorKey: string; x: number; y: number } | null {
    const n = this.nexus;
    return n && n.alive ? { sectorKey: n.sectorKey, x: n.x, y: n.y } : null;
  }

  /** The side holding a sector (any side), or null for neutral ground. */
  sectorOwner(sectorKey: string): SectorOwner | null {
    const s = this.control.get(sectorKey);
    if (!s || s.holder === null) return null;
    return { factionId: s.holder, contested: isMultiContested(s, this.presenceFor(sectorKey), controlOpposes) };
  }

  /** Control-tick step (robot director `onTick`). */
  tick(nowMs: number): void {
    const n = this.nexus;
    if (n && !n.alive && nowMs >= n.respawnAtMs) {
      this.placeNexus(this.pickNexusSector(n.sectorKey));
    } else if (n && !n.alive && n.respawnAtMs === Infinity) {
      // Placement failed earlier (no free slot) — retry.
      this.placeNexus(n.sectorKey);
    }
    this.harvesterStep(nowMs);
    const dt = nowMs - this.lastTickMs;
    this.lastTickMs = nowMs;
    for (const key of this.rooms.keys()) {
      let s = this.control.get(key);
      if (!s) { s = freshMultiControl(sectorController(key)); this.control.set(key, s); }
      const counts = this.rooms.get(key)?.liveCounts?.();
      const r = stepMultiControl(s, this.presenceOf(key, counts), controlOpposes, dt, this.locksFor(key, counts?.lockSides));
      if (r.flipped) serverLogEvent('sector_control_changed', { sectorKey: key, from: r.previousHolder, to: s.holder });
    }
  }

  // ── Persistence (rides the robot director's state row) ──────────────────

  /**
   * Each sector's control meter that differs from its static seed, for the
   * robot director's persisted state (`saveSectorControl` hook). Shares are
   * rounded to 1 decimal and shares under 0.5 are dropped, so a sector the meter
   * has drifted back to its seed is not saved. Persist cadence; allocation fine.
   */
  saveControl(): PersistedSectorControl[] {
    const out: PersistedSectorControl[] = [];
    for (const [sectorKey, s] of this.control) {
      const shares: Array<[string, number]> = [];
      for (const [side, v] of s.shares) {
        const r = Math.round(v * 10) / 10;
        if (r >= SAVE_MIN_SHARE) shares.push([side, r]);
      }
      shares.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      if (isSeedState(sectorKey, s.holder, shares)) continue;
      out.push({ sectorKey, holder: s.holder, shares });
    }
    return out;
  }

  /** Overlay saved control onto the seeds (`restoreSectorControl` hook). A
   *  sector not in this galaxy is ignored; a sector not saved keeps its seed. */
  restoreControl(entries: readonly PersistedSectorControl[]): void {
    for (const e of entries) {
      if (!this.rooms.has(e.sectorKey)) continue;
      const shares = new Map<string, number>();
      for (const [side, v] of e.shares) shares.set(side, Math.min(CONTROL_MAX, Math.max(0, v)));
      this.control.set(e.sectorKey, { shares, holder: e.holder });
    }
  }

  /** A sector's live control meter (tests / dev). */
  controlState(sectorKey: string): Readonly<MultiControlState> | undefined {
    return this.control.get(sectorKey);
  }

  // ── Introspection (tests / dev) ─────────────────────────────────────────

  nexusState(): { sectorKey: string; alive: boolean } | null {
    return this.nexus ? { sectorKey: this.nexus.sectorKey, alive: this.nexus.alive } : null;
  }

  /** Sectors held by `side` (default: the robots). */
  heldSectors(side: string = ROBOT_SIDE): string[] {
    const out: string[] = [];
    for (const [k, s] of this.control) if (s.holder === side) out.push(k);
    return out;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Every side's presence in a sector: the room's per-faction ships and
   *  structures, with the robots from the robot director's count + the nexus. */
  private presenceFor(sectorKey: string): ReadonlyMap<string, SidePresence> {
    return this.presenceOf(sectorKey, this.rooms.get(sectorKey)?.liveCounts?.());
  }

  private presenceOf(sectorKey: string, counts: SectorLiveCounts | undefined): ReadonlyMap<string, SidePresence> {
    const robots = this.robotCounts().get(sectorKey) ?? 0;
    const nexus = this.nexus !== null && this.nexus.alive && this.nexus.sectorKey === sectorKey;
    fillSectorPresence(this.presence, this.presencePool, counts?.byFaction, robots, nexus);
    return this.presence;
  }

  /** The sides with a live lock in a sector (reused set). The robots' living
   *  nexus is the robots' lock; a built Territory Lock structure is its owner
   *  side's lock (`lockSides` from the room's `liveCounts`). A locked sector
   *  can't be taken until the lock dies (the stepper ignores a lock its side
   *  doesn't hold). */
  private locksFor(sectorKey: string, lockSides: readonly string[] | undefined): ReadonlySet<string> {
    this.locks.clear();
    if (lockSides) for (const side of lockSides) this.locks.add(side);
    const n = this.nexus;
    if (n !== null && n.alive && n.sectorKey === sectorKey) this.locks.add(ROBOT_SIDE);
    return this.locks;
  }

  private pickNexusSector(avoid: string | null): string {
    const keys = [...this.rooms.keys()];
    const entries = liveEntrySectors(keys).filter((k) => k !== avoid);
    const pool = entries.length > 0 ? entries : keys;
    return pool[Math.floor(this.rng() * pool.length)] ?? keys[0] ?? '';
  }

  private placeNexus(sectorKey: string): void {
    const room = this.rooms.get(sectorKey);
    // A fixed pose per sector (bearing from the key), clear of the centre.
    let h = 2166136261;
    for (let c = 0; c < sectorKey.length; c++) h = Math.imul(h ^ sectorKey.charCodeAt(c), 16777619) >>> 0;
    const a = (h % 360) * (Math.PI / 180);
    const x = Math.cos(a) * NEXUS_RADIUS;
    const y = Math.sin(a) * NEXUS_RADIUS;
    const ok = room !== undefined && room.hasFreeSlot()
      && room.spawnLivingWorldBot({ botId: NEXUS_ID, kind: 'robot-nexus', x, y });
    this.nexus = { sectorKey, x, y, alive: ok, respawnAtMs: ok ? 0 : Infinity };
    serverLogEvent(ok ? 'robot_nexus_spawned' : 'robot_nexus_spawn_failed', { sectorKey });
  }

  /** Harvester ids that are alive right now (tests / dev). */
  liveHarvesters(): string[] {
    const out: string[] = [];
    for (const [id, h] of this.harvesters) if (h.alive) out.push(id);
    return out;
  }

  /**
   * P3b — keep the harvesters alive and working. Each one:
   *   - (re)spawns at a living nexus when due;
   *   - follows the nexus to its new sector after a nexus respawn (its hold,
   *     keyed by its id, travels with it);
   *   - heads home once ≥ HARVESTER_RETURN_FRAC full (or when it carries
   *     something and no pod is left), and banks the whole hold into the
   *     nexus within HARVESTER_BANK_RADIUS;
   *   - otherwise chases the nearest loot pod (the room's collector does the
   *     actual pickup); with no pod, hauler or storage to raid it mines the
   *     nearest rock with ore (W6), or idles beside the nexus.
   * Control cadence (~1.5 s); allocation here is fine.
   */
  private harvesterStep(nowMs: number): void {
    const n = this.nexus;
    const nexusAlive = n !== null && n.alive;
    for (const [id, h] of this.harvesters) {
      if (!h.alive) {
        if (!nexusAlive || nowMs < h.respawnAtMs) continue;
        const room = this.rooms.get(n.sectorKey);
        if (!room || !room.hasFreeSlot()) continue;
        const a = (id.charCodeAt(id.length - 1) % 6) * (Math.PI / 3);
        if (room.spawnLivingWorldBot({ botId: id, kind: 'robot-harvester', x: n.x + Math.cos(a) * 180, y: n.y + Math.sin(a) * 180 })) {
          h.alive = true;
          h.sectorKey = n.sectorKey;
          serverLogEvent('robot_harvester_spawned', { id, sectorKey: n.sectorKey });
        }
        continue;
      }
      if (!nexusAlive || h.sectorKey === null) continue;
      if (h.sectorKey !== n.sectorKey) {
        // The nexus moved: recall the harvester (quietly — its hold stays keyed by id).
        this.rooms.get(h.sectorKey)?.despawnLivingWorldBot(id);
        h.alive = false;
        h.respawnAtMs = nowMs;
        continue;
      }
      const room = this.rooms.get(h.sectorKey);
      const pose = room?.getBotPose(id) ?? null;
      if (!room || pose === null) continue;
      const carried = room.holdWeight?.(id) ?? 0;
      const pod = room.nearestLootPod?.(pose.x, pose.y) ?? null;
      const full = carried >= HARVESTER_CAPACITY * HARVESTER_RETURN_FRAC;
      // Nothing to scoop: hunt a hauler nearby (killing it spills a pod to scoop).
      const prey = !full && pod === null ? (room.nearestHauler?.(pose.x, pose.y, HAULER_HUNT_RANGE) ?? null) : null;
      // P3c — no pod and no hauler: raid the nearest player storage near the nexus.
      const raid = !full && pod === null && prey === null ? (room.nearestPlayerStorage?.(n.x, n.y, RAID_RANGE) ?? null) : null;
      // W6 — nothing to scoop, hunt or raid: mine the nearest rock with ore.
      // It starts mining only empty-handed (anything it scooped is banked first)
      // and then keeps at it until full or the ore runs out.
      const rock = !full && pod === null && prey === null && raid === null && (carried === 0 || h.mining)
        ? (room.nearestOreAsteroid?.(pose.x, pose.y, MINE_RANGE) ?? null) : null;
      h.mining = rock !== null;
      const goHome = full || (carried > 0 && pod === null && prey === null && raid === null && rock === null);
      if (prey !== null) {
        room.setBotMoveTarget(id, prey.x, prey.y);
      } else if (raid !== null) {
        if (Math.hypot(pose.x - raid.x, pose.y - raid.y) <= RAID_DOCK_RADIUS) {
          const step = Math.min(RAID_STEP_WEIGHT, HARVESTER_CAPACITY - carried);
          const took = room.raidStorage?.(id, raid.owner, raid.uid, step) ?? 0;
          if (took > 0) serverLogEvent('robot_harvester_raided', { id, owner: raid.owner, weight: took });
        } else {
          room.setBotMoveTarget(id, raid.x, raid.y);
        }
      } else if (rock !== null) {
        // Park just off the rock's surface on our side (flying at its centre rams it).
        const dx = pose.x - rock.x, dy = pose.y - rock.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d <= rock.radius + MINE_REACH) {
          const took = room.mineAsteroid?.(id, rock.entityId, MINE_STEP_UNITS, HARVESTER_CAPACITY) ?? 0;
          if (took > 0) serverLogEvent('robot_harvester_mined', { id, weight: took });
        }
        const stand = rock.radius + MINE_REACH * 0.5;
        room.setBotMoveTarget(id, rock.x + (dx / d) * stand, rock.y + (dy / d) * stand);
      } else if (goHome) {
        if (Math.hypot(pose.x - n.x, pose.y - n.y) <= HARVESTER_BANK_RADIUS) {
          const moved = room.bankHold?.(id, NEXUS_ID) ?? 0;
          if (moved > 0) serverLogEvent('robot_harvester_banked', { id, weight: moved });
        } else {
          room.setBotMoveTarget(id, n.x, n.y);
        }
      } else if (pod !== null) {
        room.setBotMoveTarget(id, pod.x, pod.y);
      } else {
        room.setBotMoveTarget(id, n.x + 220, n.y);
      }
    }
  }

  private onHarvesterDestroyed(id: string): void {
    const h = this.harvesters.get(id);
    if (!h || !h.alive) return;
    h.alive = false;
    h.sectorKey = null;
    h.mining = false;
    h.respawnAtMs = this.now() + this.harvesterRespawnMs;
    serverLogEvent('robot_harvester_destroyed', { id });
  }

  private onNexusDestroyed(): void {
    if (!this.nexus || !this.nexus.alive) return;
    this.nexus.alive = false;
    this.nexus.respawnAtMs = this.now() + this.nexusRespawnMs;
    serverLogEvent('robot_nexus_destroyed', { sectorKey: this.nexus.sectorKey });
  }
}
