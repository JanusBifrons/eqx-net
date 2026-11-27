/**
 * Selection HUD S7: which world tag shows, and the group tag's lines.
 * Pure (no React, no mirror): `WorldTagHost` feeds it the fleet selection
 * read model (`useFleetSelectionView`) at the panel poll rate.
 *  - `single`: the focus's own tag (S6b), over its bracket.
 *  - `group`: 2+ own ships selected and the focus is one of them or none:
 *    ONE tag over the selection centroid (no per-ship tag).
 *  - `target`: own ships selected and the focus is something else (an enemy
 *    you tapped): the focus's tag, and `FleetOverlay` joins the selection
 *    centroid to it with a dashed preview line (`render/selectionTargetLine.ts`).
 */
import type { FleetMode, FleetStance } from '@shared-types/messages/fleetStatusMessages';
import { STANCE_COLOUR } from '../components/contactRows.js';
import { MODE_LABELS, STANCE_LABELS } from '../fleet/fleetView.js';
import type { WorldTagText } from './worldTag.js';

export type WorldTagMode = 'none' | 'single' | 'group' | 'target';

/** Pure: the tag mode from the selected own ships and the focus. */
export function worldTagMode(selIds: readonly string[], focusId: string | null): WorldTagMode {
  const focusInSel = focusId !== null && selIds.includes(focusId);
  if (selIds.length >= 2 && (focusId === null || focusInSel)) return 'group';
  if (focusId === null) return 'none';
  if (selIds.length > 0 && !focusInSel) return 'target';
  return 'single';
}

/** One selected ship as the group tag reads it. */
export interface GroupTagShip {
  /** Hull type ("Fighter", `fleetShipName`). */
  name: string;
  hullPct: number | null;
}

/** "Fighter" → "Fighters" (a type name ending in s takes "es"). */
function plural(name: string, n: number): string {
  if (n === 1) return name;
  return name.endsWith('s') ? `${name}es` : `${name}s`;
}

/**
 * Pure: line 1 "5 ships · 2 Battleships · 3 Fighters" (types in the order
 * they first appear in the selection).
 * TODO(selection-hud): switch the count to `groupSelectionByKind`
 * (`fleet/fleetView.ts`, PR #1354) once it lands.
 */
export function groupTagTitle(ships: readonly GroupTagShip[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const s of ships) {
    const c = counts.get(s.name);
    if (c === undefined) order.push(s.name);
    counts.set(s.name, (c ?? 0) + 1);
  }
  let out = `${ships.length} ${ships.length === 1 ? 'ship' : 'ships'}`;
  for (const name of order) {
    const n = counts.get(name)!;
    out += ` · ${n} ${plural(name, n)}`;
  }
  return out;
}

/** Pure: the whole group tag. Line 2 "Yours · <order> · <stance>" (each only
 *  when every ship shares it) in the own colour; the bar is the average hull. */
export function groupTagText(
  ships: readonly GroupTagShip[],
  mode: FleetMode | 'mixed' | null,
  stance: FleetStance | 'mixed' | null,
): WorldTagText {
  let owner = 'Yours';
  if (mode !== null && mode !== 'mixed') owner += ` · ${MODE_LABELS[mode]}`;
  if (stance !== null && stance !== 'mixed') owner += ` · ${STANCE_LABELS[stance]}`;
  const out: WorldTagText = { title: groupTagTitle(ships), owner, ownerColor: STANCE_COLOUR.friendly };
  let sum = 0;
  let n = 0;
  for (const s of ships) {
    if (s.hullPct === null) continue;
    sum += s.hullPct;
    n++;
  }
  if (n > 0) out.hullPct = sum / n;
  return out;
}
