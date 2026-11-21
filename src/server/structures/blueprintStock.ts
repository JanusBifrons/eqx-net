/**
 * Building panels B7 — which of a processor's recipes have a blueprint in its
 * network storage (the row's `bpAvail`). A Shipyard queue swaps a blueprint in
 * from that same storage (`swapBlueprintFor` -> `StorageService.loadBlueprint`,
 * the same network: same-owner operational storage in the grid component), so
 * a hull whose blueprint is there is buildable.
 *
 * Run by `ProductionSubsystem.pulse` (1 Hz) on the network it already collects,
 * only for kinds with a blueprint recipe. Cost: one product lookup per
 * blueprint held in that network; allocates nothing (#14).
 */
import { blueprintRecipeBits, kindNeedsBlueprints } from '../../shared-types/production.js';
import { isBlueprintUsedUp } from '../../shared-types/blueprints.js';
import type { ProcessorKindId } from '../../shared-types/recipes.js';
import type { StructureRecord } from './StructureRegistry.js';

/** True for a processor kind that carries `bpAvail` (cached per kind). */
const NEEDS = new Map<string, boolean>();
export function tracksBlueprintStock(kind: string): boolean {
  let v = NEEDS.get(kind);
  if (v === undefined) {
    v = kindNeedsBlueprints(kind as ProcessorKindId);
    NEEDS.set(kind, v);
  }
  return v;
}

/** The `bpAvail` mask for a processor of `kind` over its storage network. */
export function blueprintStockMask(kind: ProcessorKindId, net: readonly StructureRecord[]): number {
  let m = 0;
  for (let s = 0; s < net.length; s++) {
    const bps = net[s]!.hold?.blueprints;
    if (bps === undefined) continue;
    for (let i = 0; i < bps.length; i++) {
      const bp = bps[i]!;
      if (!isBlueprintUsedUp(bp)) m |= blueprintRecipeBits(kind, bp.product);
    }
  }
  return m >>> 0;
}
