/**
 * The left strip host (UI language plan A5, jobs U1-8, U3-1; selection HUD S5).
 *
 * - Command, own ships selected: the strip BECOMES the who-hex honeycomb
 *   (`WhoHexes.tsx`): one hex per ship type (type icon + "×N"); a tap keeps only
 *   that type (`keepOnlyKind` through the renderer, which owns the selection);
 *   more than 5 types puts "?" + "+N" in the last slot, which opens the Fleet
 *   orders panel with the full list. Grouping lives in `fleet/fleetView.ts`.
 * - Fly and Build: no who-hexes (the actor is implied: your own ship, or the
 *   ghost / structure the world tag names).
 * - Until the bottom-right do-hexes take them, the selection's ACTIONS stay on a
 *   slim icon strip under the honeycomb (`left-strip`): the fleet section (Order
 *   and Stance fly-outs, Stop, `fleetStripItems.tsx`), your building's Power in
 *   Build (`buildingStripItems.tsx`), the quick actions (Target / Lock, cargo /
 *   pod, Pilot, `selectionStripItems.tsx`) and, for a focus-only pick, Details
 *   (`rightPanel='details'`).
 * - The identity icons and the ⚙ / ✕ buttons are retired: the world tag names
 *   the focus; tapping empty space or Esc deselects; the rail's Fleet orders item
 *   (or "?") opens the orders panel.
 * - Tap rule T2: with my ships selected and an attackable focus that is not one
 *   of them, the quick actions carry ONE Lock: the selected ships attack it
 *   (`lockFocus` -> the renderer's `attackFocus`, the right-click order path).
 * - Doing mode: a route / target pick (`routeStripItems.tsx`, U3-3) or placing a
 *   building (`placingStripItems.tsx`, U3-7) replaces all of it until it ends.
 * - Never both sides: everything slides away while a right panel is open.
 */
import { EqxStrip, type EqxIconName } from '../../ui/index.js';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { selectControlMode, useShouldRenderHud, useUIStore } from '../state/store';
import type { RightPanel } from '../state/rightPanel';
import type { SelectionFocusKind, UISelection } from '../state/storeTypes';
import { useSelectionPanelData } from '../components/selectionPanelData';
import { fleetLockApplies, lockFocus } from '../components/targetLock';
import { getGameClient } from '../net/clientSingleton';
import { capKindGroups, groupMirrorSelection, keepOnlyKind } from '../fleet/fleetView';
import { Slot } from './Slot';
import { useFleetStripItems } from './fleetStripItems';
import { useBuildingStripItems } from './buildingStripItems';
import { useSelectionStripItems } from './selectionStripItems';
import { usePlacingStripItems } from './placingStripItems';
import { useRouteStripItems } from './routeStripItems';
import { renderStripActions, type StripAction } from './stripActions';
import { useLeftStripFit } from './leftStripFit';
import { WHO_HEX_MAX, WhoHexes } from './WhoHexes';

const FOCUS_LOOK: Readonly<Record<SelectionFocusKind, { icon: EqxIconName; tooltip: string }>> = {
  ship: { icon: 'ship', tooltip: 'Ship' },
  lingering: { icon: 'ship', tooltip: 'Parked hull' },
  drone: { icon: 'ship', tooltip: 'Drone' },
  structure: { icon: 'structure', tooltip: 'Structure' },
  asteroid: { icon: 'rock', tooltip: 'Asteroid' },
  pod: { icon: 'pod', tooltip: 'Cargo pod' },
};

export interface StripIdentity {
  icon: EqxIconName;
  tooltip: string;
  count: number;
  /** The right panel that shows the selection in full. */
  panel: Exclude<RightPanel, null>;
}

/** What is selected, or null when nothing is (pure; unit-tested; Esc reads it). */
export function stripIdentity(sel: UISelection): StripIdentity | null {
  const n = sel.ids.length;
  if (n > 0) return { icon: 'fleet', tooltip: n === 1 ? '1 ship selected' : `${n} ships selected`, count: n, panel: 'orders' };
  if (sel.focusId === null || sel.focusKind === null) return null;
  return { ...FOCUS_LOOK[sel.focusKind], count: 1, panel: 'details' };
}

interface Props {
  /** The renderer (it owns the selection): a who-hex tap re-selects there. */
  rendererRef: { readonly current: Pick<IFleetView, 'selectFleetShips' | 'attackFocus'> | null };
}

export function LeftStripHost({ rendererRef }: Props): JSX.Element | null {
  const shown = useShouldRenderHud();
  const selection = useUIStore((s) => s.selection);
  const mode = useUIStore(selectControlMode);
  const panelOpen = useUIStore((s) => s.rightPanel !== null);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const fleetItems = useFleetStripItems();
  const data = useSelectionPanelData();
  const buildingItems = useBuildingStripItems(data);
  const fleetLock = fleetLockApplies(selection)
    ? (): void => { lockFocus(useUIStore.getState().selection, rendererRef.current, () => false); }
    : null;
  const { items: quickItems, loot } = useSelectionStripItems(data, fleetLock);
  const placingItems = usePlacingStripItems();
  const routeItems = useRouteStripItems();
  const id = stripIdentity(selection);
  const placing = placingItems.length > 0;
  useLeftStripFit(shown && (placing || routeItems !== null || id !== null));
  if (!shown) return null;
  if (placing || routeItems !== null) {
    // Doing mode: placing a building (U3-7) or a route / target pick (U3-3) replaces
    // the selection strip until it ends.
    return (
      <Slot anchor="left-strip">
        <EqxStrip
          aria-label={placing ? "Placing" : "Picking on the map"}
          open={!panelOpen}
          data-testid="left-strip"
        >
          {renderStripActions(placing ? placingItems : routeItems ?? [])}
        </EqxStrip>
      </Slot>
    );
  }
  if (id === null) return null;
  // Who hexes: Command only, own ships selected (mirror read on render, not per frame).
  const groups = mode === 'command' && selection.ids.length > 0
    ? capKindGroups(groupMirrorSelection(getGameClient()?.mirror, selection.ids), WHO_HEX_MAX)
    : null;
  // A focus-only pick keeps one way to its readout until the do-hexes' More lands.
  const details: StripAction[] = selection.ids.length === 0
    ? [{ kind: 'button', key: 'details', testId: 'left-strip-details', icon: 'details',
        tooltip: data !== null && data.name !== '' ? `${data.name}: details` : 'Details',
        onPress: () => setRightPanel('details') }]
    : [];
  const actions = [...fleetItems, ...buildingItems, ...quickItems, ...details];
  return (
    <Slot anchor="left-strip">
      {groups !== null && (
        <WhoHexes shown={groups.shown} overflowKinds={groups.overflowKinds} overflowCount={groups.overflowCount}
          total={selection.ids.length} focusId={selection.focusId} open={!panelOpen}
          onKeep={(g) => { if (rendererRef.current) keepOnlyKind(rendererRef.current, g); }}
          onMore={() => setRightPanel('orders')} />
      )}
      {actions.length > 0 && (
        <EqxStrip aria-label="Selection actions" open={!panelOpen} data-testid="left-strip">
          {renderStripActions(actions)}
        </EqxStrip>
      )}
      {loot}
    </Slot>
  );
}
