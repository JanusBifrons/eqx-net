/**
 * Network message barrel — re-exports the family-split modules under
 * `messages/`. Kept as a `.ts` file (not a directory `index.ts`) so the
 * `nodeNext` resolver picks up the existing `./messages.js` import paths
 * across the codebase without per-site changes.
 *
 * Split by family per the god-file refactor plan
 * (`docs/plans/refactor-god-files.md`, commit 3). All previous exports
 * preserved — zero call-site changes required.
 */

import type { z } from 'zod';
import { WelcomeSchema, ControlModeMessageSchema } from './messages/snapshotMessages.js';
import {
  CollisionResolvedMessageSchema,
  HitAckSchema,
  DamageEventSchema,
  ShipLevelUpEventSchema,
  ShipUpgradeAppliedEventSchema,
  MountActivatedEventSchema,
} from './messages/combatMessages.js';
import { WarpWarningSchema, WarpWarningClearSchema, BaseReadySchema } from './messages/transitMessages.js';
import { EntityStatsSchema } from './messages/selectionMessages.js';
import { FleetStatusMessageSchema } from './messages/fleetStatusMessages.js';
import { MissileFiredEventSchema, MissileDetonatedEventSchema } from './messages/missileMessages.js';
import { WallHitEventSchema } from './messages/wallHitMessages.js';
import { LootCollectedEventSchema, CargoDepositedEventSchema, NoticeEventSchema } from './messages/lootMessages.js';
import { BreakInNoticeSchema, CargoStateSchema } from './messages/cargoMessages.js';
import { ClaimFactionLookResultSchema, FactionLookClaimedSchema } from './messages/factionMessages.js';
import { LabStateSchema } from './messages/labMessages.js';
import { ShellSalvoSchema, ShellEndSchema } from './messages/shellEvents.js';

// Inbound (client → server)
export {
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
  EngageTransitSchema,
  CancelTransitSchema,
  TestAggroSchema,
  TestReloadTurretsSchema,
  TestKillCapitalsSchema,
  TestFleetWarpSchema,
  TestTractorSchema,
  ClientReadyMessageSchema,
  PlaceStructureSchema,
  RemoveStructureSchema,
  StructureActionSchema,
  UpgradeStructureSchema,
  SetGateAccessSchema,
  SetRecipeSchema,
  LoadBlueprintSchema,
  UnloadBlueprintSchema,
  RefineSalvageSchema,
  RepairShipSchema,
  PilotShipSchema,
  SpectateSchema,
  FleetModeSchema,
  FleetStanceSchema,
  FleetOrderSchema,
  SetModeSchema,
  SetStanceSchema,
  FormSquadSchema,
  DisbandSquadSchema,
  CommandSchema,
  StartModeSchema,
  StatIdSchema,
  StatAllocSchema,
  ApplyShipUpgradeSchema,
  RespecShipSchema,
  ActivateMountSchema,
  LockRequestSchema,
  LockCancelSchema, LockTrackSchema,
  SetGroupModeSchema,
  ClientMessageSchema,
} from './messages/clientMessages.js';
export type {
  InputMessage,
  IdentifyMessage,
  FireMessage,
  EngageTransitMessage,
  CancelTransitMessage,
  ClientReadyMessage,
  PlaceStructureMessage,
  RemoveStructureMessage,
  StructureActionMessage,
  UpgradeStructureMessage,
  SetGateAccessMessage,
  PilotShipMessage,
  SpectateMessage,
  FleetOrderMessage,
  SetModeMessage,
  SetStanceMessage,
  FormSquadMessage,
  DisbandSquadMessage,
  CommandMessage,
  StartMode,
  StatId,
  WireStatAlloc,
  ApplyShipUpgradeMessage,
  RespecShipMessage,
  ActivateMountMessage,
  LockRequestMessage,
  LockCancelMessage,
  SetGroupModeMessage,
  ClientMessage,
} from './messages/clientMessages.js';

// Authoritative state (server → client)
export type { WelcomeMessage, SnapshotMessage, SessionReplacedMessage, WreckDescriptor, WreckSync, TimeScaleKeyframe } from './messages/snapshotMessages.js';
export { SESSION_REPLACED_CLOSE_CODE } from './messages/snapshotMessages.js';
// Campaign 6.1 — defensive ingest schema for `welcome` (client-side safeParse;
// the 20 Hz `snapshot` is the documented invariant-#3 carve-out — see the
// SnapshotMessage docstring).
export { WelcomeSchema } from './messages/snapshotMessages.js';
// Combat outcomes (server → client)
export {
  CollisionResolvedMessageSchema,
  HitAckSchema,
  DamageEventSchema,
  DestroyEventSchema,
  ShipLevelUpEventSchema,
  ShipUpgradeAppliedEventSchema,
  WireActivatedMountSchema,
  MountActivatedEventSchema,
} from './messages/combatMessages.js';
export type {
  HitAckMessage,
  DamageEvent,
  DestroyEvent,
  ShipLevelUpEvent,
  ShipUpgradeAppliedEvent,
  WireActivatedMount,
  MountActivatedEvent,
  ShieldEventMessage,
  RespawnAckMessage,
  LaserFiredEvent,
  CollisionResolvedMessage,
} from './messages/combatMessages.js';

