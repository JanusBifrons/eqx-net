/**
 * World events (Living World P4b, plan peppy-jumping-pinwheel).
 *
 * Runs one world event at a time somewhere in the galaxy, with a lull between
 * events. Kinds (see `shared-types/worldEvents.ts`):
 *
 *  - `incursion`  — 6 robots (1 hexagon, 2 circles, 3 cubes) appear together;
 *                   they are hostile on sight by the stance table. When the
 *                   last raider dies, a reward cache drops where they stood.
 *  - `mothership` — a 6×-hull named missile frigate ("Drone Mothership") plus
 *                   4 fighter escorts. The mothership's kill ends the event (it
 *                   drops the elite haul — it is tagged through `markElite`).
 *  - `salvage`    — rich loot pods scattered around a point; ends on a timer.
 *
 * An unfinished event fades at its deadline: survivors leave quietly (no
 * loot). Start, finish and fade each send a galaxy-wide `world_notice`
 * (accelerator); the truth is `SectorLiveState.event` via `sectorEvent`.
 *
 * Driven by the drone director's `onTick` (~1.5 s) — allocation here is fine.
 * Not persisted: a restart simply starts a fresh lull.
 */
import type { Bus } from '../../core/events/Bus.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import {
  EVENT_ID_PREFIX,
  MOTHERSHIP_HEALTH_MUL,
  SALVAGE_POD_COUNT,
  WORLD_EVENT_DURATION_MS,
  WORLD_EVENT_KINDS,
  WORLD_EVENT_TITLES,
  rollIncursionCache,
  rollSalvagePod,
  type WorldEventKind,
  type WorldEventView,
} from '../../shared-types/worldEvents.js';
import type { WorldNotice } from '../../shared-types/worldNotice.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import type { LivingWorldRoom } from './LivingWorldRoom.js';
import type { Rng } from './population.js';

/** The lull between one event ending and the next starting. */
export const WORLD_EVENT_INTERVAL_MS = 9 * 60_000;
/** Events happen this far from the sector centre (clear of spawns). */
export const WORLD_EVENT_RADIUS = 1800;

const INCURSION_KINDS: readonly ShipKindId[] = [
  'robot-hexagon', 'robot-circle', 'robot-circle', 'robot-square', 'robot-square', 'robot-square',
];
const MOTHERSHIP_KIND: ShipKindId = 'missile-frigate';
const ESCORT_KIND: ShipKindId = 'fighter';
const ESCORT_COUNT = 4;
export const MOTHERSHIP_NAME = 'Drone Mothership';

export interface EventDirectorOptions {
  rng?: Rng;
  nowMs?: () => number;
  intervalMs?: number;
  /** First event fires after this delay (default: one full interval). */
  firstDelayMs?: number;
}

interface ActiveEvent {
  kind: WorldEventKind;
  sectorKey: string;
  endsAtMs: number;
  x: number;
  y: number;
  /** Live event NPCs (incursion raiders / mothership + escorts). */
  mobs: Set<string>;
  /** The mob whose death ends the event (the mothership), if any. */
  bossId: string | null;
}

export class EventDirector {
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private active: ActiveEvent | null = null;
  private nextAtMs: number;
  private seq = 0;
  private readonly subs: Array<{ bus: Bus; fn: (e: { type: 'ENTITY_DESTROYED'; entityId: string }) => void }> = [];

  constructor(
    private readonly rooms: ReadonlyMap<string, LivingWorldRoom>,
    opts: EventDirectorOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.nowMs ?? Date.now;
    this.intervalMs = opts.intervalMs ?? WORLD_EVENT_INTERVAL_MS;
    this.nextAtMs = this.now() + (opts.firstDelayMs ?? this.intervalMs);
  }

  start(): void {
    for (const room of this.rooms.values()) {
      const bus = room.eventBus();
      const fn = (e: { type: 'ENTITY_DESTROYED'; entityId: string }): void => {
        if (e.entityId.startsWith(EVENT_ID_PREFIX)) this.onMobDestroyed(e.entityId);
      };
      bus.on('ENTITY_DESTROYED', fn);
      this.subs.push({ bus, fn });
    }
  }

  stop(): void {
    for (const s of this.subs) s.bus.off('ENTITY_DESTROYED', s.fn);
    this.subs.length = 0;
  }

  /** Control-tick step: fade an overdue event, or start the next one. */
  tick(nowMs: number): void {
    const a = this.active;
    if (a !== null) {
      if (nowMs >= a.endsAtMs) this.finish(a, 'faded', nowMs);
      return;
    }
    if (nowMs < this.nextAtMs) return;
    const keys = [...this.rooms.keys()];
    if (keys.length === 0) return;
    const kind = WORLD_EVENT_KINDS[Math.floor(this.rng() * WORLD_EVENT_KINDS.length)]!;
    const sector = keys[Math.floor(this.rng() * keys.length)]!;
    // A failed start (a full room) just retries next tick.
    this.startEvent(kind, sector, nowMs);
  }

