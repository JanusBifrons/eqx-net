/**
 * Server → client: a heavy shell with a blast (the 80 cm siege gun, plan
 * coastal-defences) burst at (x, y). An accelerator for the explosion visual;
 * the damage itself arrives as ordinary damage events (#16).
 */
import { z } from 'zod';

export const ShellBlastSchema = z
  .object({
    type: z.literal('shell_blast'),
    x: z.number(),
    y: z.number(),
    radius: z.number().nonnegative(),
  })
  .strict();
export type ShellBlast = z.infer<typeof ShellBlastSchema>;

/** Damage a blast deals at distance `d` from its centre: full inside
 *  `falloffMin`, then inverse-square (the missile splash rule), 0 outside
 *  `radius`. Shared by the server and any client preview (#15). Pure. */
export function shellBlastDamage(damage: number, d: number, radius: number, falloffMin: number): number {
  if (d > radius) return 0;
  if (d <= falloffMin) return damage;
  const k = falloffMin / d;
  return damage * k * k;
}
