/**
 * Ship scale configuration — read ONCE at module load, the same way in every
 * context, so every catalogue consumer (server, client main thread, render
 * worker, bake workers) builds the same scaled ships (invariant #15).
 *
 *  - Node (server, tests): env `EQX_SHIP_SCALE` / `EQX_SHIP_TUNING`.
 *  - Browser main thread: `globalThis.__EQX_SHIP_SCALE__` / `__EQX_SHIP_TUNING__`,
 *    set by the inline script in `index.html` from `?shipScale=` /
 *    `?shipTuning=` BEFORE the module graph runs.
 *  - Workers: the worker's `name` (`shipScale=2;shipTuning=B`), which the
 *    main thread sets when it creates the worker and which is readable at
 *    module load.
 *
 * Unset ⇒ the production defaults below. The server sends its scale in the
 * join welcome and the client checks it (a mismatch would desync physics).
 * Pure: no imports.
 */

/** The shipping ship scale. R&D / tuning override it via the env above. */
export const DEFAULT_SHIP_SCALE = 1;

/**
 * Combat tuning profile (how combat distances respond to the ship scale):
 *  - `A` — the world as is: only ship-bound numbers (muzzles, pads, hit
 *    radii, pickup, flocking…) follow the ships; weapon ranges stay.
 *  - `B` — scaled combat: weapon ranges ×1.5 and splash ×2 at 2× ships
 *    (in general: range × (1 + (scale − 1) / 2), splash × scale).
 */
export type ShipTuningProfile = 'A' | 'B';
export const DEFAULT_SHIP_TUNING: ShipTuningProfile = 'A';

const SCALE_MIN = 0.25, SCALE_MAX = 16;

interface ScaleSources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_SHIP_SCALE__?: unknown; __EQX_SHIP_TUNING__?: unknown };
  workerName?: string;
}

/** Resolve the scale + profile from the given sources (exported for tests). */
export function resolveShipScaleConfig(src: ScaleSources): { scale: number; tuning: ShipTuningProfile } {
  let scaleRaw: unknown = src.env?.['EQX_SHIP_SCALE'];
  let tuningRaw: unknown = src.env?.['EQX_SHIP_TUNING'];
  if (scaleRaw === undefined && src.global?.__EQX_SHIP_SCALE__ !== undefined) scaleRaw = src.global.__EQX_SHIP_SCALE__;
  if (tuningRaw === undefined && src.global?.__EQX_SHIP_TUNING__ !== undefined) tuningRaw = src.global.__EQX_SHIP_TUNING__;
  if (src.workerName) {
    const s = /shipScale=([\d.]+)/.exec(src.workerName);
    const t = /shipTuning=([AB])/.exec(src.workerName);
    if (scaleRaw === undefined && s) scaleRaw = s[1];
    if (tuningRaw === undefined && t) tuningRaw = t[1];
  }
  const n = Number(scaleRaw);
  const scale = Number.isFinite(n) && n > 0 ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) : DEFAULT_SHIP_SCALE;
  const tuning: ShipTuningProfile = tuningRaw === 'A' || tuningRaw === 'B' ? tuningRaw : DEFAULT_SHIP_TUNING;
  return { scale, tuning };
}

function liveSources(): ScaleSources {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
    __EQX_SHIP_SCALE__?: unknown; __EQX_SHIP_TUNING__?: unknown;
    name?: unknown; WorkerGlobalScope?: unknown;
  };
  return {
    env: g.process?.env,
    global: g,
    workerName: typeof g.WorkerGlobalScope !== 'undefined' && typeof g.name === 'string' ? g.name : undefined,
  };
}

const LIVE = resolveShipScaleConfig(liveSources());

/** The ship scale this process runs at. */
export const SHIP_SCALE: number = LIVE.scale;
/** The combat tuning profile this process runs at. */
export const SHIP_TUNING: ShipTuningProfile = LIVE.tuning;

/** The worker `name` that carries this process's config into a worker. */
export function shipScaleWorkerName(prefix = ''): string {
  return `${prefix}${prefix ? ';' : ''}shipScale=${SHIP_SCALE};shipTuning=${SHIP_TUNING}`;
}
