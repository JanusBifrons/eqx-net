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
    else if (Array.isArray(v)) {
      // A frozen shared constant (e.g. `EMPTY_AIM_IDS` on `localAimMountIds`)
      // can't be truncated: `length = 0` throws in strict mode and aborts the
      // rest of dispose. Swap a non-empty one for a fresh array; leave an
      // empty one (already clear). Dispose-only path, not per frame.
      if (!Object.isFrozen(v)) v.length = 0;
      else if (v.length > 0) m[k] = [];
    }
  }
}
