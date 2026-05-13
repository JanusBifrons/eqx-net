import { z } from 'zod';

/**
 * `/healthz` response shape. Both server and client agree on this
 * contract; the server emits and the client parses with a `safeParse`
 * to defend against partial / future-extended payloads.
 *
 * - `status` — always `'ok'` when the endpoint replies. Non-OK
 *   conditions are signalled by the absence of a reply (network error,
 *   non-2xx HTTP), not by this field.
 * - `ready` — `true` once `main()` has finished booting (Limbo +
 *   roster hydrated, galaxy rooms eager-created). The client disables
 *   the Join CTA while `ready === false`.
 * - `tick` — `Date.now()` on the server. Lets the client detect server
 *   time skew if it ever matters; not load-bearing today.
 * - `playersOnline` — deterministic-per-minute hype number (600–900),
 *   moved from the client in 2026-05-13 so all visitors see the same
 *   value. Will swap to a real `matchMaker`-summed count later without
 *   changing the wire shape.
 */
export const HealthResponseSchema = z
  .object({
    status: z.literal('ok'),
    ready: z.boolean(),
    tick: z.number().int().nonnegative(),
    playersOnline: z.number().int().nonnegative(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
