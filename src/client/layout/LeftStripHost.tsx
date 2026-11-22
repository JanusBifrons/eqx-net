/**
 * The left strip host (UI language plan A5, jobs U1-8, U3-1).
 *
 * - Draws the active strip in `<Slot anchor="left-strip">`. For now that is the
 *   selection strip: identity (icon + count); for own ships in Command the fleet
 *   section (Order and Stance fly-outs and Stop, `fleetStripItems.tsx`); for
 *   your own building in Build its Power fly-out (`buildingStripItems.tsx`);
 *   the selection's quick actions (Target, cargo / pod, Pilot,
 *   `selectionStripItems.tsx`); then ⚙ and ✕. Doing-mode strips come with U3-7.
 * - Tap rule T2: with my ships selected and a focus that is not one of them
 *   (not mine, `focusSurvives`), a separator and the FOCUS identity follow the
 *   fleet section (`stripFocusIdentity`), and its hull ring moves there (the
 *   fleet identity rings ok). An attackable focus gets ONE Lock in Target's
 *   place: the selected ships attack it (`lockFocus` -> the renderer's
 *   `attackFocus`, the right-click order path); a rock / pod keeps Target.
 * - The identity ring is the focused thing's hull (the `hullColor` thresholds),
 *   from the same change-only ~6.7 Hz poll the Details panel reads
 *   (`useSelectionPanelData`): nothing per frame, nothing in Zustand.
 * - Renders only while something is selected (the store's mirror of THE
 *   selection, `selection`).
 * - Never both sides: the strip slides away while a right panel is open
 *   (`rightPanel !== null`, or the Fly contacts list, which is the Contacts rail
 *   item until U2-3 folds it into `rightPanel`) and comes back when it closes.
 * - ⚙ opens the selection's panel on the right: the Fleet rail panel for own
 *   ships, the Details panel (`rightPanel='details'`) for a focus-only pick (a
 *   structure, drone, rock, pod, someone else's ship, a parked hull).
 * - ✕ deselects through the renderer, which owns the selection: `selectFleetShips([])`
 *   clears the ships and the focus in its one `setSelection`; the store follows.
 */
import { EqxIcon, EqxIconButton, EqxStrip, EqxStripIdentity, type EqxIconName } from '../../ui/index.js';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { useShouldRenderHud, useUIStore } from '../state/store';
import type { RightPanel } from '../state/rightPanel';
import type { SelectionFocusKind, UISelection } from '../state/storeTypes';
import { useSelectionPanelData, type PanelData } from '../components/selectionPanelData';
import { fleetLockApplies, lockFocus } from '../components/targetLock';
import { Slot } from './Slot';
import { useFleetStripItems } from './fleetStripItems';
import { useBuildingStripItems } from './buildingStripItems';
import { useSelectionStripItems } from './selectionStripItems';
import { useLeftStripFit } from './leftStripFit';
import { STANCE_COLOUR } from '../components/contactRows';

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
  /** The right panel ⚙ opens. */
  panel: Exclude<RightPanel, null>;
}

/** What the selection strip shows for `sel`, or null when nothing is selected (pure; unit-tested). */
export function stripIdentity(sel: UISelection): StripIdentity | null {
  const n = sel.ids.length;
  if (n > 0) return { icon: 'fleet', tooltip: n === 1 ? '1 ship selected' : `${n} ships selected`, count: n, panel: 'fleet' };
  if (sel.focusId === null || sel.focusKind === null) return null;
  return { ...FOCUS_LOOK[sel.focusKind], count: 1, panel: 'details' };
}

/** The focus identity shown after the fleet section: my ships are selected
 *  and the focus is not one of them (pure; unit-tested). */
export function stripFocusIdentity(sel: UISelection): StripIdentity | null {
  if (sel.ids.length === 0 || sel.focusId === null || sel.focusKind === null || sel.ids.includes(sel.focusId)) return null;
  return { ...FOCUS_LOOK[sel.focusKind], count: 1, panel: 'details' };
}

/** The identity ring for the focused thing's hull: ok when unknown or hull-less (pure). */
export function stripHealth(d: PanelData | null): 'ok' | 'warn' | 'crit' {
  if (d === null || d.pending === true || d.noHull === true) return 'ok';
  return d.hpPct > 50 ? 'ok' : d.hpPct > 25 ? 'warn' : 'crit';
}

interface Props {
  /** The renderer (it owns the selection); ✕ clears it there. */
  rendererRef: { readonly current: Pick<IFleetView, 'selectFleetShips' | 'attackFocus'> | null };
}

export function LeftStripHost({ rendererRef }: Props): JSX.Element | null {
  const shown = useShouldRenderHud();
  const selection = useUIStore((s) => s.selection);
  const panelOpen = useUIStore((s) => s.rightPanel !== null);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const fleetItems = useFleetStripItems();
  const data = useSelectionPanelData();
  const buildingItems = useBuildingStripItems(data);
  const fleetLock = fleetLockApplies(selection)
    ? (): void => { lockFocus(useUIStore.getState().selection, rendererRef.current, () => false); }
    : null;
  const { items: quickItems, loot } = useSelectionStripItems(data, fleetLock);
  const id = stripIdentity(selection);
  const focus = stripFocusIdentity(selection);
  useLeftStripFit(shown && id !== null);
  if (!shown || id === null) return null;
  const panel = id.panel;
  // A single focus names itself ("Fighter", the building's name); a ship group keeps its count.
  const named = data !== null && data.name !== '' ? data.name : null;
  const tooltip = selection.ids.length === 0 && named !== null ? named : id.tooltip;
  // The focus icon wears its stance colour (the contacts table's): red hostile, neutral, green friendly.
  // A focus that is not friendly rings in its stance colour too: a green ring would read as "ours".
  const stance = data?.stance;
  const tint = stance === undefined ? {} : {
    iconColor: STANCE_COLOUR[stance], 'data-state': stance,
    ...(stance === 'friendly' ? {} : { ringColor: STANCE_COLOUR[stance] }),
  };
  return (
    <Slot anchor="left-strip">
      <EqxStrip aria-label="Selection" open={!panelOpen} data-testid="left-strip">
        <EqxStripIdentity icon={<EqxIcon name={id.icon} />} tooltip={tooltip} health={focus === null ? stripHealth(data) : 'ok'} count={id.count}
          {...(focus === null && selection.ids.length === 0 ? tint : {})} data-testid="left-strip-identity" />
        {fleetItems}
        {focus !== null && <EqxStrip.Separator key="focus-sep" />}
        {focus !== null && (
          <EqxStripIdentity icon={<EqxIcon name={focus.icon} />} tooltip={named ?? focus.tooltip} health={stripHealth(data)}
            count={1} {...tint} data-testid="left-strip-focus" />
        )}
        {buildingItems}
        {quickItems}
        <EqxStrip.Separator />
        <EqxIconButton variant="strip" icon={<EqxIcon name="cog" />} tooltip={panel === 'fleet' ? 'All orders and details' : 'Details'}
          onClick={() => setRightPanel(panel)} data-testid="left-strip-cog" />
        <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect"
          onClick={() => rendererRef.current?.selectFleetShips([])} data-testid="left-strip-close" />
      </EqxStrip>
      {loot}
    </Slot>
  );
}
