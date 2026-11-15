/**
 * Moving a ship's per-key state to a new key (RTS Part A, seamless take
 * controls). A ship's mirror key changes when someone takes or lets go of its
 * controls (playerId <-> shipInstanceId). Every per-ship map the renderer (and
 * the client's prediction side) keeps is moved with `moveKey`, so the ship
 * keeps its sprite, art, turrets, health bar and effects instead of being
 * rebuilt under the new key.
 *
 * Pure and allocation-free; runs only on a re-key (rare), never per frame.
 */

/**
 * Move `map`'s entry from `from` to `to`. Returns the value that was at `to`
 * (a stale entry the caller disposes), or undefined. When `from` has no entry
 * nothing changes and undefined is returned (whatever is at `to` stays: it is
 * reused for the ship under its new key, exactly as before a re-key existed).
 */
export function moveKey<K, V>(map: Map<K, V>, from: K, to: K): V | undefined {
  if (from === to || !map.has(from)) return undefined;
  const displaced = map.get(to);
  map.set(to, map.get(from) as V);
  map.delete(from);
  return displaced;
}

/** `moveKey` for a set: true when `from` was a member (now `to` is). */
export function moveSetKey<K>(set: Set<K>, from: K, to: K): boolean {
  if (from === to || !set.delete(from)) return false;
  set.add(to);
  return true;
}

const _probeIds = new WeakMap<object, number>();
let _probeNext = 1;

/** A stable small number per object (test / DEV identity probes only). */
export function probeIdentity(o: object): number {
  let id = _probeIds.get(o);
  if (id === undefined) { id = _probeNext++; _probeIds.set(o, id); }
  return id;
}

/** Visit each `[from, to]` pair of a flat re-key list (`RenderMirror.pendingShipRekeys`). */
export function forEachShipRekey(pairs: readonly string[] | undefined, fn: (from: string, to: string) => void): void {
  if (pairs === undefined) return;
  for (let i = 0; i + 1 < pairs.length; i += 2) fn(pairs[i]!, pairs[i + 1]!);
}
