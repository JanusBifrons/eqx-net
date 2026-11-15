/**
 * Mining-barge look R&D switch (plan partitioned-chasing-lark, PR 14): which
 * of the three `bargeDesign` looks to show in the game, if any. Read once at
 * module load from the same sources as the capital R&D arms
 * (`capitalConfig.ts`), so server, page and workers agree (invariant 15):
 *  - Node: env `EQX_BARGE_LOOK` (A|B|C);
 *  - page: `globalThis.__EQX_BARGE_LOOK__`, set by `index.html` from `?bargeLook=`;
 *  - workers: the worker `name` (`bargeLook=B`).
 * Unset (the default) ⇒ null, and the catalogue is byte-identical to before.
 * Set ⇒ the chosen look is appended to the END of the catalogue as kind
 * `barge-look` (npcOnly, never in a random spawn pool), so the ordinary kind
 * path (collider, turrets, forge art, engine FX, wire) draws it. Set it on
 * BOTH the server and the page. Goes away once the owner picks (PR 15 appends
 * the real kind). The kind itself is built in `capitals/index.ts`; this file
 * stays import-free at runtime (the ship-scale config reads the worker suffix).
 */
/** A barge look option (`bargeDesign.ts`). */
export type BargeLook = 'A' | 'B' | 'C';

interface Sources {
  env?: Record<string, string | undefined>;
  global?: { __EQX_BARGE_LOOK__?: unknown };
  workerName?: string;
}

export function resolveBargeLook(src: Sources): BargeLook | null {
  let v: unknown = src.env?.['EQX_BARGE_LOOK'] ?? src.global?.__EQX_BARGE_LOOK__;
  if (src.workerName) v ??= /bargeLook=([ABC])/.exec(src.workerName)?.[1];
  return v === 'A' || v === 'B' || v === 'C' ? v : null;
}

const g = globalThis as unknown as {
  process?: { env?: Record<string, string | undefined> };
  __EQX_BARGE_LOOK__?: unknown; name?: unknown; WorkerGlobalScope?: unknown;
};
export const BARGE_LOOK: BargeLook | null = resolveBargeLook({
  env: g.process?.env,
  global: g,
  workerName: typeof g.WorkerGlobalScope !== 'undefined' && typeof g.name === 'string' ? g.name : undefined,
});

/** Appended to a worker's name so workers build the same catalogue. */
export function bargeLookWorkerNameSuffix(): string {
  return BARGE_LOOK ? `;bargeLook=${BARGE_LOOK}` : '';
}
