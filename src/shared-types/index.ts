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
