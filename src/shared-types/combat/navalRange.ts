/**
 * The naval range switch (ranges plan, slice 14; owner decision 2026-11-10).
 *
 *  - `legacy` (default): the naval guns reach what they always have
 *    (16" ≈ 5,400 u).
 *  - `real`: REAL ranges in the game's own kilometres (1 km = 1,000 u, as on
 *    the warp map), time of flight real ÷ 3 (`navalGuns.ts`).
 *
 * Read ONCE at module load, the same way in every context, so the server
 * fires and the client draws its range and lock rings from the same weapon
 * catalogue (invariant #15):
 *  - Node (server, tests): env `EQX_NAVAL_RANGE`;
 *  - page: `globalThis.__EQX_NAVAL_RANGE__`, set by `index.html` from
 *    `?navalRange=` before any module loads;
 *  - workers: the worker `name` (`navalRange=real`, see
 *    `navalRangeWorkerNameSuffix`, appended by `shipScaleWorkerName`).
 *
 * The weapon catalogue is built at load, so the switch is per PROCESS, not per
 * room: the server decides it, stamps it on every welcome, and the client
 * checks it (`navalRangeMismatch`, logged as `naval_range_mismatch`).
 * Pure: no imports.
 */

export type NavalRangeMode = 'legacy' | 'real';
export const DEFAULT_NAVAL_RANGE: NavalRangeMode = 'legacy';

interface Sources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_NAVAL_RANGE__?: unknown };
  workerName?: string;
}

/** Resolve the mode from the given sources (exported for tests). Anything
 *  but `real` is `legacy`. */
export function resolveNavalRange(src: Sources): NavalRangeMode {
  let raw: unknown = src.env?.['EQX_NAVAL_RANGE'] ?? src.global?.__EQX_NAVAL_RANGE__;
  if (raw === undefined && src.workerName) raw = /(?:^|;)navalRange=(\w+)/.exec(src.workerName)?.[1];
  return raw === 'real' ? 'real' : DEFAULT_NAVAL_RANGE;
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

/** Appended to a worker's name so workers build the same naval guns. */
export function navalRangeWorkerNameSuffix(mode: NavalRangeMode = NAVAL_RANGE): string {
  return mode === 'real' ? ';navalRange=real' : '';
}

/** The welcome field (sent only when not the default, so `legacy` welcomes
 *  are byte-identical to before the switch). */
export interface WelcomeNavalRangeFields {
  navalRange?: NavalRangeMode;
}

/** Server side: stamp this process's mode onto a welcome. */
export function stampNavalRange<W extends WelcomeNavalRangeFields>(w: W, mode: NavalRangeMode = NAVAL_RANGE): W {
  return mode === 'real' ? { ...w, navalRange: mode } : w;
}

export type NavalRangeMismatch = { server: NavalRangeMode; client: NavalRangeMode; fix: string };

/** Client side: how a welcome's mode differs from this client's, or null. */
export function navalRangeMismatch(msg: WelcomeNavalRangeFields, client: NavalRangeMode = NAVAL_RANGE): NavalRangeMismatch | null {
  const server = msg.navalRange ?? DEFAULT_NAVAL_RANGE;
  if (server === client) return null;
  return { server, client, fix: `?navalRange=${server}` };
}
