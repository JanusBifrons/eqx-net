/**
 * src/shared-types — cross-zone contracts.
 *
 * Pure TS types and zod schemas only. No runtime behaviour.
 * Used by core, server, and client to agree on wire shapes and
 * SAB layout constants.
 */

export {
  InputMessageSchema,
  IdentifyMessageSchema,
  FireMessageSchema,
  ClientMessageSchema,
} from './messages.js';
export type {
  InputMessage,
  IdentifyMessage,
  FireMessage,
  ClientMessage,
  WelcomeMessage,
  SnapshotMessage,
  HitAckMessage,
  DamageEvent,
  DestroyEvent,
  LaserFiredEvent,
  RespawnAckMessage,
} from './messages.js';

export {
  SEQLOCK_IDX, TICK_IDX, COUNT_IDX, CLOCK_RATE_IDX, CLOCK_RATE_SCALE, WORKER_TICK_US_IDX, HEADER_WORDS,
  SLOT_WORDS, SLOT_ID_OFF, SLOT_X_OFF, SLOT_Y_OFF,
  SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF, SLOT_FLAGS_OFF,
  FLAG_SLEEPING, FLAG_IS_SWARM, FLAG_KIND_DRONE,
  MAX_ENTITIES, SAB_TOTAL_BYTES, slotBase,
} from './sabLayout.js';

export {
  SWARM_WIRE_VERSION,
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES,
  SWARM_FLAG_FULL, SWARM_FLAG_DECIMATED,
  SWARM_RECORD_FLAG_SLEEPING,
  SWARM_KIND_ASTEROID, SWARM_KIND_DRONE,
  swarmRecordCapacity, swarmPacketSize,
} from './swarmWireFormat.js';