// Transit lifecycle (server → client; client → server schemas are in clientMessages)
export {
  WarpWarningSchema,
  WarpWarningClearSchema,
  WarpDispositionSchema,
  BaseReadySchema,
  parseTransitReadyShipIds,
} from './messages/transitMessages.js';
export type {
  TransitStateLabel,
  TransitCancelReason,
  TransitStateMessage,
  TransitReadyMessage,
  WarpOutEvent,
  WarpInEvent,
  WarpWarningEvent,
  WarpWarningClearEvent,
  WarpDisposition,
  BaseReadyEvent,
} from './messages/transitMessages.js';

// Living World (server → client)
export type { BotAggroEvent } from './messages/livingWorldMessages.js';
export type { GridPulseEvent, GridFlowMaterial } from './messages/gridMessages.js';

// Click-to-inspect selection-scoped stats channel (structures follow-up Item B5)
export {
  SelectEntitySchema,
  DeselectEntitySchema,
  EntityStatsSchema,
} from './messages/selectionMessages.js';
export type {
  SelectEntityMessage,
  DeselectEntityMessage,
  EntityStatsMessage,
} from './messages/selectionMessages.js';

// RTS command layer slice 7 — owner-only fleet status stream (server → client)
export {
  FleetStatusMessageSchema,
  encodeFleetStatusRow,
  decodeFleetStatusRow,
} from './messages/fleetStatusMessages.js';

// Missile subsystem (server → client)
export {
  MissileFiredEventSchema,
  MissileDetonatedEventSchema,
} from './messages/missileMessages.js';
export type {
  MissileFiredEvent,
  MissileDetonatedEvent,
} from './messages/missileMessages.js';

// Fence-hit fix (server → client)
export { WallHitEventSchema } from './messages/wallHitMessages.js';
export type { WallHitEvent } from './messages/wallHitMessages.js';

// Multi-ship roster (server → client)
export type { ShipRosterEntry, ShipRosterMessage } from './messages/rosterMessages.js';
// Campaign 6.1 — defensive ingest schemas (client-side safeParse; invariant #3).
export { ShipRosterEntrySchema, ShipRosterSchema } from './messages/rosterMessages.js';

// Server → client diagnostic broadcasts (paradigm plan: quirky-rabbit, Phase 6).
export type { GcPauseEventMessage } from './messages/diagMessages.js';

// Server → client message type → its zod schema. Every server → client
// message has a row here; its handler lives in `src/client/net/handlers/`.
export const ServerMessageSchemas = {
  welcome: WelcomeSchema,
  control_mode: ControlModeMessageSchema,
  collision_resolved: CollisionResolvedMessageSchema,
  hit_ack: HitAckSchema,
  damage: DamageEventSchema,
  ship_level_up: ShipLevelUpEventSchema,
  ship_upgrade_applied: ShipUpgradeAppliedEventSchema,
  mount_activated: MountActivatedEventSchema,
  warp_warning: WarpWarningSchema,
  warp_warning_clear: WarpWarningClearSchema,
  base_ready: BaseReadySchema,
  entity_stats: EntityStatsSchema,
  fleet_status: FleetStatusMessageSchema,
  missile_fired: MissileFiredEventSchema,
  missile_detonated: MissileDetonatedEventSchema,
  wall_hit: WallHitEventSchema,
  shell_salvo: ShellSalvoSchema,
  shell_end: ShellEndSchema,
  notice: NoticeEventSchema,
  loot_collected: LootCollectedEventSchema,
  cargo_deposited: CargoDepositedEventSchema,
  break_in_notice: BreakInNoticeSchema,
  cargo_state: CargoStateSchema,
  claim_faction_look_result: ClaimFactionLookResultSchema,
  faction_look_claimed: FactionLookClaimedSchema,
  lab_state: LabStateSchema,
} as const;

/** A server → client message type with a `ServerMessageSchemas` row. */
export type ServerMessageType = keyof typeof ServerMessageSchemas;
/** The parsed payload of server → client message `K`. */
export type ServerMessagePayload<K extends ServerMessageType> = z.infer<(typeof ServerMessageSchemas)[K]>;
