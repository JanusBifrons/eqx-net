/**
 * The left strip host (UI language plan A5, job U1-8).
 *
 * - Draws the active strip in `<Slot anchor="left-strip">`. For now that is the
 *   selection strip skeleton: identity (icon + count), ⚙ and ✕. Status icons and
 *   quick actions come with U3-1; the doing-mode strips with U3-7.
 * - Renders only while something is selected (the store's mirror of THE
 *   selection, `selection`).
 * - Never both sides: the strip slides away while a right panel is open
 *   (`rightPanel !== null`, or the Fly contacts list, which is the Contacts rail
 *   item until U2-3 folds it into `rightPanel`) and comes back when it closes.
 * - ⚙ opens the selection's panel on the right: today the Fleet rail panel for
 *   own ships. A focus-only pick (a structure, drone, someone else's ship) gets
 *   no ⚙ until its Details panel exists (wave 3), so it never opens an empty side.
 * - ✕ deselects through the renderer, which owns the selection: `selectFleetShips([])`
 *   clears the ships and the focus in its one `setSelection`; the store follows.
 */
import { EqxIcon, EqxIconButton, EqxStrip, EqxStripIdentity, type EqxIconName } from '../../ui/index.js';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { selectControlMode, useShouldRenderHud, useUIStore } from '../state/store';
import type { RightPanel } from '../state/rightPanel';
import type { SelectionFocusKind, UISelection } from '../state/storeTypes';
import { Slot } from './Slot';

const FOCUS_LOOK: Readonly<Record<SelectionFocusKind, { icon: EqxIconName; tooltip: string }>> = {
  ship: { icon: 'fleet', tooltip: 'Ship' },
  lingering: { icon: 'fleet', tooltip: 'Parked hull' },
  drone: { icon: 'target', tooltip: 'Drone' },
  structure: { icon: 'build', tooltip: 'Structure' },
  asteroid: { icon: 'hold', tooltip: 'Asteroid' },
  pod: { icon: 'hold', tooltip: 'Cargo pod' },
};

export interface StripIdentity {
  icon: EqxIconName;
  tooltip: string;
  count: number;
  /** The right panel ⚙ opens, or null when there is none yet. */
  panel: RightPanel;
}

/** What the selection strip shows for `sel`, or null when nothing is selected (pure; unit-tested). */
export function stripIdentity(sel: UISelection): StripIdentity | null {
  const n = sel.ids.length;
  if (n > 0) return { icon: 'fleet', tooltip: n === 1 ? '1 ship selected' : `${n} ships selected`, count: n, panel: 'fleet' };
  if (sel.focusId === null || sel.focusKind === null) return null;
  return { ...FOCUS_LOOK[sel.focusKind], count: 1, panel: null };
}

interface Props {
  /** The renderer (it owns the selection); ✕ clears it there. */
  rendererRef: { readonly current: Pick<IFleetView, 'selectFleetShips'> | null };
}

export function LeftStripHost({ rendererRef }: Props): JSX.Element | null {
  const shown = useShouldRenderHud();
  const selection = useUIStore((s) => s.selection);
  const panelOpen = useUIStore((s) => s.rightPanel !== null || (s.contactsOpen && selectControlMode(s) === 'fly'));
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const id = stripIdentity(selection);
  if (!shown || id === null) return null;
  const panel = id.panel;
  return (
    <Slot anchor="left-strip">
      <EqxStrip aria-label="Selection" open={!panelOpen} data-testid="left-strip">
        <EqxStripIdentity icon={<EqxIcon name={id.icon} />} tooltip={id.tooltip} health="ok" count={id.count} data-testid="left-strip-identity" />
        <EqxStrip.Separator />
        {panel !== null && (
          <EqxIconButton variant="strip" icon={<EqxIcon name="cog" />} tooltip="All orders and details"
            onClick={() => setRightPanel(panel)} data-testid="left-strip-cog" />
        )}
        <EqxIconButton variant="strip" icon={<EqxIcon name="close" />} tooltip="Deselect"
          onClick={() => rendererRef.current?.selectFleetShips([])} data-testid="left-strip-close" />
      </EqxStrip>
    </Slot>
  );
}
