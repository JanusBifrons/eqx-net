/**
 * Shells as events (docs/architecture/shell-events.md §2, §5, §7): the wire
 * shapes for naval shells sent as one `shell_salvo` when fired and one
 * `shell_end` when they hit, instead of riding every 20 Hz snapshot.
 *
 * Slice 1 (this file's first user): the server emits these behind
 * `EQX_SHELL_EVENTS=1` while still sending shells per tick, so nothing on the
 * client changes yet. The client consumes events only when its welcome says
 * `shellEvents: true` (#15: the two sides can't disagree).
 *
 * Positions are 0.1 u, velocities 0.01 u/s (`quantiseShellSpawn`); the server
 * quantises the record at spawn so both sides integrate the same numbers.
 */
import { z } from 'zod';

/** The naval guns whose shells travel as events. */
export const NavalWeaponIdSchema = z.enum([
  'naval_s', 'naval_m', 'naval_l', 'naval_xl', 'naval_xxl', 'naval_siege',
]);
export type NavalWeaponId = z.infer<typeof NavalWeaponIdSchema>;

const ShellIdSchema = z.string().min(1).max(32);
const WireIdSchema = z.string().min(1).max(64);

/** One shell of a salvo: `[id, x, y, vx, vy]` at the salvo's fire tick. */
export const ShellTupleSchema = z.tuple([
  ShellIdSchema,
  z.number(), z.number(),
  z.number(), z.number(),
]);
export type ShellTuple = z.infer<typeof ShellTupleSchema>;

/** Every shell one firer fired with one gun in one tick. */
export const ShellSalvoSchema = z.object({
  type: z.literal('shell_salvo'),
  /** Salvo id (per room, increments). */
  s: z.number().int().nonnegative(),
  /** Owner on the wire (`swarm-<eid>` or a playerId). */
  o: WireIdSchema,
  w: NavalWeaponIdSchema,
  /** Fire tick: the shells' `birthTick`. */
  t: z.number().int().nonnegative(),
  /** `maxTicks`. The swept path ends at `shellPathEndTick(t, n)` (t + n + 1). */
  n: z.number().int().positive(),
  /** The firer's locked target, when it has one. */
  g: WireIdSchema.optional(),
  sh: z.array(ShellTupleSchema).min(1).max(64),
}).strict();
export type ShellSalvo = z.infer<typeof ShellSalvoSchema>;

/** One ended shell: `[id, hitTick, x, y, blastRadius]` (radius 0 = none). */
export const ShellEndTupleSchema = z.tuple([
  ShellIdSchema,
  z.number().int(),
  z.number(), z.number(),
  z.number().nonnegative(),
]);
export type ShellEndTuple = z.infer<typeof ShellEndTupleSchema>;

/** Hits only (a miss sends nothing), batched per tick. A shell stopped by a
 *  shield fence is a hit with radius 0 at the wall. */
export const ShellEndSchema = z.object({
  type: z.literal('shell_end'),
  e: z.array(ShellEndTupleSchema).min(1).max(256),
}).strict();
export type ShellEnd = z.infer<typeof ShellEndSchema>;

/** A keyframe record on the snapshot (§5): one in-flight shell with its salvo
 *  header, `[id, s, o, w, t, n, x, y, vx, vy]`. The client adopts an unknown
 *  id and ignores a known one. */
export const ShellKeyRecordSchema = z.tuple([
  ShellIdSchema,
  z.number().int().nonnegative(),
  WireIdSchema,
  NavalWeaponIdSchema,
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number(), z.number(),
  z.number(), z.number(),
]);
export type ShellKeyRecord = z.infer<typeof ShellKeyRecordSchema>;

/** Most keyframe records in one snapshot. */
export const SHELL_KEY_PER_SNAPSHOT = 8;
/** Each sent shell is re-sent in a keyframe about this often (ticks, 2 s). */
export const SHELL_KEY_PERIOD_TICKS = 120;
/** The server re-tests unsent shells against each viewer this often (1 Hz). */
export const SHELL_RETEST_TICKS = 60;

// ── The switch (per process, read once, like EQX_NAVAL_RANGE) ──────────────

/** Resolve the switch from an env (exported for tests). Only `1`/`true`. */
export function resolveShellEvents(env: Record<string, string | undefined> | undefined): boolean {
  const raw = env?.['EQX_SHELL_EVENTS'];
  return raw === '1' || raw === 'true';
}

const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };

/** Whether this process sends shells as events. Only the server reads it; the
 *  client learns it from the welcome. */
export const SHELL_EVENTS: boolean = resolveShellEvents(g.process?.env);

/** The welcome fields (absent when off, so welcomes are byte-identical). */
export interface WelcomeShellEventFields {
  shellEvents?: true;
  /** Every live shell the joining ship should see, in salvo form (#16). */
  shellsInFlight?: ShellSalvo[];
}
