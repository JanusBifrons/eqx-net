/**
 * Plan: crispy-kazoo, Commit 6 — reflection-based mirror clear (moved out of
 * ColyseusClient, a god-file split).
 *
 * Walks every property on `mirror` and clears Maps / Sets / Arrays
 * generically. The plan's prophylactic against future mirror additions:
 * adding a new field to `RenderMirror` does NOT require touching dispose —
 * the walk picks it up automatically. The disposeAudit test populates every
 * field with a sentinel value and asserts they're empty post-dispose.
 */
export function clearMirror(mirror: object): void {
  const m = mirror as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    const v = m[k];
    if (v instanceof Map) v.clear();
    else if (v instanceof Set) v.clear();
    else if (Array.isArray(v)) v.length = 0;
  }
}