  /** Start `kind` in `sectorKey` now (also the `/dev/world-event/start` trigger).
   *  Returns false if an event is already running or the room can't host it. */
  startEvent(kind: WorldEventKind, sectorKey: string, nowMs = this.now()): boolean {
    if (this.active !== null) return false;
    const room = this.rooms.get(sectorKey);
    if (!room) return false;
    const a = this.rng() * Math.PI * 2;
    const x = Math.cos(a) * WORLD_EVENT_RADIUS;
    const y = Math.sin(a) * WORLD_EVENT_RADIUS;
    const ev: ActiveEvent = {
      kind, sectorKey, x, y, endsAtMs: nowMs + WORLD_EVENT_DURATION_MS[kind], mobs: new Set(), bossId: null,
    };
    const seq = this.seq++;
    if (kind === 'incursion') {
      INCURSION_KINDS.forEach((k, i) => this.spawnMob(room, ev, `${EVENT_ID_PREFIX}${seq}-${i}`, k, i, INCURSION_KINDS.length));
      if (ev.mobs.size === 0) return false;
    } else if (kind === 'mothership') {
      const bossId = `${EVENT_ID_PREFIX}${seq}-boss`;
      this.spawnMob(room, ev, bossId, MOTHERSHIP_KIND, 0, 1, 0);
      if (!ev.mobs.has(bossId) || room.markElite?.(bossId, MOTHERSHIP_NAME, MOTHERSHIP_HEALTH_MUL) !== true) {
        for (const id of ev.mobs) room.despawnLivingWorldBot(id);
        return false;
      }
      ev.bossId = bossId;
      for (let i = 0; i < ESCORT_COUNT; i++) this.spawnMob(room, ev, `${EVENT_ID_PREFIX}${seq}-${i}`, ESCORT_KIND, i, ESCORT_COUNT);
    } else {
      for (let i = 0; i < SALVAGE_POD_COUNT; i++) {
        const r = 120 + this.rng() * 420;
        const t = this.rng() * Math.PI * 2;
        room.dropEventLoot?.(rollSalvagePod(this.rng), x + Math.cos(t) * r, y + Math.sin(t) * r);
      }
    }
    this.active = ev;
    const title = WORLD_EVENT_TITLES[kind];
    auditEvent({ event: 'world_event_started', sector: sectorKey, kind });
    serverLogEvent('world_event_started', { kind, sectorKey });
    this.announce({ type: 'world_notice', kind: 'event_started', message: `${title} detected!` });
    return true;
  }

  /** The live event in `sectorKey` (galaxy-snapshot hook), or null. */
  sectorEvent(sectorKey: string): WorldEventView | null {
    const a = this.active;
    if (a === null || a.sectorKey !== sectorKey) return null;
    return { kind: a.kind, title: WORLD_EVENT_TITLES[a.kind], endsAtMs: a.endsAtMs };
  }

  /** The live event anywhere (inspection / tests). */
  activeEvent(): (WorldEventView & { sectorKey: string; mobs: number }) | null {
    const a = this.active;
    if (a === null) return null;
    return { kind: a.kind, title: WORLD_EVENT_TITLES[a.kind], endsAtMs: a.endsAtMs, sectorKey: a.sectorKey, mobs: a.mobs.size };
  }

  private spawnMob(room: LivingWorldRoom, ev: ActiveEvent, id: string, kind: ShipKindId, i: number, n: number, ring = 150): void {
    const t = (i / Math.max(1, n)) * Math.PI * 2;
    if (room.spawnLivingWorldBot({ botId: id, kind, x: ev.x + Math.cos(t) * ring, y: ev.y + Math.sin(t) * ring })) {
      ev.mobs.add(id);
      room.setBotMoveTarget(id, ev.x, ev.y);
    }
  }

  private onMobDestroyed(id: string): void {
    const a = this.active;
    if (a === null || !a.mobs.delete(id)) return;
    if (a.kind === 'mothership' && id === a.bossId) this.finish(a, 'completed', this.now());
    else if (a.kind === 'incursion' && a.mobs.size === 0) {
      this.rooms.get(a.sectorKey)?.dropEventLoot?.(rollIncursionCache(this.rng), a.x, a.y);
      this.finish(a, 'completed', this.now());
    }
  }

  private finish(a: ActiveEvent, outcome: 'completed' | 'faded', nowMs: number): void {
    // Survivors leave quietly (no loot, no destroyed event).
    const room = this.rooms.get(a.sectorKey);
    for (const id of a.mobs) room?.despawnLivingWorldBot(id);
    a.mobs.clear();
    this.active = null;
    this.nextAtMs = nowMs + this.intervalMs;
    const title = WORLD_EVENT_TITLES[a.kind];
    auditEvent({ event: 'world_event_ended', sector: a.sectorKey, kind: a.kind, outcome });
    serverLogEvent('world_event_ended', { kind: a.kind, sectorKey: a.sectorKey, outcome });
    let message = `${title} has faded.`;
    if (outcome === 'completed') message = a.kind === 'mothership' ? 'The Drone Mothership has been destroyed!' : `${title} cleared!`;
    if (a.kind === 'salvage' && outcome === 'faded') message = 'The salvage field has drifted away.';
    this.announce({ type: 'world_notice', kind: 'event_ended', message });
  }

  private announce(notice: WorldNotice): void {
    for (const room of this.rooms.values()) room.broadcastWorldNotice?.(notice);
  }
}
