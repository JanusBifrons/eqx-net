/**
 * The sandbox starter plate (docs/features/sandbox.md, `sandboxFleet.ts`): a
 * deck room places nothing off the player's own deck, and a new plate must
 * border one they have, so a player with no plate could build nothing. This
 * lays them one, BUILT: a Connector on the plate centre (the anchor) and a
 * Capital in its lower-right outer hex, the `?room=deck` layout. Placed
 * through the one `structurePlacement.place` seam as a system placement (no
 * deck rule), then finished as `seedStructureScenario` does.
 *
 * Skipped when the player already anchors a plate in the room (re-join).
 * Join-time only.
 */
import { isPlateAnchor } from '../../core/hex/plateSet.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import type { StructureScenarioHost } from './scenarioLayouts.js';
import { STARTER_CAPITAL_OFFSET } from './sandboxFleet.js';

export type StarterPlateHost = Pick<StructureScenarioHost, 'structureRegistry' | 'structurePlacement' | 'swarmHealth' | 'logger'>;

/** Lay `playerId` a built starter plate centred at (x, y); returns how many
 *  structures were placed (0 when they already anchor a plate). */
export function seedStarterPlate(h: StarterPlateHost, playerId: string, x: number, y: number): number {
  const reg = h.structureRegistry;
  for (const rec of reg.all()) {
    if (rec.owner === playerId && isPlateAnchor(rec.kind, rec.x, rec.y)) return 0;
  }
  let made = 0;
  // Anchor first: the Capital stands on the plate it lays.
  const parts = [
    { kind: 'connector', x, y, rot: 0 },
    { kind: 'capital', x: x + STARTER_CAPITAL_OFFSET.x, y: y + STARTER_CAPITAL_OFFSET.y, rot: 90 },
  ];
  for (const p of parts) {
    const id = h.structurePlacement().place(playerId, p.kind, p.x, p.y, { rot: p.rot });
    if (id === null) {
      h.logger.warn({ kind: p.kind, x: p.x, y: p.y }, 'sandbox starter plate structure rejected');
      continue;
    }
    const rec = reg.get(id);
    if (rec && !rec.isConstructed) {
      rec.isConstructed = true;
      rec.constructionProgress = rec.constructionCost;
      h.swarmHealth().set(id, getStructureKind(rec.kind).maxHealth);
    }
    made++;
  }
  if (made > 0) { reg.topologyDirty = true; reg.syncPlateOwners(); }
  return made;
}
