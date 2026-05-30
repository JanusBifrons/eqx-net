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
  ClientMessageSchema,
} from './messages/clientMessages.js';
export type {
  InputMessage,
  IdentifyMessage,
  FireMessage,
  EngageTransitMessage,
  CancelTransitMessage,
  ClientMessage,
} from './messages/clientMessages.js';

// Authoritative state (server → client)
export type { WelcomeMessage, SnapshotMessage } from './messages/snapshotMessages.js';

// Combat outcomes (server → client)
export {
  CollisionResolvedMessageSchema,
  HitAckSchema,
  DamageEventSchema,
} from './messages/combatMessages.js';
export type {
  HitAckMessage,
  DamageEvent,
  DestroyEvent,
  ShieldEventMessage,
  RespawnAckMessage,
  LaserFiredEvent,
  CollisionResolvedMessage,
} from './messages/combatMessages.js';

// Transit lifecycle (server → client; client → server schemas are in clientMessages)
export type {
  TransitStateLabel,
  TransitCancelReason,
  TransitStateMessage,
  WarpOutEvent,
  WarpInEvent,
} from './messages/transitMessages.js';

// Living World (server → client)
export type { BotAggroEvent } from './messages/livingWorldMessages.js';

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

// Server → client diagnostic broadcasts (paradigm plan: quirky-rabbit, Phase 6).
export type { GcPauseEventMessage } from './messages/diagMessages.js';
