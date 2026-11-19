/**
 * Server-internal Living World bot lifecycle — the `LivingWorldRoom`
 * contract methods. Bots are NOT Colyseus clients; they're swarm
 * entities the room hosts on behalf of the process-global
 * `LivingWorldDirector`.
 *
 * Three operations:
 *   - `spawnBot`: register a drone in this sector + force a 5 s
 *     join-broadcast window + emit `warp_in` + bus `BOT_SPAWNED`.
 *   - `despawnBot`: quietly remove the bot for an inter-sector warp.
 *     Returns its carry-state for the destination room. CRUCIALLY does
 *     NOT emit `ENTITY_DESTROYED` (that's the director's respawn
 *     trigger; a transit must not look like a kill).
 *   - `markBotHostile`: drive the EXISTING markHostile channel + one
 *     discrete `bot_aggro` broadcast — the server→client twin of the
 *     damage→markHostile mirror.
 *
 * Extracted from SectorRoom (commit 22 partial).
 */

import type { Bus } from '../../core/events/Bus.js';
import type { ClientArray, Client } from 'colyseus';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_FLAGS_OFF,
  FLAG_WARP_SPOOL,
  FLAG_WARP_CRUISE,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { DEFAULT_SHIP_KIND, type ShipKindId } from '../../shared-types/shipKinds.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { SOLAR_HALF_EXTENT } from '../../core/galaxy/sectorSites.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';
import { ARRIVED_TICKS } from './warpTravel.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { BotCarry } from '../livingworld/botTypes.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { WarpInEvent, WarpOutEvent, BotAggroEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';
import type { PatrolSubsystem } from '../bases/PatrolSubsystem.js';
import type { FactionId } from '../../shared-types/factions.js';
import { npcOwner } from '../../shared-types/relations.js';
import { isHaulerId } from '../livingworld/directorBotIds.js';

/** Hostility ledger surface — markHostile is the only call we make. */
export interface HostilityLedger {
  markHostile(droneId: string, playerId: string, tick: number): void;
}

/**
 * Inline-hostility-at-spawn target (WS-E #15). When a squad member spawns/arrives
 * into a sector where its squad is ATTACKING a faction, the director resolves the
 * faction's `playerId` + owned `structureIds` and passes them here so `spawnBot`
 * marks hostility in the SAME call that creates the record — closing the
 * control-tick gap that left a just-arrived member rendering NEUTRAL until the
 * next ~1.5 s wave pulse.
 */
export interface BotHostileTarget {
  playerId: string;
  structureIds: readonly string[];
}

/** Eviction sink — quietly remove a swarm entity. */
export type EvictFn = (
  rec: SwarmEntityRecord,
  opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string },
) => void;

/** Ticks a ship that fled stays in the room on its warp run before it leaves
 *  (0.5 s, as long as the arrival window): long enough for every client's
 *  snapshot to carry the run, so each draws the departure. */
const LEAVE_RUN_TICKS = 30;

/** W2a NPC warp-to: one bot sent on a warp (`warpBot`). */
export interface NpcWarp {
  entityId: number;
  lastPhase: 0 | 1 | 2;
  arrivedUntil: number;
  started: boolean;
  idleTicks: number;
  leave: boolean;
  leaveAt: number;
  leaveX: number;
  leaveY: number;
}

export interface LivingWorldBotHooksDeps {
  serverTick: () => number;
  sectorKey: () => string | null;
  sabF32: Float32Array;
  /** SAB flags view (NPC warp phase, `tickNpcWarps`). */
  sabU32: Uint32Array;
  /** Solar sector (wider playable extent); the room reassigns it in onCreate. */
  solar: () => boolean;
  /** Nearest clear landing spot for a ship of `kind` (the room's obstacles). */
  landingPoint: (id: string, x: number, y: number, kind: string | undefined) => { x: number; y: number };
  postToWorker: (cmd: WorkerCmd) => void;
  /** Iterable of `[playerId, slot]` for the markHostile loop. */
  playerToSlot: Iterable<[string, number]>;
  /** Active-ship resolver for the hostile-target filter. */
  getActiveShip: (pid: string) => ShipState | undefined;
  /** Map of `swarmHealth` (drones only). */
  swarmHealth: Map<string, number>;
  swarmRegistry: SwarmEntityRegistry;
  swarmSpawner: SwarmSpawner;
  aiController: HostilityLedger;
  evictSwarmEntity: EvictFn;
  /** Set + read by the room's idle-suppression gate (force-broadcast
   *  window after a bot lands so its first snapshot reaches the
   *  reconciler). The room passes a setter rather than the value. */
  extendBroadcastGrace: (untilTick: number) => void;
  joinBroadcastGraceTicks: number;
  broadcastWarpIn: (msg: WarpInEvent) => void;
  broadcastWarpOut: (msg: WarpOutEvent) => void;
  broadcastBotAggro: (msg: BotAggroEvent) => void;
  /** Used by the snapshot broadcaster grace window — reported here. */
  bus: Bus;
  /** Colyseus clients (unused today; kept for symmetry). */
  clients: ClientArray<Client>;
  /** Patrol attribution for a spawned bot with a `factionId`. */
  patrols: Pick<PatrolSubsystem, 'attachShip'>;
  /** testMode P2 trigger: robot raiders met per incoming hauler (0 = off). */
  testHaulerRaiders: () => number;
}

