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
}
