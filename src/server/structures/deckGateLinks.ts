/**
 * Base platforms slice 21 — a fence gate placed on a deck seam replaces the
 * seam's post-to-post link (and so its wall): the gate's own two seam links
 * (`DECK_LINK_SEAM_GATE`, made by `autoConnectStructure` straight after) carry
 * the fence line through the gate. The rule itself is core
 * (`deckGateCutsFenceLink`); this applies it to the registry.
 */
import { DECK_FENCE_GATE_KIND, deckGateCutsFenceLink } from '../../core/structures/deckLinks.js';
import type { Connection } from '../../core/structures/Connection.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

/** Cut every link `gate` replaces (none unless it is a deck fence gate on a
 *  seam with a linked post pair). Caller gates on the room's deck flag. */
export function cutLinksReplacedByDeckGate(registry: StructureRegistry, gate: StructureRecord): void {
  if (gate.kind !== DECK_FENCE_GATE_KIND) return;
  let cut: Connection[] | null = null;
  for (const c of registry.allConnections()) {
    const a = registry.get(c.aId), b = registry.get(c.bId);
    if (a === undefined || b === undefined || !deckGateCutsFenceLink(gate, a, b)) continue;
    (cut ??= []).push(c);
  }
  if (cut !== null) for (const c of cut) registry.removeConnection(c);
}
