/**
 * Capital-ship R&D arms (plan eager-sauteeing-curry): which design style and
 * which size mapping the five capital kinds are built with. Read once at
 * module load from the same sources as the ship scale (`shipScale/config.ts`),
 * so server, page and workers build identical hulls (invariant 15):
 *  - Node: env `EQX_CAPITAL_STYLE` (A|B|C) / `EQX_CAPITAL_MAP` (A|B);
 *  - page: `globalThis.__EQX_CAPITAL_STYLE__` / `__EQX_CAPITAL_MAP__`, set by
 *    `index.html` from `?capStyle=` / `?capMap=`;
 *  - workers: the worker `name` (`capStyle=B;capMap=A`).
 * Defaults: style A, mapping C (10×, round 3). After the pick the chosen arm becomes the
 * fixed design and this switch goes away.
 * Pure: no imports.
 */

export type CapitalStyle = 'A' | 'B' | 'C';
export type CapitalMap = 'A' | 'B' | 'C';

export const DEFAULT_CAPITAL_STYLE: CapitalStyle = 'A';
export const DEFAULT_CAPITAL_MAP: CapitalMap = 'C';

interface Sources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_CAPITAL_STYLE__?: unknown; __EQX_CAPITAL_MAP__?: unknown };
  workerName?: string;
}

export function resolveCapitalConfig(src: Sources): { style: CapitalStyle; map: CapitalMap } {
  let s: unknown = src.env?.['EQX_CAPITAL_STYLE'] ?? src.global?.__EQX_CAPITAL_STYLE__;
  let m: unknown = src.env?.['EQX_CAPITAL_MAP'] ?? src.global?.__EQX_CAPITAL_MAP__;
  if (src.workerName) {
    s ??= /capStyle=([ABC])/.exec(src.workerName)?.[1];
    m ??= /capMap=([ABC])/.exec(src.workerName)?.[1];
  }
  return {
    style: s === 'A' || s === 'B' || s === 'C' ? s : DEFAULT_CAPITAL_STYLE,
    map: m === 'A' || m === 'B' || m === 'C' ? m : DEFAULT_CAPITAL_MAP,
  };
}

const g = globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
  __EQX_CAPITAL_STYLE__?: unknown; __EQX_CAPITAL_MAP__?: unknown;
  name?: unknown; WorkerGlobalScope?: unknown;
};
const LIVE = resolveCapitalConfig({
  env: g.process?.env,
  global: g,
  workerName: typeof g.WorkerGlobalScope !== 'undefined' && typeof g.name === 'string' ? g.name : undefined,
});

export const CAPITAL_STYLE: CapitalStyle = LIVE.style;
export const CAPITAL_MAP: CapitalMap = LIVE.map;

/** Appended to a worker's name so workers build the same capitals. */
export function capitalWorkerNameSuffix(): string {
  return `;capStyle=${CAPITAL_STYLE};capMap=${CAPITAL_MAP}`;
}
