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
 * Pure apart from the capital R&D switch (also import-free).
 */
import { capitalWorkerNameSuffix } from '../shipKinds/capitals/capitalConfig.js';
import { solarWorkerNameSuffix } from '../sectorBounds.js';
import { navalRangeWorkerNameSuffix } from '../combat/navalRange.js';

/** The shipping ship scale (2×, picked 2026-11-05 from the comparison footage).
 *  R&D / tuning override it via the env above. Catalogue numbers are authored
 *  at 1× and scaled from there. */
export const DEFAULT_SHIP_SCALE = 2;

/**
 * Combat tuning profile (how combat distances respond to the ship scale):
 *  - `A` — the world as is: only ship-bound numbers (muzzles, pads, hit
 *    radii, pickup, flocking…) follow the ships; weapon ranges stay.
 *  - `B` — scaled combat: weapon ranges ×1.5 and splash ×2 at 2× ships
 *    (in general: range × (1 + (scale − 1) / 2), splash × scale).
 */
export type ShipTuningProfile = 'A' | 'B';
export const DEFAULT_SHIP_TUNING: ShipTuningProfile = 'B';

const SCALE_MIN = 0.25, SCALE_MAX = 16;

interface ScaleSources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_SHIP_SCALE__?: unknown; __EQX_SHIP_TUNING__?: unknown; __EQX_SHIP_KIND_SCALE__?: unknown };
  workerName?: string;
}

/** Resolve the scale + profile from the given sources (exported for tests). */
export function resolveShipScaleConfig(src: ScaleSources): { scale: number; tuning: ShipTuningProfile; kinds: string } {
  let scaleRaw: unknown = src.env?.['EQX_SHIP_SCALE'];
  let tuningRaw: unknown = src.env?.['EQX_SHIP_TUNING'];
  let kindsRaw: unknown = src.env?.['EQX_SHIP_KIND_SCALE'];
  if (kindsRaw === undefined && src.global?.__EQX_SHIP_KIND_SCALE__ !== undefined) kindsRaw = src.global.__EQX_SHIP_KIND_SCALE__;
  if (scaleRaw === undefined && src.global?.__EQX_SHIP_SCALE__ !== undefined) scaleRaw = src.global.__EQX_SHIP_SCALE__;
  if (tuningRaw === undefined && src.global?.__EQX_SHIP_TUNING__ !== undefined) tuningRaw = src.global.__EQX_SHIP_TUNING__;
  if (src.workerName) {
    const s = /shipScale=([\d.]+)/.exec(src.workerName);
    const t = /shipTuning=([AB])/.exec(src.workerName);
    if (scaleRaw === undefined && s) scaleRaw = s[1];
    if (tuningRaw === undefined && t) tuningRaw = t[1];
    const k = /kindScale=([\w:.,-]+)/.exec(src.workerName);
    if (kindsRaw === undefined && k) kindsRaw = k[1];
  }
  const n = Number(scaleRaw);
  const scale = Number.isFinite(n) && n > 0 ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) : DEFAULT_SHIP_SCALE;
  const tuning: ShipTuningProfile = tuningRaw === 'A' || tuningRaw === 'B' ? tuningRaw : DEFAULT_SHIP_TUNING;
  const kinds = typeof kindsRaw === 'string' && /^[\w:.,-]*$/.test(kindsRaw) ? kindsRaw : '';
  return { scale, tuning, kinds };
}

/** A per-kind size override (tuning / R&D): `id:scale[:class[:count:size]]`,
 *  comma-separated, e.g. `gunship:10:capital:8:30` (a 10× capital with 8
 *  thrusters of size 30). Applied by `defineShipKind` on top of the global
 *  scale. Same sources as the scale: env `EQX_SHIP_KIND_SCALE`, the page
 *  `?shipKindScale=`, the worker name. */
export interface KindScaleOverride {
  sizeScale: number;
  sizeClass?: 'fighter' | 'frigate' | 'cruiser' | 'capital';
  thrusters?: { count: number; size: number };
}

export function parseKindScaleOverrides(raw: string): Map<string, KindScaleOverride> {
  const out = new Map<string, KindScaleOverride>();
  for (const part of raw.split(',')) {
    const [id, sc, cls, count, size] = part.split(':');
    const n = Number(sc);
    if (!id || !Number.isFinite(n) || n <= 0) continue;
    const o: KindScaleOverride = { sizeScale: Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) };
    if (cls === 'fighter' || cls === 'frigate' || cls === 'cruiser' || cls === 'capital') o.sizeClass = cls;
    const c = Number(count), z = Number(size);
    if (Number.isInteger(c) && c >= 1 && Number.isFinite(z) && z > 0) o.thrusters = { count: c, size: z };
    out.set(id, o);
  }
  return out;
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
/** Per-kind size overrides this process runs with (raw string; '' ⇒ none). */
export const SHIP_KIND_SCALE: string = LIVE.kinds;
export const KIND_SCALE_OVERRIDES: ReadonlyMap<string, KindScaleOverride> = parseKindScaleOverrides(LIVE.kinds);

/** The worker `name` that carries this process's config into a worker. */
export function shipScaleWorkerName(prefix = ''): string {
  return `${prefix}${prefix ? ';' : ''}shipScale=${SHIP_SCALE};shipTuning=${SHIP_TUNING}${SHIP_KIND_SCALE ? `;kindScale=${SHIP_KIND_SCALE}` : ''}${capitalWorkerNameSuffix()}${solarWorkerNameSuffix()}${navalRangeWorkerNameSuffix()}`;
}

/** True at the AUTHORED scale (1×, profile A, no per-kind overrides): the
 *  numbers the catalogue is written in. Tests that lock authored geometry or
 *  tuning run only then (`describe.runIf(AT_AUTHORED_SHIP_SCALE)`); CI runs
 *  them with `EQX_SHIP_SCALE=1 EQX_SHIP_TUNING=A`. The ship-scale invariant
 *  sweep covers every other scale, including the shipping default. */
export const AT_AUTHORED_SHIP_SCALE = SHIP_SCALE === 1 && SHIP_TUNING === 'A' && SHIP_KIND_SCALE === '';

