/**
 * Rail item Fleet (UI plan U1-5 stub): today's fleet orders surface (the
 * desktop FleetPanel, or the compact FleetStrip) inside the one right panel,
 * docked left of the rail. Each renders only while own ships are selected,
 * as before. While this panel is open, GameHud drops its bottom copy, so the
 * orders show once. A wave-3 job redesigns the contents.
 */
import { EQX_PANEL_SIZE, EqxPanel } from '../../ui/index.js';
import { useUIStore } from '../state/store';
import { FleetPanel } from '../components/FleetPanel';
import { FleetStrip } from '../components/FleetStrip';

export function FleetRailPanel(): JSX.Element {
  const open = useUIStore((s) => s.rightPanel === 'fleet');
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  return (
    <EqxPanel
      open={open}
      onClose={() => setRightPanel(null)}
      testId="rail-panel-fleet"
      closeTestId="rail-panel-fleet-close"
      title="Fleet"
      size={EQX_PANEL_SIZE}
      closeOnEscape
    >
      {open && <><FleetPanel /><FleetStrip /></>}
    </EqxPanel>
  );
}
