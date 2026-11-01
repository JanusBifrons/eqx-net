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

export interface RobotTerritoryOptions {
  rng?: Rng;
  nowMs?: () => number;
  nexusRespawnMs?: number;
  /** First nexus sector (tests); default = a random live entry sector. */
  nexusSector?: string;
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

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    private readonly robotCounts: () => ReadonlyMap<string, number>,
    private readonly opts: RobotTerritoryOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? Date.now;
    this.nexusRespawnMs = opts.nexusRespawnMs ?? NEXUS_RESPAWN_MS;
    this.lastTickMs = this.now();
  }

  start(): void {
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId === NEXUS_ID) this.onNexusDestroyed();
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

  private onNexusDestroyed(): void {
    if (!this.nexus || !this.nexus.alive) return;
    this.nexus.alive = false;
    this.nexus.respawnAtMs = this.now() + this.nexusRespawnMs;
    serverLogEvent('robot_nexus_destroyed', { sectorKey: this.nexus.sectorKey });
  }
}
