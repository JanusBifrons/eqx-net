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
  ClientMessageSchema,
} from './messages.js';
export type { InputMessage, IdentifyMessage, ClientMessage, WelcomeMessage } from './messages.js';

export {
  SEQLOCK_IDX, TICK_IDX, COUNT_IDX, HEADER_WORDS,
  SLOT_WORDS, SLOT_ID_OFF, SLOT_X_OFF, SLOT_Y_OFF,
  SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_FLAGS_OFF,
  MAX_ENTITIES, SAB_TOTAL_BYTES, slotBase,
} from './sabLayout.js';
