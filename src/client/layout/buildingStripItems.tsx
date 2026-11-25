/**
 * The left strip's building section (UI language plan U3-6): while your own
 * building is selected in Build mode, the strip shows its Power as an
 * EqxStatusFlyout (the fleet strip's Order / Stance pattern,
 * `fleetStripItems.tsx`). The rest of the building's settings (throttle,
 * production, management) are in the Details panel, reached by ⚙.
 *
 * - Only for a kind the server lets its owner switch (`hasPowerSwitch`, read
 *   into `PanelData.powerSwitch`), and only in Build mode
 *   (`canManageBuildings`, the one management predicate), like the Details
 *   panel's Power page.
 * - A pick sends `set_structure_power` through `sendSetStructurePower`, the
 *   SAME sender the Power page's switch uses; picking the current value sends
 *   nothing. The throttle is kept: the message carries `on` only.
 * - The shown value is the structure slice's `switchedOff`, from the strip's
 *   change-only poll (`useSelectionPanelData`), so the icon follows the server.
 */
import type { ReactElement } from 'react';
import { EqxIcon, EqxStatusFlyout, type EqxStatusOption } from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { canManageBuildings } from '../structures/buildingManagement.js';
import { sendSetStructurePower } from '../structures/structureActionsClient.js';
import type { PanelData } from '../components/selectionPanelData.js';

export type PowerPick = 'on' | 'off';

const POWER_OPTIONS: readonly EqxStatusOption<PowerPick>[] = [
  { id: 'on', icon: <EqxIcon name="power" />, tooltip: 'Power on' },
  { id: 'off', icon: <EqxIcon name="stop" />, tooltip: 'Power off', tone: 'danger' },
];

/** The building section's strip items, or [] when it does not apply. */
export function useBuildingStripItems(data: PanelData | null): ReactElement[] {
  const manage = useUIStore(canManageBuildings);
  if (!manage || data === null || data.powerSwitch !== true || data.entityId === undefined) return [];
  const entityId = data.entityId;
  const value: PowerPick = data.switchedOff === true ? 'off' : 'on';
  const onPower = (p: PowerPick): void => {
    if (p !== value) sendSetStructurePower(entityId, p === 'on');
  };
  return [
    <EqxStatusFlyout key="power" value={value} options={POWER_OPTIONS} onChange={onPower}
      tooltip={`Power: ${value === 'on' ? 'On' : 'Off'}`} data-testid="left-strip-power" />,
  ];
}
