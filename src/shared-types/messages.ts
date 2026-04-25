import { z } from 'zod';

export const InputMessageSchema = z
  .object({
    type: z.literal('input'),
    tick: z.number().int().nonnegative(),
    thrust: z.boolean(),
    turnLeft: z.boolean(),
    turnRight: z.boolean(),
  })
  .strict();

export const IdentifyMessageSchema = z
  .object({
    type: z.literal('identify'),
    playerId: z.string().uuid().nullable(),
  })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  InputMessageSchema,
  IdentifyMessageSchema,
]);

export type InputMessage = z.infer<typeof InputMessageSchema>;
export type IdentifyMessage = z.infer<typeof IdentifyMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface WelcomeMessage {
  type: 'welcome';
  playerId: string;
  /** Server physics tick at the moment the player joined. Client seeds inputTick from this. */
  serverTick: number;
}

/** Authoritative snapshot broadcast by the server every 10 ticks for client-side reconciliation. */
export interface SnapshotMessage {
  type: 'snapshot';
  serverTick: number;
  /** Authoritative ship states at the time the snapshot was taken. */
  states: Record<string, { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }>;
  /** Last client input tick acknowledged by the server for each player. */
  ackedTicks: Record<string, number>;
  /** Authoritative obstacle states. Client overwrites its predicted obstacle state
   *  with these each snapshot — no input replay, just a fresh re-sync. */
  obstacles: Record<string, { x: number; y: number; vx: number; vy: number; angle: number }>;
}
