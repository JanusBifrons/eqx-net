/**
 * Named elites (Living World P4a, plan peppy-jumping-pinwheel).
 *
 * Keeps up to `maxElites` named elite NPCs alive across the galaxy. Each is an
 * ordinary NPC ship kind (`ELITE_KINDS`) spawned through the room's living-world
 * bot hook, then promoted with `markElite` (4× hull, a name, guaranteed rare
 * loot on death). It roams its sector slowly; it keeps its kind's allegiance,
 * so a drone elite is neutral until shot and a robot elite attacks on sight.
 *
 * When one dies (ENTITY_DESTROYED on any room's bus) a galaxy-wide
 * `world_notice` goes out and a new elite appears after `respawnMs`, in a
 * different sector. Driven by the drone director's `onTick` (control cadence,
 * ~1.5 s) — allocation here is fine. Not persisted: elites re-seed on boot.
 *
 * Clients learn of an elite from the snapshot (`drones[].elite`, the name) and
 * the galaxy snapshot (`SectorLiveState.elite`, via `sectorElite`) — the
 * notices are accelerators only (#16).
 */
import type { Bus } from '../../core/events/Bus.js';
import { ELITE_ID_PREFIX, ELITE_KINDS, eliteName } from '../../shared-types/elites.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { WorldNotice } from '../../shared-types/worldNotice.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { Rng } from './population.js';

export const MAX_ELITES = 2;
/** A slain elite's replacement appears this long after (a real lull). */
export const ELITE_RESPAWN_MS = 8 * 60_000;
/** How far from the sector centre an elite appears + wanders. */
export const ELITE_SPAWN_RADIUS = 2600;
export const ELITE_ROAM_RADIUS = 3200;
/** Pick a new wander point this often. */
export const ELITE_ROAM_INTERVAL_MS = 40_000;

export interface EliteDirectorOptions {
  rng?: Rng;
  nowMs?: () => number;
  maxElites?: number;
  respawnMs?: number;
  /** Restrict the first spawn to this sector (tests). */
  firstSector?: string;
  /** Force an elite kind (tests). */
  kind?: ShipKindId;
}

interface EliteSlot {
  id: string;
  alive: boolean;
  name: string;
  kind: ShipKindId;
  sectorKey: string | null;
  respawnAtMs: number;
  nextRoamAtMs: number;
}

export interface EliteSummary {
  id: string;
  name: string;
  kind: ShipKindId;
  sectorKey: string;
}

export class EliteDirector {
  private readonly slots: EliteSlot[] = [];
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly respawnMs: number;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];
  private generation = 0;

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    private readonly opts: EliteDirectorOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? Date.now;
    this.respawnMs = opts.respawnMs ?? ELITE_RESPAWN_MS;
    const n = opts.maxElites ?? MAX_ELITES;
    for (let i = 0; i < n; i++) {
      this.slots.push({ id: '', alive: false, name: '', kind: 'gunship', sectorKey: null, respawnAtMs: 0, nextRoamAtMs: 0 });
    }
  }

  start(): void {
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId.startsWith(ELITE_ID_PREFIX)) this.onEliteDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
    this.tick(this.now());
  }

  stop(): void {
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
  }

  /** Control-tick step: spawn due elites, then nudge the living ones. */
  tick(nowMs: number): void {
    for (const slot of this.slots) {
      if (!slot.alive) {
        if (nowMs >= slot.respawnAtMs) this.spawn(slot, nowMs);
        continue;
      }
      if (nowMs < slot.nextRoamAtMs || slot.sectorKey === null) continue;
      const room = this.rooms.get(slot.sectorKey);
      if (!room) continue;
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * ELITE_ROAM_RADIUS;
      room.setBotMoveTarget(slot.id, Math.cos(a) * r, Math.sin(a) * r);
      slot.nextRoamAtMs = nowMs + ELITE_ROAM_INTERVAL_MS;
    }
  }

  /** The living elites (galaxy map, `/dev` inspection). */
  elites(): EliteSummary[] {
    const out: EliteSummary[] = [];
    for (const s of this.slots) {
      if (s.alive && s.sectorKey !== null) out.push({ id: s.id, name: s.name, kind: s.kind, sectorKey: s.sectorKey });
    }
    return out;
  }

  /** The name of a living elite in `sectorKey`, or null (galaxy-snapshot hook). */
  sectorElite(sectorKey: string): string | null {
    for (const s of this.slots) if (s.alive && s.sectorKey === sectorKey) return s.name;
    return null;
  }

  private spawn(slot: EliteSlot, nowMs: number): void {
    const sectorKey = this.pickSector(slot);
    if (sectorKey === null) return;
    const room = this.rooms.get(sectorKey);
    if (!room || !room.hasFreeSlot()) return;
    const kind = this.opts.kind ?? ELITE_KINDS[Math.floor(this.rng() * ELITE_KINDS.length)]!;
    const id = `${ELITE_ID_PREFIX}${this.generation++}`;
    const a = this.rng() * Math.PI * 2;
    const x = Math.cos(a) * ELITE_SPAWN_RADIUS;
    const y = Math.sin(a) * ELITE_SPAWN_RADIUS;
    if (!room.spawnLivingWorldBot({ botId: id, kind, x, y })) return;
    const name = eliteName(this.rng);
    if (room.markElite?.(id, name) !== true) {
      room.despawnLivingWorldBot(id);
      return;
    }
    Object.assign(slot, { id, alive: true, name, kind, sectorKey, nextRoamAtMs: nowMs });
    auditEvent({ event: 'elite_spawned', sector: sectorKey, name, kind });
    serverLogEvent('elite_spawned', { id, name, kind, sectorKey });
    this.announce({ type: 'world_notice', kind: 'elite_spawned', message: `${name} has been sighted!` });
  }

  /** A random live sector not already hosting an elite (the test override first). */
  private pickSector(slot: EliteSlot): string | null {
    if (this.opts.firstSector !== undefined && this.rooms.has(this.opts.firstSector) && this.generation === 0) {
      return this.opts.firstSector;
    }
    const taken = new Set<string>();
    for (const s of this.slots) if (s !== slot && s.alive && s.sectorKey !== null) taken.add(s.sectorKey);
    const keys = [...this.rooms.keys()].filter((k) => !taken.has(k));
    if (keys.length === 0) return null;
    return keys[Math.floor(this.rng() * keys.length)]!;
  }

  private onEliteDestroyed(id: string): void {
    const slot = this.slots.find((s) => s.alive && s.id === id);
    if (!slot) return;
    slot.alive = false;
    slot.sectorKey = null;
    slot.respawnAtMs = this.now() + this.respawnMs;
    serverLogEvent('elite_destroyed', { id, name: slot.name });
    this.announce({ type: 'world_notice', kind: 'elite_killed', message: `${slot.name} has been destroyed!` });
  }

  private announce(notice: WorldNotice): void {
    for (const room of this.rooms.values()) room.broadcastWorldNotice?.(notice);
  }
}