export class LivingWorldBotHooks {
  /** W2a NPC warp-to: bots sent on a warp (`warpBot`), until they have
   *  landed and their arrival window has passed. Empty in normal play. */
  readonly npcWarps = new Map<string, NpcWarp>();

  constructor(private readonly deps: LivingWorldBotHooksDeps) {}

  /**
   * W2a NPC warp-to (flagship fleets): send a living-world bot on a warp to
   * (x, y) through the same spool → run → drop machine as a pilot's
   * (World.botWarp). The bot's AI is overridden while it spools and runs;
   * point its move target at the destination too, so it carries on from
   * there. Returns false for an unknown or non-ship id.
   */
  warpBot(botId: string, x: number, y: number): boolean {
    const d = this.deps;
    const rec = d.swarmRegistry.get(botId);
    if (!rec || rec.kind !== 1) return false;
    const lim = d.solar() ? SOLAR_HALF_EXTENT : SECTOR_PLAYABLE_HALF_EXTENT;
    // Land clear of rocks, structures and ships, like a pilot's warp (a drop
    // inside an asteroid belt rock killed an escort in the first test run).
    const p = d.landingPoint(botId, Math.max(-lim, Math.min(lim, x)), Math.max(-lim, Math.min(lim, y)), rec.shipKind);
    d.postToWorker({ type: 'BOT_WARP', slot: rec.slot, x: p.x, y: p.y });
    if (!this.npcWarps.has(botId)) this.npcWarps.set(botId, { entityId: rec.entityId, lastPhase: 0, arrivedUntil: -1, started: false, idleTicks: 0, leave: false, leaveAt: -1, leaveX: 0, leaveY: 0 });
    return true;
  }

  /** Morale flee (AI slice 6b): a fleeing NPC asked to warp out to (x, y)
   *  (`AiIntent.warpOut`, drained by `runAiTick` via the room's
   *  `_handleAiWarpOut`). The same NPC warp as a flagship fleet's
   *  (`warpBot`) spool, but a ship that fled LEAVES the sector once its spool
   *  ends (`tickNpcWarps`): the same departure as any NPC leaving a sector
   *  (`despawnBot`: `warp_out` where it stood, quiet evict, `BOT_DESPAWNED`).
   *  Before 2026-11-14 it ran the in-sector warp and parked at the drop,
   *  still in the room. It stays in the room for LEAVE_RUN_TICKS of its run
   *  first, so every client sees the run begin (`drones[].warp` 2 while the
   *  ship is still in the swarm stream) and draws the departure (take 7:
   *  removed on the run's first tick, the ship just vanished). Rare. */
  warpOut(botId: string, x: number, y: number): void {
    if (!this.warpBot(botId, x, y)) return;
    const w = this.npcWarps.get(botId);
    if (w !== undefined) w.leave = true;
    serverLogEvent('npc_morale_warp_out', { botId, sectorKey: this.deps.sectorKey() ?? '' });
  }

  /** Drop a bot's warp request (cancels a spool; a run can't be stopped). */
  cancelBotWarp(botId: string): void {
    const rec = this.deps.swarmRegistry.get(botId);
    if (rec) this.deps.postToWorker({ type: 'BOT_WARP', slot: rec.slot });
  }

  /** A bot's NPC warp phase: 1 spool, 2 run, 3 just arrived, 0 none. */
  botWarpPhase(botId: string): 0 | 1 | 2 | 3 {
    const w = this.npcWarps.get(botId);
    if (w === undefined) return 0;
    if (w.lastPhase !== 0) return w.lastPhase;
    return w.arrivedUntil >= this.deps.serverTick() ? 3 : 0;
  }

