/**
 * Contacts → selection (UI plan D10 T5). A contact row carries its LOCK key
 * (`s:<entityId>` for a swarm entity, `p:<ship mirror key>` for a ship); a tap
 * on the row SELECTS that entity (owner: "it's never tap to lock"), so the key
 * maps to the id + kind the renderer's map pick (`pickEntityAt`) produces:
 *   - `s:<n>` → `swarm-<n>`, kind 'structure' for a structure row, else 'drone'
 *   - `p:<key>` → `<key>`, kind 'lingering' for a parked hull, else 'ship'
 * Pure: reads only the mirror it is handed.
 */
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { PickedEntity } from '../render/pickEntity';
import { isParkedHull } from '../render/shipOwnership';
import type { ContactType } from './contactRows';

/** The renderer focus for a contact row, or null for an unknown key form. */
export function contactFocusTarget(key: string, type: ContactType, mirror: RenderMirror): PickedEntity | null {
  if (key.startsWith('s:')) {
    const n = key.slice(2);
    if (n === '') return null;
    return { id: `swarm-${n}`, kind: type === 'structure' ? 'structure' : 'drone' };
  }
  if (key.startsWith('p:')) {
    const id = key.slice(2);
    if (id === '') return null;
    const entry = mirror.ships.get(id);
    return { id, kind: entry !== undefined && isParkedHull(mirror, id, entry) ? 'lingering' : 'ship' };
  }
  return null;
}
