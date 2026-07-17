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

// Inbound (client → server)
export {
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
  EngageTransitSchema,
  CancelTransitSchema,
  ClientReadyMessageSchema,
  PlaceStructureSchema,
  RemoveStructureSchema,
  StructureActionSchema,
  UpgradeStructureSchema,
  PilotShipSchema,
  SpectateSchema,
  StatIdSchema,
  StatAllocSchema,
  ApplyShipUpgradeSchema,
  RespecShipSchema,
  ActivateMountSchema,
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
  PilotShipMessage,
  SpectateMessage,
  StatId,
  WireStatAlloc,
  ApplyShipUpgradeMessage,
  RespecShipMessage,
  ActivateMountMessage,
  ClientMessage,
} from './messages/clientMessages.js';

// Authoritative state (server → client)
export type { WelcomeMessage, SnapshotMessage } from './messages/snapshotMessages.js';
// Campaign 6.1 — defensive ingest schema for `welcome` (client-side safeParse;
// the 20 Hz `snapshot` is the documented invariant-#3 carve-out — see the
// SnapshotMessage docstring).
export { WelcomeSchema } from './messages/snapshotMessages.js';

// Combat outcomes (server → client)
export {
  CollisionResolvedMessageSchema,
  HitAckSchema,
  DamageEventSchema,
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
} from './messages/transitMessages.js';
export type {
  TransitStateLabel,
  TransitCancelReason,
  TransitStateMessage,
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

// Missile subsystem (server → client)
export {
  MissileFiredEventSchema,
  MissileDetonatedEventSchema,
} from './messages/missileMessages.js';
export type {
  MissileFiredEvent,
  MissileDetonatedEvent,
} from './messages/missileMessages.js';

// Multi-ship roster (server → client)
export type { ShipRosterEntry, ShipRosterMessage } from './messages/rosterMessages.js';
// Campaign 6.1 — defensive ingest schemas (client-side safeParse; invariant #3).
export { ShipRosterEntrySchema, ShipRosterSchema } from './messages/rosterMessages.js';

// Server → client diagnostic broadcasts (paradigm plan: quirky-rabbit, Phase 6).
export type { GcPauseEventMessage } from './messages/diagMessages.js';