  /** W2a: follow each warping bot's phase from its SAB flags; mark a drop as
   *  "just arrived" for ARRIVED_TICKS (clients draw the drop flash). Called
   *  once per tick from the room's update while `npcWarps` is non-empty. */
  tickNpcWarps(): void {
    const d = this.deps;
    for (const [id, w] of this.npcWarps) {
      const rec = d.swarmRegistry.get(id);
      if (!rec) { this.npcWarps.delete(id); continue; }
      const f = d.sabU32[slotBase(rec.slot) + SLOT_FLAGS_OFF] ?? 0;
      const phase: 0 | 1 | 2 = f & FLAG_WARP_CRUISE ? 2 : f & FLAG_WARP_SPOOL ? 1 : 0;
      if (phase !== 0) w.started = true;
      // A morale warp-out leaves the sector once its run has begun: the
      // room's departure (`warp_out` where the run started), not a drop in
      // this room. The run is shown for LEAVE_RUN_TICKS first: a client draws
      // a ship's departure when it sees the run start (WarpFx, the same as a
      // pilot's), and the swarm stream and the snapshot are separate packets,
      // so removing the ship on the run's first tick could reach a client
      // before (or without) the phase that draws it.
      if (w.leave && w.started && (phase === 2 || w.leaveAt >= 0)) {
        if (w.leaveAt < 0) {
          w.leaveAt = d.serverTick() + LEAVE_RUN_TICKS;
          // Where the run starts (the SAB pose of the run's first tick is at
          // most one tick's run along it).
          const b = slotBase(rec.slot);
          w.leaveX = d.sabF32[b + SLOT_X_OFF]!;
          w.leaveY = d.sabF32[b + SLOT_Y_OFF]!;
        }
        w.lastPhase = 2;
        if (d.serverTick() < w.leaveAt && phase === 2) continue;
        this.npcWarps.delete(id);
        if (this.despawnBot(id, 'fled', w.leaveX, w.leaveY) !== null) serverLogEvent('npc_morale_departed', { botId: id, sectorKey: d.sectorKey() ?? '' });
        continue;
      }
      if (w.lastPhase === 2 && phase === 0) w.arrivedUntil = d.serverTick() + ARRIVED_TICKS;
      w.lastPhase = phase;
      // Done: idle after the arrival window (or a spool that was cancelled /
      // never began within a second of the request).
      if (phase === 0 && d.serverTick() > w.arrivedUntil && (w.started || ++w.idleTicks > 60)) this.npcWarps.delete(id);
    }
  }

