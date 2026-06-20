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
import type { RecentCombat } from '../../shared-types/galaxySnapshot.js';
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

/**
 * Phase-3 live per-sector counts for the `/galaxy/snapshot` aggregation. The
 * room owns the counting (it holds the swarm registry + structure registry +
 * hostility ledger); the director stamps the static faction + caches the result.
 * Read on the director's ~1.5 s control tick — NEVER the 60 Hz update loop.
 */
export interface SectorLiveCounts {
  /** Active player hulls in this room. */
  players: number;
  /** Drones (kind 1) hostile to a present active player (an active wave). */
  enemies: number;
  /** Drones (kind 1) not hostile to any present player (roaming neutrals). */
  neutrals: number;
  /** Placed structures (StructureRegistry size). */
  structures: number;
}

export interface LivingWorldRoom {
  eventBus(): Bus;
  playerCount(): number;
  /** Phase-3 — live per-sector counts for `/galaxy/snapshot`. OPTIONAL: a mock
   *  room may omit it and the director falls back to `playerCount()` + zeros. */
  liveCounts?(): SectorLiveCounts;
  /** Equinox Phase 9 (item 5) — recent-combat tally for this sector (the galaxy
   *  map's "fighting happened here" indicator + drawer event breakdown), or null
   *  when quiet. OPTIONAL: a mock room may omit it → the director sends null. Off
   *  the 60 Hz tick (read on the ~1.5 s control tick). */
  recentCombat?(): RecentCombat | null;
  /** Equinox Phase 7 — count of structures in this room owned by `playerId`
   *  (the galaxy-map per-player "my structures" overlay; `GET /galaxy/presence`).
   *  OPTIONAL: a mock room may omit it → the director counts 0 for this sector.
   *  Off the 60 Hz tick (the ~4 s presence poll). */
  ownedStructureCount?(playerId: string): number;
  hasFreeSlot(): boolean;
  spawnLivingWorldBot(spec: {
    botId: string;
    kind: ShipKindId;
    x: number;
    y: number;
    vx?: number;
    vy?: number;
    health?: number;
    /** WS-E #15 — mark the bot hostile to this faction (player + owned
     *  structures) INLINE at spawn, so an arriving member of an attacking squad
     *  doesn't render NEUTRAL until the next control-tick pulse. Resolve via
     *  {@link factionHostility}. */
    hostileToFaction?: { playerId: string; structureIds: readonly string[] };
  }): boolean;
  despawnLivingWorldBot(botId: string): BotCarry | null;
  markBotHostile(botId: string): void;
  /** WS-E #15 — resolve a faction's hostility members in THIS room: the owning
   *  player id + every structure id the faction owns here. Mirrors the resolver
   *  `markSquadHostileToFaction` uses, exposed so the director can pre-populate
   *  `spawnLivingWorldBot`'s `hostileToFaction` at the destination room. */
  factionHostility(factionId: string): { playerId: string; structureIds: readonly string[] };
  /** Roaming-formation (Phase 5): the live pose of a living-world bot in this
   *  room (SAB ground truth), or null if it has no slot here. The director reads
   *  the squad LEADER's pose to anchor the formation frame each control tick. */
  getBotPose(botId: string): { x: number; y: number; angle: number } | null;
  /** Roaming-formation (Phase 5): assign a bot's in-sector MOVE target — its
   *  formation slot (followers) or the squad destination (leader). The drone's
   *  IDLE behaviour flies to it via an arrive ramp. No-op if the bot isn't an
   *  in-sector drone here. */
  setBotMoveTarget(botId: string, x: number, y: number): void;
  /** Leader-led flocking (non-combat herding): mark a bot a FOLLOWER of
   *  `leaderId`; while IDLE it flocks (cohesion/alignment/separation) to the
   *  leader's LIVE pose each tick (`memberIds` drive separation), instead of a
   *  static wedge slot. No-op if the bot isn't an in-sector drone here. */
  setBotFlockFollow(botId: string, leaderId: string, memberIds: readonly string[]): void;
  /** Leader-led flocking (non-combat herding): assign a bot the squad LEADER's
   *  COURSE — like `setBotMoveTarget` but flags it a throttled flock leader so it
   *  cruises slower than its followers (they tighten around it). The director
   *  points the course at the leader's own pose to make it HOLD while the flock
   *  gathers. No-op if the bot isn't an in-sector drone here. */
  setBotFlockLeaderCourse(botId: string, x: number, y: number): void;
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
