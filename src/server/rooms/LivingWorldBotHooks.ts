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
  slotBase,
} from '../../shared-types/sabLayout.js';
import { DEFAULT_SHIP_KIND, type ShipKindId } from '../../shared-types/shipKinds.js';
import { getDroneMaxHealth } from './droneKindHelpers.js';
import type { BotCarry } from '../livingworld/botTypes.js';
import type { SwarmSpawner } from '../spawn/SwarmSpawner.js';
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { WarpInEvent, WarpOutEvent, BotAggroEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';

/** Hostility ledger surface — markHostile is the only call we make. */
export interface HostilityLedger {
  markHostile(droneId: string, playerId: string, tick: number): void;
}

/** Eviction sink — quietly remove a swarm entity. */
export type EvictFn = (
  rec: SwarmEntityRecord,
  opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string },
) => void;

export interface LivingWorldBotHooksDeps {
  serverTick: () => number;
  sectorKey: () => string | null;
  sabF32: Float32Array;
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
}

export class LivingWorldBotHooks {
  constructor(private readonly deps: LivingWorldBotHooksDeps) {}

  spawnBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
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
    return true;
  }

  despawnBot(botId: string): BotCarry | null {
    const d = this.deps;
    const rec = d.swarmRegistry.get(botId);
    if (!rec) return null;
    const b = slotBase(rec.slot);
    const carry: BotCarry = {
      kind: (rec.shipKind as ShipKindId | undefined) ?? DEFAULT_SHIP_KIND,
      health: d.swarmHealth.get(botId) ?? getDroneMaxHealth(rec.shipKind) ?? 40,
      vx: d.sabF32[b + SLOT_VX_OFF]!,
      vy: d.sabF32[b + SLOT_VY_OFF]!,
      angle: d.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: d.sabF32[b + SLOT_ANGVEL_OFF]!,
    };
    const x = d.sabF32[b + SLOT_X_OFF]!;
    const y = d.sabF32[b + SLOT_Y_OFF]!;
    d.broadcastWarpOut({ type: 'warp_out', playerId: botId, x, y });
    d.evictSwarmEntity(rec, { broadcast: false, emitDestroyed: false });
    d.bus.emit('BOT_DESPAWNED', {
      type: 'BOT_DESPAWNED',
      botId,
      sectorKey: d.sectorKey(),
      reason: 'transit',
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