  /**
   * Spawn a Living World bot into this sector. Reuses the standard swarm
   * spawn path (slot alloc, SAB prime, worker SPAWN_OBSTACLE, registry,
   * AI register) with a forced kind, primes drone health, opens the
   * join-broadcast grace window so the just-warped-in body streams
   * snapshots for client reconciliation (same rationale as a player
   * join — see JOIN_BROADCAST_GRACE_TICKS), and emits the warp-in visual
   * + discrete bus event. Returns false WITHOUT mutating when the slot
   * pool is exhausted (the director retries elsewhere next tick).
   */
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
    hostileToFaction?: { playerId: string; structureIds: readonly string[] };
    factionId?: FactionId;
  }): boolean {
    const d = this.deps;
    const ok = this.spawnBot(spec);
    if (ok && spec.factionId !== undefined) d.patrols.attachShip(spec.botId, spec.factionId, npcOwner(spec.factionId));
    // P2 bespoke trigger (testMode): robot raiders meet an incoming hauler
    // ~45 % of the way from its entry point to the sector centre.
    if (ok && d.testHaulerRaiders() > 0 && isHaulerId(spec.botId)) {
      for (let i = 0; i < d.testHaulerRaiders(); i++) {
        const a = (i / d.testHaulerRaiders()) * Math.PI * 2;
        const x = spec.x * 0.55 + Math.cos(a) * 160;
        const y = spec.y * 0.55 + Math.sin(a) * 160;
        // `swarm-` prefix ⇒ classified as an NPC attacker (never booked as piracy).
        const id = `swarm-raider-${spec.botId}-${i}`;
        if (d.swarmSpawner.spawnDrone({ id, x, y, kind: 'robot-square' })) {
          d.swarmHealth.set(id, getDroneMaxHealth('robot-square') ?? 120);
        }
      }
    }
    return ok;
  }

  spawnBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
    /** WS-E #15 — mark this bot hostile to the faction (player + owned structures)
     *  INLINE, in the same call that creates the record. Set by the director when
     *  the bot's squad is ATTACKING the faction at this destination, so an
     *  arriving member doesn't render NEUTRAL until the next control-tick pulse. */
    hostileToFaction?: BotHostileTarget;
  }): boolean {
    const d = this.deps;
    const ok = d.swarmSpawner.spawnDrone({
      id: spec.botId,
      x: spec.x,
      y: spec.y,
      vx: spec.vx ?? 0,
      vy: spec.vy ?? 0,
      kind: spec.kind,
    });
    if (!ok) return false;
    const maxHp = getDroneMaxHealth(spec.kind) ?? 40;
    d.swarmHealth.set(spec.botId, spec.health ?? maxHp);
    // Force-broadcast window so a freshly-arrived client reconciles the
    // new body (mirrors the player-join grace).
    d.extendBroadcastGrace(d.serverTick() + d.joinBroadcastGraceTicks);
    d.broadcastWarpIn({
      type: 'warp_in',
      playerId: spec.botId,
      x: spec.x,
      y: spec.y,
    });
    d.bus.emit('BOT_SPAWNED', {
      type: 'BOT_SPAWNED',
      botId: spec.botId,
      sectorKey: d.sectorKey(),
      x: spec.x,
      y: spec.y,
    });
    // WS-E #15 — close the "renders neutral on arrival" race: the record now
    // exists (spawnDrone succeeded), so the inline mark resolves `rec` and the
    // owner's radar colours the bot hostile at warp-in time, not a control tick
    // later. Re-pulsed each tick by the wave's `markSquadHostileToFaction` so it
    // survives the 30 s FORGET_TICKS decay; this is the FIRST pulse.
    if (spec.hostileToFaction) {
      this.markBotHostileToFaction(
        spec.botId,
        spec.hostileToFaction.playerId,
        spec.hostileToFaction.structureIds,
      );
    }
    return true;
  }

  /** `reason` rides `BOT_DESPAWNED`: `fled` (a morale warp-out) tells the
   *  owning director the bot is gone for good. `(atX, atY)` places the
   *  `warp_out` where the departure began (a ship that fled leaves from its
   *  run, a little way past where its run started); absent, its live pose. */
  despawnBot(botId: string, reason: 'transit' | 'fled' = 'transit', atX?: number, atY?: number): BotCarry | null {
    const d = this.deps;
    const rec = d.swarmRegistry.get(botId);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    const x = d.sabF32[b + SLOT_X_OFF]!;
    const y = d.sabF32[b + SLOT_Y_OFF]!;
    const carry: BotCarry = {
      kind: (rec.shipKind as ShipKindId | undefined) ?? DEFAULT_SHIP_KIND,
      health: d.swarmHealth.get(botId) ?? getDroneMaxHealth(rec.shipKind) ?? 40,
      // WS-E #13/#19 — carry the live SAB world pose so the hop arrives near
      // where the bot left (clamped to dest bounds), not at one clustered edge.
      x,
      y,
      vx: d.sabF32[b + SLOT_VX_OFF]!,
      vy: d.sabF32[b + SLOT_VY_OFF]!,
      angle: d.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
    };
    d.broadcastWarpOut({ type: 'warp_out', playerId: botId, x: atX ?? x, y: atY ?? y });
    d.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
    d.bus.emit('BOT_DESPAWNED', {
      type: 'BOT_DESPAWNED',
      botId,
      sectorKey: d.sectorKey(),
      reason,
    });
    return carry;
  }

  markBotHostile(botId: string): void {
    const d = this.deps;
    const rec = d.swarmRegistry.get(botId);
    if (!rec) return;
    const wireId = `swarm-${rec.entityId}`;
    const tick = d.serverTick();
    for (const [pid] of d.playerToSlot) {
      const ship = d.getActiveShip(pid);
      if (!ship?.alive || !ship.isActive) continue;
      d.aiController.markHostile(botId, pid, tick);
      d.broadcastBotAggro({
        type: 'bot_aggro',
        botEntityId: wireId,
        targetPlayerId: pid,
        tick,
      });
    }
  }

  /**
   * Wave-system Phase 4 — mark ONE bot hostile to a whole faction: the faction's
   * player (so the drone may also engage the pilot, and the owner's radar
   * colours the drone hostile via `bot_aggro`) AND every structure id the
   * faction owns (server-only drone targets — no client radar mirror for
   * structures). Reuses the existing `markHostile` channel; the drone's COMBAT
   * pick then sees the structures in `view.structures` (which it's already
   * hostile to) and prioritises them. Re-pulsed each control tick while the
   * squad attacks, so the 30 s `FORGET_TICKS` decay never drops the siege.
   */
  markBotHostileToFaction(botId: string, playerId: string, structureIds: readonly string[]): void {
    const d = this.deps;
    const rec = d.swarmRegistry.get(botId);
    if (!rec) return;
    const tick = d.serverTick();
    // The pilot — broadcast bot_aggro so the owner's HaloRadar shows the threat
    // before first personal contact (req #7).
    d.aiController.markHostile(botId, playerId, tick);
    d.broadcastBotAggro({
      type: 'bot_aggro',
      botEntityId: `swarm-${rec.entityId}`,
      targetPlayerId: playerId,
      tick,
    });
    // The owned structures — server-only targets (drones are snapshot-interp on
    // the client; structure hostility is resolved server-side, no wire surface).
    for (const sid of structureIds) d.aiController.markHostile(botId, sid, tick);
  }
}
