/**
 * The Details right panel (UI language plan U3-2): everything about the
 * selected thing that is more than a one-tap action. Opened by ⚙ on the left
 * strip for a focus-only selection (`rightPanel='details'`); not a rail item.
 *
 * The body is the selection readout (`EntityStatsPanel`): name and kind, the
 * shield / hull / charge bars (`EqxBar`), building and power lines, and the
 * inspector sections (the building's settings in Build mode, repair, refine,
 * bounty, blueprints, unpack, research lab, teleporters). It closes itself when
 * the selection goes away, so it never shows an empty side.
 */
import { useEffect } from 'react';
import { EQX_PANEL_SIZE, EqxPanel } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { EntityStatsPanel } from '../components/EntityStatsPanel';

export function DetailsPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'details');
  const hasFocus = useUIStore((s) => s.selection.focusId !== null);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  useEffect(() => {
    if (open && !hasFocus) setRightPanel(null);
  }, [open, hasFocus, setRightPanel]);
  return (
    <EqxPanel
      open={open}
      onClose={() => setRightPanel(null)}
      testId="rail-panel-details"
      closeTestId="rail-panel-details-close"
      title="Details"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      {open && hasFocus && <EntityStatsPanel />}
    </EqxPanel>
  );
}
