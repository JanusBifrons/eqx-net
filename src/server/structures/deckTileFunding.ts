/**
 * Base platforms slice 34 — a flat deck tile (a road) takes no cable (owner:
 * "Roads take no cable at all. A road belongs to a base because it sits on
 * that base's deck"). Its build and repair still draw minerals from the
 * owner's Capital, along the grid route to the ANCHOR of the plate it sits on
 * (the plate set already says whose deck that is; no second ownership system).
 * `StructureGridSubsystem.findStorageRoute` / `buildStallReason` route to
 * {@link deckTileFundingTarget} instead of the tile itself. No anchor of the
 * owner's on that plate ⇒ the tile's own id (no route: paused, "not connected").
 * Allocation-free; runs on the 1 Hz pulse.
 */
import { isFlatDeckKind } from '../../shared-types/structureKinds.js';
import { pixelToAxialInto, type AxialHex } from '../../core/hex/hex.js';
import { DECK_HEX_SIZE, plateOfHexInto, type PlateIndex } from '../../core/hex/plates.js';
import { isPlateAnchor } from '../../core/hex/plateSet.js';
import type { StructureRecord } from './StructureRegistry.js';

const HEX: AxialHex = { q: 0, r: 0 };
const TILE: PlateIndex = { i: 0, j: 0 };
const OTHER: PlateIndex = { i: 0, j: 0 };

function plateOfWorldInto(x: number, y: number, out: PlateIndex): PlateIndex {
  pixelToAxialInto(x, y, DECK_HEX_SIZE, HEX);
  return plateOfHexInto(HEX.q, HEX.r, out);
}

/** Where a build or repair of structure `id` is funded to: for a flat deck
 *  tile, the id of its owner's anchor on the plate it sits on; else `id`. */
export function deckTileFundingTarget(
  registry: { get(id: string): StructureRecord | undefined; all(): Iterable<StructureRecord> },
  id: string,
): string {
  const rec = registry.get(id);
  if (rec === undefined || !isFlatDeckKind(rec.kind)) return id;
  plateOfWorldInto(rec.x, rec.y, TILE);
  for (const o of registry.all()) {
    if (o.owner !== rec.owner || !isPlateAnchor(o.kind, o.x, o.y)) continue;
    plateOfWorldInto(o.x, o.y, OTHER);
    if (OTHER.i === TILE.i && OTHER.j === TILE.j) return o.id;
  }
  return id;
}
