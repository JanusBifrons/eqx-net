/**
 * Selection HUD S9 (pure, alloc-free): while the world tag is stuck to the
 * screen edge pointing at the focus (`RenderMirror.worldTagEdgeId`), the halo
 * radar skips that entity's own edge icon so ONE arrow points at it.
 * Selection ids are a `mirror.ships` key or `swarm-<id>` (`resolveSelectable`).
 */

/** The swarm entity id a selection id names, or -1 (not a swarm id / none). */
export function tagSkipSwarmId(selId: string | null | undefined): number {
  if (selId === null || selId === undefined || selId.length <= 6 || !selId.startsWith('swarm-')) return -1;
  let n = 0;
  for (let i = 6; i < selId.length; i++) {
    const c = selId.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return -1;
    n = n * 10 + c;
  }
  return n;
}
