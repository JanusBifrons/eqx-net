/**
 * The narrow surface the LivingWorldDirector drives. `SectorRoom`
 * satisfies this structurally (Step 3 hooks + the `eventBus`
 * accessor); the director never imports the 3.8k-line room.
 *
 * Extracted from `LivingWorldDirector.ts` so the room-side type lives
 * next to the director sub-modules that consume it.
 */

import type { Bus } from '../../core/events/Bus.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { WarpWarningEvent, WarpWarningClearEvent } from '../../shared-types/messages.js';
import type { BotCarry } from './botTypes.js';

/**
 * Per-(owner, sector) faction base summary the `WaveDirector` polls (wave-system
 * Phase 4). One entry per player who owns ≥1 structure in this room.
 */
export interface FactionBaseReadiness {
  /** Faction id == owning player id. */
  factionId: string;
  /** The sector this base lives in (this room's sectorKey). */
  sectorKey: string;
  /** Base has a constructed Capital + ≥1 Miner + ≥1 Solar + ≥1 Turret (req #3). */
  ready: boolean;
  /** The faction owner is currently an ACTIVE player in this sector. A wave only
   *  STARTS against a present owner — the 5-min warning + countdown is pointless
   *  if they're offline and can't defend (an in-progress wave continues if they
   *  leave; only assignment is gated). */
  ownerPresent: boolean;
  /** Surviving constructed Miners — the de-escalation key (req #8). */
  minerCount: number;
  /** Faction is currently hostile to drones (member attacked OR under wave). */
  hostileToDrones: boolean;
  /** A wave is already assigned/active against this faction. */
  underWave: boolean;
  /** Server tick a faction member last dealt damage to a drone (`-Infinity` ⇒
   *  never) — the peaceful-timeout anchor for `shouldDeEscalate`. */
  lastDealtDamageTick: number;
  /** This room's CURRENT server tick — the `nowTick` the de-escalation
   *  comparison must use (same room-tick reference as `lastDealtDamageTick`;
   *  the director's wall-clock control loop is a different reference). */
  serverTick: number;
}

export interface LivingWorldRoom {
  eventBus(): Bus;
  playerCount(): number;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
  }): boolean;
  despawnLivingWorldBot(botId: string): BotCarry | null;
  markBotHostile(botId: string): void;
  /** Roaming-formation (Phase 5): the live pose of a living-world bot in this
   *  room (SAB ground truth), or null if it has no slot here. The director reads
   *  the squad LEADER's pose to anchor the formation frame each control tick. */
  getBotPose(botId: string): { x: number; y: number; angle: number } | null;
  /** Roaming-formation (Phase 5): assign a bot's in-sector MOVE target — its
   *  formation slot (followers) or the squad destination (leader). The drone's
   *  IDLE behaviour flies to it via an arrive ramp. No-op if the bot isn't an
   *  in-sector drone here. */
  setBotMoveTarget(botId: string, x: number, y: number): void;
  /** Wave-system Phase 4 — per-faction base summary for wave planning. Empty on
   *  engineering rooms (`sectorKey === null`; waves are galaxy-only). */
  factionBaseReadiness(): FactionBaseReadiness[];
  /** Wave-system Phase 4 — set/clear a faction's active-wave flag (gates the
   *  drone-AI structure-target visibility). */
  setFactionUnderWave(factionId: string, underWave: boolean): void;
  /** Wave-system Phase 4 — mark a squad's bots hostile to a whole faction
   *  (the faction's player + every owned structure id) AND broadcast bot_aggro
   *  per bot so the owner's radar colours them (req #7). Re-pulsed each control
   *  tick while the squad attacks (else 30 s FORGET_TICKS drops the siege). */
  markSquadHostileToFaction(botIds: readonly string[], factionId: string): void;
  /** Wave-system Phase 6 — drones stand down from a faction (de-escalation):
   *  purge the faction's player + every owned structure id from every drone's
   *  hostility set. */
  purgeFactionHostility(factionId: string): void;
  /** Wave-system Phase 5 — broadcast a sector-wide warp-in warning to this
   *  room's occupants (the HUD countdown banner). One per incoming squad. */
  broadcastWarpWarning(msg: WarpWarningEvent): void;
  /** Phase-4 P0 — clear a pending warp-in warning (the inbound arrived / retreated
   *  / cancelled). Companion to `broadcastWarpWarning`; keyed by the same `id`. */
  broadcastWarpWarningClear(msg: WarpWarningClearEvent): void;
}
