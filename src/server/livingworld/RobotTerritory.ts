/**
 * Robot territory + the robot NEXUS (Living World P3, plan peppy-jumping-pinwheel).
 *
 * Composed with the robot `LivingWorldDirector` through its hooks:
 *   - `respawnAnchor` — while the nexus lives, killed robots respawn AT it (the
 *     robots-only ingress exception) instead of entering from the galaxy edge;
 *   - `onTick`        — each control tick: respawn a destroyed nexus when due,
 *     then step every sector's control pressure (`core/territory/sectorControl`);
 *   - `sectorOwner`   — handed to the DRONE director (the `/galaxy/snapshot`
 *     provider) so robot-held sectors show the robots as owner on the map.
 *
 * The nexus is a single `robot-nexus` swarm entity (`rbot-nexus`, so it is an
 * NPC id and the robot director's own pool ignores it). It lives in an ENTRY
 * sector (robots come from outside known space), is never load-shed, and when
 * destroyed drops the nexus loot table and returns after `nexusRespawnMs` in a
 * different entry sector. Off the 60 Hz tick (control cadence) — no netgate on
 * this module itself; the nexus rides the existing swarm wire.
 */
import type { SectorOwner } from '../../shared-types/galaxySnapshot.js';
import type { GoodId } from '../../shared-types/goods.js';
import type { Bus } from '../../core/events/Bus.js';
import {
  freshControl,
  isContested,
  stepControl,
  type ControlInputs,
  type SectorControlState,
} from '../../core/territory/sectorControl.js';
import { liveEntrySectors, type Rng } from './population.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';

export const NEXUS_ID = 'rbot-nexus';
/** A destroyed nexus returns after this long (a real win for the players). */
export const NEXUS_RESPAWN_MS = 20 * 60_000;
/** Distance of the nexus from its sector centre (clear of the central spawn). */
export const NEXUS_RADIUS = 2400;
export const ROBOT_FACTION_ID = 'robots';

/** P3b — harvesters: robot scavengers that bank loot into the nexus. */
export const HARVESTERS_PER_NEXUS = 2;
export const HARVESTER_ID_PREFIX = 'rbot-harv-';
/** Cargo weight a harvester carries (the collector capacity). */
export const HARVESTER_CAPACITY = 400;
/** A harvester heads home once this full (or when no pod is left to chase). */
export const HARVESTER_RETURN_FRAC = 0.75;
/** Within this distance of the nexus, a harvester banks its whole hold. */
export const HARVESTER_BANK_RADIUS = 260;
export const HARVESTER_RESPAWN_MS = 90_000;

/** P3c — raids: with no pod to chase, a harvester raids player storage within
 *  RAID_RANGE of its nexus, stealing up to RAID_STEP_WEIGHT per control tick
 *  (rarest goods first, plus some credits) while within RAID_DOCK_RADIUS. */
export const RAID_RANGE = 3000;
export const RAID_DOCK_RADIUS = 200;
export const RAID_STEP_WEIGHT = 30;
export const RAID_CREDITS_PER_STEP = 25;
export const RAID_PRIORITY: readonly GoodId[] = ['core', 'alloy', 'salvage', 'minerals'];
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
  private readonly control = new Map<string, SectorControlState>();
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly nexusRespawnMs: number;
  private nexus: { sectorKey: string; x: number; y: number; alive: boolean; respawnAtMs: number } | null = null;
  private lastTickMs: number;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];
  private readonly scratch: ControlInputs = { robots: 0, nexus: false, playerStructures: 0, players: 0 };
  /** P3b — harvester id → where it lives + when it may respawn. */
  private readonly harvesters = new Map<string, { alive: boolean; sectorKey: string | null; respawnAtMs: number }>();
  private readonly harvesterRespawnMs: number;

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    private readonly robotCounts: () => ReadonlyMap<string, number>,
    private readonly opts: RobotTerritoryOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? Date.now;
    this.nexusRespawnMs = opts.nexusRespawnMs ?? NEXUS_RESPAWN_MS;
    this.harvesterRespawnMs = opts.harvesterRespawnMs ?? HARVESTER_RESPAWN_MS;
    this.lastTickMs = this.now();
    for (let i = 0; i < HARVESTERS_PER_NEXUS; i++) {
      this.harvesters.set(`${HARVESTER_ID_PREFIX}${i}`, { alive: false, sectorKey: null, respawnAtMs: 0 });
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
  }

  stop(): void {
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
  }

  // ── Hooks ───────────────────────────────────────────────────────────────

  respawnAnchor(): { sectorKey: string; x: number; y: number } | null {
    const n = this.nexus;
    return n && n.alive ? { sectorKey: n.sectorKey, x: n.x, y: n.y } : null;
  }

  sectorOwner(sectorKey: string): SectorOwner | null {
    const s = this.control.get(sectorKey);
    if (!s || !s.robotHeld) return null;
    return { factionId: ROBOT_FACTION_ID, contested: isContested(s, this.inputsFor(sectorKey)) };
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
      if (!s) { s = freshControl(); this.control.set(key, s); }
      if (stepControl(s, this.inputsFor(key), dt)) {
        serverLogEvent(s.robotHeld ? 'robot_sector_claimed' : 'robot_sector_released', { sectorKey: key });
      }
    }
  }

  // ── Introspection (tests / dev) ─────────────────────────────────────────

  nexusState(): { sectorKey: string; alive: boolean } | null {
    return this.nexus ? { sectorKey: this.nexus.sectorKey, alive: this.nexus.alive } : null;
  }

  heldSectors(): string[] {
    const out: string[] = [];
    for (const [k, s] of this.control) if (s.robotHeld) out.push(k);
    return out;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private inputsFor(sectorKey: string): ControlInputs {
    const i = this.scratch;
    const room = this.rooms.get(sectorKey);
    const counts = room?.liveCounts?.();
    i.robots = this.robotCounts().get(sectorKey) ?? 0;
    i.nexus = this.nexus !== null && this.nexus.alive && this.nexus.sectorKey === sectorKey;
    i.players = counts?.players ?? room?.playerCount() ?? 0;
    i.playerStructures = counts?.structures ?? 0;
    return i;
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
   *     actual pickup), or idles beside the nexus.
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
      // P3c — nothing to scoop: raid the nearest player storage near the nexus.
      const raid = !full && pod === null ? (room.nearestPlayerStorage?.(n.x, n.y, RAID_RANGE) ?? null) : null;
      const goHome = full || (carried > 0 && pod === null && raid === null);
      if (raid !== null) {
        if (Math.hypot(pose.x - raid.x, pose.y - raid.y) <= RAID_DOCK_RADIUS) {
          const step = Math.min(RAID_STEP_WEIGHT, HARVESTER_CAPACITY - carried);
          const took = room.raidStorage?.(id, raid.owner, raid.uid, step) ?? 0;
          if (took > 0) serverLogEvent('robot_harvester_raided', { id, owner: raid.owner, weight: took });
        } else {
          room.setBotMoveTarget(id, raid.x, raid.y);
        }
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
