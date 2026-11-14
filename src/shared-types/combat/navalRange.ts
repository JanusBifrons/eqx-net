/**
 * The naval range switch (ranges plan, slice 14; owner decision 2026-11-10;
 * `real` made the default by owner decision 2026-11-14).
 *
 *  - `real` (default): REAL ranges in the game's own kilometres (1 km =
 *    1,000 u, as on the warp map), time of flight real ÷ 3 (`navalGuns.ts`).
 *  - `legacy` (opt-in): the naval guns reach what they did before the switch
 *    (16" ≈ 5,400 u).
 *
 * Read ONCE at module load, the same way in every context, so the server
 * fires and the client draws its range and lock rings from the same weapon
 * catalogue (invariant #15):
 *  - Node (server, tests): env `EQX_NAVAL_RANGE`;
 *  - page: `globalThis.__EQX_NAVAL_RANGE__`, set by `index.html` from
 *    `?navalRange=` before any module loads;
 *  - workers: the worker `name` (`navalRange=legacy`, see
 *    `navalRangeWorkerNameSuffix`, appended by `shipScaleWorkerName`).
 *
 * The weapon catalogue is built at load, so the switch is per PROCESS, not per
 * room: the server decides it, stamps it on every welcome, and the client
 * checks it (`navalRangeMismatch`, logged as `naval_range_mismatch`).
 * Pure: no imports.
 */

export type NavalRangeMode = 'legacy' | 'real';
export const DEFAULT_NAVAL_RANGE: NavalRangeMode = 'real';
/** What a welcome WITHOUT the field means: it came from a server built
 *  before `real` became the default, and those ran `legacy`. */
const UNSTAMPED_WELCOME_NAVAL_RANGE: NavalRangeMode = 'legacy';

interface Sources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_NAVAL_RANGE__?: unknown };
  workerName?: string;
}

/** Resolve the mode from the given sources (exported for tests). Anything
 *  but `legacy` is `real`. */
export function resolveNavalRange(src: Sources): NavalRangeMode {
  let raw: unknown = src.env?.['EQX_NAVAL_RANGE'] ?? src.global?.__EQX_NAVAL_RANGE__;
  if (raw === undefined && src.workerName) raw = /(?:^|;)navalRange=(\w+)/.exec(src.workerName)?.[1];
  return raw === 'legacy' ? 'legacy' : DEFAULT_NAVAL_RANGE;
}

const g = globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
  __EQX_NAVAL_RANGE__?: unknown;
  name?: unknown; WorkerGlobalScope?: unknown;
};

/** The naval range mode this process runs at. */
export const NAVAL_RANGE: NavalRangeMode = resolveNavalRange({
  env: g.process?.env,
  global: g,
  workerName: typeof g.WorkerGlobalScope !== 'undefined' && typeof g.name === 'string' ? g.name : undefined,
});

/** Appended to a worker's name so workers build the same naval guns (carries
 *  only the non-default mode, `legacy`). */
export function navalRangeWorkerNameSuffix(mode: NavalRangeMode = NAVAL_RANGE): string {
  return mode === 'legacy' ? ';navalRange=legacy' : '';
}

/** The welcome field. Always stamped, both values: a welcome without it is
 *  read as `legacy` (a server from before the default flipped), so an old
 *  server can't pass for the new default. */
export interface WelcomeNavalRangeFields {
  navalRange?: NavalRangeMode;
}

/** Server side: stamp this process's mode onto a welcome. */
export function stampNavalRange<W extends WelcomeNavalRangeFields>(w: W, mode: NavalRangeMode = NAVAL_RANGE): W {
  return { ...w, navalRange: mode };
}

export type NavalRangeMismatch = { server: NavalRangeMode; client: NavalRangeMode; fix: string };

/** Client side: how a welcome's mode differs from this client's, or null. */
export function navalRangeMismatch(msg: WelcomeNavalRangeFields, client: NavalRangeMode = NAVAL_RANGE): NavalRangeMismatch | null {
  const server = msg.navalRange ?? UNSTAMPED_WELCOME_NAVAL_RANGE;
  if (server === client) return null;
  return { server, client, fix: `?navalRange=${server}` };
}
