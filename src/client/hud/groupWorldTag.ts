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
import { MODE_LABELS, STANCE_LABELS, type KindGroup } from '../fleet/fleetView.js';
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

/** One selected ship as the group tag's hull bar reads it. */
export interface GroupTagShip {
  hullPct: number | null;
}

/** One kind group as line 1 reads it (a `KindGroup` from `fleet/fleetView.ts`). */
export type GroupTagKind = Pick<KindGroup, 'displayName' | 'count'>;

/** "Fighter" → "Fighters" (a type name ending in s takes "es"). */
function plural(name: string, n: number): string {
  if (n === 1) return name;
  return name.endsWith('s') ? `${name}es` : `${name}s`;
}

/** "5 ships" / "1 ship": the title's lead and the compact tag's line (S10). */
function groupTagCount(n: number): string {
  return `${n} ${n === 1 ? 'ship' : 'ships'}`;
}

/**
 * Pure: line 1 "5 ships · 2 Battleships · 3 Fighters" from the selection's
 * kind groups: `groupMirrorSelection` / `groupSelectionByKind`
 * (`fleet/fleetView.ts`), the grouping the who-hexes show, so the tag and the
 * hexes never disagree (types in the hexes' order).
 */
export function groupTagTitle(groups: readonly GroupTagKind[]): string {
  let total = 0;
  for (const g of groups) total += g.count;
  let out = groupTagCount(total);
  for (const g of groups) out += ` · ${g.count} ${plural(g.displayName, g.count)}`;
  return out;
}

/** Pure: the whole group tag. Line 2 "Yours · <order> · <stance>" (each only
 *  when every ship shares it) in the own colour; the bar is the average hull. */
export function groupTagText(
  ships: readonly GroupTagShip[],
  groups: readonly GroupTagKind[],
  mode: FleetMode | 'mixed' | null,
  stance: FleetStance | 'mixed' | null,
): WorldTagText {
  let owner = 'Yours';
  if (mode !== null && mode !== 'mixed') owner += ` · ${MODE_LABELS[mode]}`;
  if (stance !== null && stance !== 'mixed') owner += ` · ${STANCE_LABELS[stance]}`;
  const out: WorldTagText = {
    title: groupTagTitle(groups), compactTitle: groupTagCount(ships.length), owner, ownerColor: STANCE_COLOUR.friendly,
  };
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
