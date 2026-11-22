/**
 * Your own building's settings, a section of the Details panel (UI language
 * plan U3-6; ⚙ on the left strip opens Details, `rightPanel='details'`).
 * Shown in Build mode only (`canManageBuildings`, EntityStatsActions.tsx).
 *
 * A status block (owner, level, connections, hold: structureSettingsStatus.tsx)
 * sits over a segmented control with the pages `settingsTabsFor(kindId)` gives,
 * so pages are added per building kind in one place:
 * - Power: its numbers, plus the owner's On/Off and Throttle where the kind
 *   has them (`PowerTab`, structureSettingsPowerControls.tsx). The strip's
 *   Power fly-out (layout/buildingStripItems.tsx) sends the same message.
 * - Build, for a building that makes things: hull picture tiles for a hull
 *   yard, else the recipe (+ Change), build count and blueprint slot
 *   (`ProductionTab`, structureSettingsBuild.tsx).
 * - Manage, for every building: a gate's Access control
 *   (structureSettingsGate.tsx) over deconstruct, reconnect, clear connections
 *   and upgrade (StructureManageActions.tsx).
 * Labels read Power / Build / Manage; the page ids (and test ids) keep their
 * old names (`power`, `production`, `access`).
 *
 * The pages read the render mirror at 4 Hz while shown (they mount only while
 * the Details panel is open). On mount the camera glides once so the building
 * sits mid-way across the screen left of the panel (Build / Command only).
 */
import { useEffect, useState } from 'react';
import { EQX_PANEL_SIZE, EqxSection, EqxSegmented, type EqxSegmentedOption } from '../../ui/index.js';
import { getGameClient } from '../net/clientSingleton';
import { selectControlMode, useUIStore } from '../state/store';
import { canChangeRecipe, makesThings } from './structureSettingsProduction';
import { GateTab, hasGateAccess } from './structureSettingsGate';
import { ProductionTab } from './structureSettingsBuild';
import { PowerTab, readStructureKind } from './structureSettingsPowerControls';
import { StructureManageTab } from './StructureManageActions';
import { SettingsStatus } from './structureSettingsStatus';
import { GRID_SX, LABEL_SX, SETTINGS_POLL_MS, STEP_BTN_SX, VALUE_SX } from './structureSettingsSx';
import { rightPanelWidthPx } from './panelCameraNudge';
import { queuePanelNudge } from '../structures/buildModeView';
import { isTouchDevice } from '../input/TouchInput';

export type SettingsTabId = 'power' | 'production' | 'access';
interface SettingsTab { id: SettingsTabId; label: string }

const POWER_TAB: SettingsTab = { id: 'power', label: 'Power' };
const PRODUCTION_TAB: SettingsTab = { id: 'production', label: 'Build' };
const ACCESS_TAB: SettingsTab = { id: 'access', label: 'Manage' };

/** The pages a building kind shows, in order. Every building sits on a grid,
 *  so every kind has Power, and every kind has Manage (last); Build is added
 *  per kind here. */
const WITH_PRODUCTION: readonly SettingsTab[] = [POWER_TAB, PRODUCTION_TAB, ACCESS_TAB];
const WITH_MANAGE: readonly SettingsTab[] = [POWER_TAB, ACCESS_TAB];
export function settingsTabsFor(kindId: string): readonly SettingsTab[] {
  return makesThings(kindId) || canChangeRecipe(kindId) ? WITH_PRODUCTION : WITH_MANAGE;
}

const optionsFor = (tabs: readonly SettingsTab[]): EqxSegmentedOption[] =>
  tabs.map((t) => ({ id: t.id, label: t.label, testId: `structure-settings-tab-${t.id}` }));

/** Once per building: glide the camera so it sits mid-way across the screen
 *  left of the Details panel. Not in Fly (the follow camera owns the view) nor
 *  upright (the panel is a bottom sheet). One mirror read, never per frame. */
function nudgeCameraFor(entityId: number): void {
  if (selectControlMode(useUIStore.getState()) === 'fly' || window.innerHeight > window.innerWidth) return;
  const e = getGameClient()?.mirror.swarm?.get(entityId);
  if (e) queuePanelNudge(e.x, e.y, rightPanelWidthPx(EQX_PANEL_SIZE, window.innerWidth, isTouchDevice()));
}

export function StructureSettings({ entityId }: { entityId: number }): JSX.Element {
  const kindId = readStructureKind(entityId) ?? '';
  const tabs = settingsTabsFor(kindId);
  const [picked, setPicked] = useState<SettingsTabId>(tabs[0]!.id);
  // A building of another kind may not have the page last picked.
  const tab = tabs.some((t) => t.id === picked) ? picked : tabs[0]!.id;
  useEffect(() => { nudgeCameraFor(entityId); }, [entityId]);
  return (
    <EqxSection title="Settings" data-testid="structure-settings">
      <SettingsStatus entityId={entityId} pollMs={SETTINGS_POLL_MS} />
      <EqxSegmented options={optionsFor(tabs)} value={tab} onChange={(id) => setPicked(id as SettingsTabId)}
        label="Building settings" data-testid="structure-settings-tabs" />
      {tab === 'power' && <PowerTab entityId={entityId} />}
      {tab === 'production' && <ProductionTab entityId={entityId} />}
      {tab === 'access' && hasGateAccess(kindId) && (
        <GateTab entityId={entityId} pollMs={SETTINGS_POLL_MS} gridSx={GRID_SX} labelSx={LABEL_SX} valueSx={VALUE_SX} btnSx={STEP_BTN_SX} />
      )}
      {tab === 'access' && <StructureManageTab entityId={entityId} pollMs={SETTINGS_POLL_MS} />}
    </EqxSection>
  );
}
