/**
 * Build a catalogue ship kind: validate, then scale it by the global ship
 * scale × its own `sizeScale` (engineering test hulls stay 1×). Every family
 * file defines its kinds through this, so every consumer of the catalogue
 * sees scaled ships and the 1× authoring values live only in the source.
 *
 * `unscaledShipKind(id)` returns the authored 1× kind (tests sweep scales
 * from it with `scaleShipKind`).
 */
import { ShipKindSchema, type ShipKind } from '../shipKinds/types.js';
import { effectiveScale, scaleShipKind } from './tuning.js';

const UNSCALED = new Map<string, ShipKind>();

export function defineShipKind(raw: unknown): ShipKind {
  const kind = ShipKindSchema.parse(raw);
  UNSCALED.set(kind.id, kind);
  return scaleShipKind(kind, effectiveScale(kind));
}

/** The authored (1×) kind, before the catalogue scaled it. */
export function unscaledShipKind(id: string): ShipKind | undefined {
  return UNSCALED.get(id);
}

/** Every authored kind, in definition order. */
export function unscaledShipKinds(): ShipKind[] {
  return [...UNSCALED.values()];
}
