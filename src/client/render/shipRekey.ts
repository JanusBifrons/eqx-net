/**
 * Moving a ship's per-key state to a new key (RTS Part A, seamless take
 * controls). A ship's mirror key changes when someone takes or lets go of its
 * controls (playerId <-> shipInstanceId). Every per-ship map the renderer (and
 * the client's prediction side) keeps is moved with `moveKey`, so the ship
 * keeps its sprite, art, turrets, health bar and effects instead of being
 * rebuilt under the new key.
 *
 * Allocation-free; runs only on a re-key (rare), never per frame. The
 * renderer-side move of a whole ship is `rekeyShipVisuals` (bottom).
 */

import type { Container } from 'pixi.js';

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

interface Rekeyable { rekey(from: string, to: string): void }

/** The renderer state a ship re-key moves (structural, so the per-ship
 *  modules that import `moveKey` from here stay import-cycle free). */
export interface ShipRekeyRefs {
  readonly sprites: Map<string, Container>;
  readonly artHandles: Map<string, unknown>;
  readonly mountVisuals: { rekeyShip(from: string, to: string): void };
  readonly healthBars: Rekeyable | null | undefined;
  readonly labels: Rekeyable | null;
  readonly farIcons: { forgetShip(from: string, sprite: Container | undefined): void };
  readonly fxEngines: Rekeyable | null;
  readonly fxShields: Rekeyable | null;
  readonly input: { _focusId: string | null; _hoveredId: string | null; readonly _selShips: Set<string>; publishFleetSelection(): void };
  readonly forgetSprite: (id: string, held: boolean) => void;
}

/**
 * RTS Part A seamless hand-over: a ship's mirror key changed (someone took
 * or let go of its controls; `ColyseusClient.rekeyShip` queued the pair on
 * `mirror.pendingShipRekeys`, which crosses the worker boundary with the
 * mirror). Every per-ship piece of renderer state MOVES to the new key, so
 * `updateShipSprites` finds the ship's sprite already built and the sweep
 * never destroys it: same sprite and art handle, same turret cluster (guns,
 * recoil, angles), health bar, label, exhaust, shield view, selection.
 * A stale sprite under `to` is torn down first, exactly as the sweep would.
 * Legacy effects (engine particles, shield ring) re-register by id on their
 * own each frame; their visuals don't depend on the key's history.
 */
export function rekeyShipVisuals(r: ShipRekeyRefs, from: string, to: string): boolean {
  if (from === to) return false;
  const sprite = r.sprites.get(from);
  if (sprite === undefined) return false;
  const stale = r.sprites.get(to);
  if (stale !== undefined) {
    r.sprites.delete(to);
    stale.parent?.removeChild(stale);
    r.forgetSprite(to, false);
    stale.destroy({ children: true });
  }
  moveKey(r.sprites, from, to);
  moveKey(r.artHandles, from, to);
  r.mountVisuals.rekeyShip(from, to);
  r.healthBars?.rekey(from, to);
  r.labels?.rekey(from, to);
  r.farIcons.forgetShip(from, sprite);
  r.fxEngines?.rekey(from, to);
  r.fxShields?.rekey(from, to);
  if (r.input._focusId === from) r.input._focusId = to;
  if (r.input._hoveredId === from) r.input._hoveredId = to;
  if (moveSetKey(r.input._selShips, from, to)) r.input.publishFleetSelection();
  return true;
}
