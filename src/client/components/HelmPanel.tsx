import { Box, ButtonBase } from '@mui/material';
import { HELM_SPEED_FRACTION } from '@core/helm/helm';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { helmOrdersAllowed } from '../helm/helmModeGate.js';
import { fleetCommands } from '../fleet/fleetCommands.js';

/**
 * The ship-speed telegraph (Stop / ⅓ / ⅔ / Full), a Command control (owner,
 * 2026-11-21: "Command is where you click move to go, and where you set the
 * speed. Fly is just manual"). It shows in Command while ships are selected
 * and acts on that selection: the setting rides every move order you give
 * (`fleet_order` `speed`), and changing it re-paces the selected ships'
 * running moves (Stop halts them where they are; they keep the point, and a
 * new speed sends them on). Never in Fly or Build, for any hull.
 * It renders inside the fleet panel / strip (bottom edge), never in a slot
 * over the map: in Command a click on the map is an order.
 * Reads only discrete Zustand state (#2).
 */
const LABELS = ['Stop', '⅓', '⅔', 'Full'] as const;

const ROOT_SX = {
  display: 'flex',
  alignItems: 'center',
  columnGap: '4px',
  padding: '4px 6px',
  borderRadius: '6px',
  backgroundColor: 'rgba(10,16,28,0.72)',
  fontFamily: 'system-ui, sans-serif',
  fontSize: 12,
  color: '#cfe3ff',
  pointerEvents: 'auto' as const,
};
const LABEL_SX = { opacity: 0.75, marginRight: '4px' };
const BTN_SX = {
  minWidth: 38,
  height: 26,
  borderRadius: '4px',
  fontSize: 12,
  color: '#cfe3ff',
  border: '1px solid rgba(160,200,255,0.35)',
};
const BTN_ON_SX = { ...BTN_SX, backgroundColor: 'rgba(90,160,255,0.45)', color: '#fff' };

/** Set the Command speed and re-pace the selection's running moves (also the
 *  left strip's Speed fly-out, `layout/fleetStripItems.tsx`). */
export function chooseSpeed(step: 0 | 1 | 2 | 3): void {
  const s = useUIStore.getState();
  s.setCommandSpeed(step);
  const ids = s.selection.ids;
  if (ids.length > 0) fleetCommands().setSpeed(ids, HELM_SPEED_FRACTION[step] ?? 1);
}

export function HelmPanel(): JSX.Element | null {
  const show = useShouldRenderHud();
  const speed = useUIStore((s) => s.commandSpeed);
  const selected = useUIStore((s) => s.selection.ids.length > 0);
  const command = useUIStore(helmOrdersAllowed); // Command only, never Fly or Build
  if (!show || !command || !selected) return null;
  return (
    <Box sx={ROOT_SX} data-testid="helm-panel" data-helm-speed={speed}>
      <Box component="span" sx={LABEL_SX}>Speed</Box>
      {LABELS.map((label, i) => (
        <ButtonBase
          key={label}
          sx={i === speed ? BTN_ON_SX : BTN_SX}
          data-testid={`helm-speed-${i}`}
          onClick={() => chooseSpeed(i as 0 | 1 | 2 | 3)}
        >
          {label}
        </ButtonBase>
      ))}
    </Box>
  );
}
