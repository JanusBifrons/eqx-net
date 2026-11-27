/**
 * The left strip's fleet section (UI language plan A5 / U3-4): while own ships
 * are selected in Command, the strip shows Order and Stance as
 * EqxStatusFlyouts plus a quick Stop (the approved mock: speed lives in the
 * ⚙ Fleet panel, not on the strip). Icons only, tooltips name them.
 *
 * - One pick = one order, through the SAME path the fleet panel uses
 *   (`fleet/fleetCommands.ts` via `resolveFleetCommands`): Defend / Hunt send
 *   `setMode` at once; Patrol / Escort / Retreat start the map pick
 *   (`setFleetPick`), exactly like the panel's buttons; Stance → `setStance`;
 *   Stop → `stop`; Move (tap rule T3) arms a one-point `move` map pick:
 *   the next map tap sends a move order there (the right-click path).
 * - The shown value comes from the selection's fleet status
 *   (`useFleetSelectionView`, the panel's source); a mixed or unreported
 *   selection shows the neutral `mixed` icon.
 * - Returned as data (`StripAction`, `stripActions.tsx`); the strip draws it
 *   with `renderStripActions`.
 */
import {
  FLEET_STATUS_MODES, FLEET_STATUS_STANCES, type FleetMode, type FleetStance,
} from '@shared-types/messages/fleetStatusMessages';
import { EqxIcon, type EqxIconName, type EqxStatusOption } from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { helmOrdersAllowed } from '../helm/helmModeGate.js';
import { MODE_LABELS, STANCE_LABELS } from '../fleet/fleetView.js';
import { modeNeedsPick } from '../fleet/fleetPickView.js';
import { resolveFleetCommands, useFleetSelectionView } from '../fleet/useFleetSelectionView.js';
import { MOVE_ORDER_COLOUR_HEX } from '../render/orderMarkerColours.js';
import type { StripAction } from './stripActions.js';

const MODE_ICON: Readonly<Record<FleetMode, EqxIconName>> = {
  patrol: 'patrol', defend: 'defend', hunt: 'hunt', escort: 'escort', retreat: 'retreat',
};
const STANCE_ICON: Readonly<Record<FleetStance, EqxIconName>> = {
  aggressive: 'aggressive', defensive: 'defensive', holdFire: 'holdFire',
};

const MODE_OPTIONS: readonly EqxStatusOption<FleetMode>[] = FLEET_STATUS_MODES.map((m) => ({
  id: m, icon: <EqxIcon name={MODE_ICON[m]} />, tooltip: MODE_LABELS[m],
}));
const STANCE_OPTIONS: readonly EqxStatusOption<FleetStance>[] = FLEET_STATUS_STANCES.map((s) => ({
  id: s, icon: <EqxIcon name={STANCE_ICON[s]} />, tooltip: STANCE_LABELS[s],
  ...(s === 'aggressive' ? { tone: 'danger' as const } : {}),
}));

const MIXED = <EqxIcon name="mixed" />;

/** A single shared value, or null for mixed / not yet reported. */
function known<T extends string>(v: T | 'mixed' | null): T | null {
  return v === null || v === 'mixed' ? null : v;
}

/** The fleet section's strip items, or [] when it does not apply (not Command, no own ships). */
export function useFleetStripItems(): StripAction[] {
  const view = useFleetSelectionView();
  const command = useUIStore(helmOrdersAllowed);
  const setPick = useUIStore((s) => s.setFleetPick);
  const moveArmed = useUIStore((s) => s.fleetPick?.kind === 'move');
  if (!view.active || !command) return [];
  const { ids } = view;
  const mode = known(view.mode);
  const stance = known(view.stance);

  const onMode = (m: FleetMode): void => {
    if (modeNeedsPick(m)) setPick(m);
    else resolveFleetCommands().setMode(ids, m);
  };
  const onStance = (s: FleetStance): void => resolveFleetCommands().setStance(ids, s);
  const onStop = (): void => resolveFleetCommands().stop(ids);
  // A second tap disarms: the pressed state is the player's only cue a pick is waiting.
  const onMove = (): void => setPick(moveArmed ? null : 'move');

  return [
    { kind: 'flyout', key: 'order', value: mode, emptyIcon: MIXED, options: MODE_OPTIONS, onPick: onMode,
      tooltip: `Order: ${mode === null ? 'mixed' : MODE_LABELS[mode]}`, testId: 'left-strip-order' },
    { kind: 'button', key: 'move', icon: 'move', tooltip: 'Move: tap a point',
      accent: MOVE_ORDER_COLOUR_HEX, active: moveArmed, onPress: onMove, testId: 'left-strip-move' },
    { kind: 'flyout', key: 'stance', value: stance, emptyIcon: MIXED, options: STANCE_OPTIONS, onPick: onStance,
      tooltip: `Stance: ${stance === null ? 'mixed' : STANCE_LABELS[stance]}`, testId: 'left-strip-stance' },
    { kind: 'button', key: 'stop', icon: 'stop', tooltip: 'Stop', onPress: onStop, testId: 'left-strip-stop' },
  ];
}
