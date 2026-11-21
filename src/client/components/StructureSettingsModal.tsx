/**
 * Settings panel for your own building: a cog in the inspector's owner
 * action row opens a tabbed panel docked on the RIGHT (SidePanel.tsx, the
 * galaxy map's sector panel shell): no dimming, the map stays live and
 * interactive behind it; ~40% of a sideways phone's width, 360 px on desktop.
 * Header, ✕, footer and palette are the loot window's (GameWindow.tsx).
 *
 * Tabs come from `settingsTabsFor(kindId)`, so tabs are added per building
 * kind in one place. Power (its numbers, plus the owner's On/Off and
 * Throttle where the kind has them: structureSettingsPowerControls.tsx); for
 * a building that makes things, Production: for a hull yard picture tiles
 * (structureSettingsBuild.tsx), else its recipe (and the Change button
 * that cycles it, once the inspector's), a build count (minus / plus /
 * forever) sent on the same `set_recipe` message as the recipe, and the
 * blueprint slot (Load / Unload); Manage for every building: deconstruct,
 * reconnect, clear connections, upgrade (StructureManageActions.tsx), with a
 * gate's Access control above them (structureSettingsGate.tsx). Labels read Build / Power /
 * Manage; the tab ids (and test ids) keep their old names. A status block
 * above the tabs shows owner, level, connections and hold
 * (structureSettingsStatus.tsx).
 * The inspector card keeps only its Open button and one-shot actions.
 *
 * The ✕, Close or a swipe on the handle shuts it, and so does a change of
 * selection (another entity picked, or none).
 * Numbers are read from the render mirror at 4 Hz while open (low cadence,
 * like the teleporter panel) — the same slice the PWR line reads.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Box, Tab, Tabs, Tooltip } from '@mui/material';
import { getGameClient } from '../net/clientSingleton';
import { HUD } from '../hud/tokens';
import { useUIStore } from '../state/store';
import { SidePanel, type SidePanelSize } from './SidePanel';
import {
  notifyGameWindowOpen, WINDOW_BTN_SECONDARY_SX, WINDOW_EDGE, WINDOW_FOOT_SX, WINDOW_HEAD_SX, WINDOW_ROOT_SX, WINDOW_TITLE_SX, WINDOW_X_SX,
} from './GameWindow';
import { powerSummary, signed, type PowerSummary } from './structureSettingsPower';
import { PowerControls } from './structureSettingsPowerControls';
import { buildCountText, canChangeRecipe, makesThings, readProduction, sameProduction, type ProductionView } from './structureSettingsProduction';
import { GateTab, hasGateAccess } from './structureSettingsGate';
import { BlueprintRow, HullBuildTab } from './structureSettingsBuild';
import { StructureManageTab } from './StructureManageActions';
import { SettingsStatus } from './structureSettingsStatus';
import { sendSetRecipe } from '../structures/structureActionsClient';
import { MAX_BUILD_COUNT, nextRecipe } from '@shared-types/production';
import { RECIPES } from '@shared-types/recipes';
import { phoneTiny } from './inspectorSizes';

export type SettingsTabId = 'power' | 'production' | 'access';
interface SettingsTab { id: SettingsTabId; label: string }

const POWER_TAB: SettingsTab = { id: 'power', label: 'Power' };
const PRODUCTION_TAB: SettingsTab = { id: 'production', label: 'Build' };
const ACCESS_TAB: SettingsTab = { id: 'access', label: 'Manage' };

/** The tabs a building kind shows, in order. Every building sits on a grid,
 *  so every kind has Power, and every kind has Manage (last); Build is added
 *  per kind here. */
const WITH_PRODUCTION: readonly SettingsTab[] = [POWER_TAB, PRODUCTION_TAB, ACCESS_TAB];
const WITH_MANAGE: readonly SettingsTab[] = [POWER_TAB, ACCESS_TAB];
export function settingsTabsFor(kindId: string): readonly SettingsTab[] {
  return makesThings(kindId) || canChangeRecipe(kindId) ? WITH_PRODUCTION : WITH_MANAGE;
}

const POLL_MS = 250;
/** ~40% of a sideways phone (never under 280 px), 360 px on desktop; below the app bar. */
export const SETTINGS_PANEL_SIZE: SidePanelSize = { width: 360, touchFrac: 0.4, touchMinW: 280, touchTop: null };

function readKind(entityId: number): string | undefined {
  return getGameClient()?.mirror.swarm?.get(entityId)?.shipKind;
}

function readPower(entityId: number): PowerSummary | null {
  const st = getGameClient()?.mirror.structures?.get(entityId);
  const kindId = readKind(entityId);
  return st && kindId ? powerSummary(kindId, st) : null;
}

function samePower(a: PowerSummary | null, b: PowerSummary | null): boolean {
  if (a === null || b === null) return a === b;
  return a.selfPower === b.selfPower && a.load === b.load && a.gridNet === b.gridNet && a.powered === b.powered
    && a.on === b.on && a.throttle === b.throttle;
}

const LOAD_LABEL: Record<PowerSummary['load'], string> = { full: 'Full (working)', idle: 'Idle (trickle)', none: 'Never draws' };

function drawNowText(p: PowerSummary): string {
  if (p.selfPower > 0) return `${signed(p.selfPower)} (making)`;
  if (p.selfPower === 0) return '0';
  return p.powered ? signed(p.selfPower) : `${signed(p.selfPower)} (unpowered)`;
}

function PowerTab({ entityId }: { entityId: number }): JSX.Element {
  const [p, setP] = useState<PowerSummary | null>(() => readPower(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setP((prev) => {
      const next = readPower(entityId);
      return samePower(prev, next) ? prev : next;
    }), POLL_MS);
    return () => window.clearInterval(h);
  }, [entityId]);
  if (p === null) return <Box sx={ROW_SX}>No power data</Box>;
  return (
    <Box data-testid="structure-settings-power" data-self-power={p.selfPower} data-load={p.load} data-grid-net={p.gridNet} sx={GRID_SX}>
      <Box sx={LABEL_SX}>Draw now</Box><Box sx={VALUE_SX} data-testid="settings-power-draw">{drawNowText(p)}</Box>
      <Box sx={LABEL_SX}>Load</Box><Box sx={VALUE_SX} data-testid="settings-power-load">{LOAD_LABEL[p.load]}</Box>
      <Box sx={LABEL_SX}>Grid net</Box><Box sx={VALUE_SX} data-testid="settings-power-grid">{signed(p.gridNet)}</Box>
      <PowerControls entityId={entityId} kindId={readKind(entityId) ?? ''} on={p.on} throttle={p.throttle} labelSx={LABEL_SX} />
    </Box>
  );
}

/** Recipe (+ Change), build count and the blueprint slot. Minus stops at 1;
 *  Forever clears the count. A hull yard gets picture tiles instead
 *  (structureSettingsBuild.tsx). */
function ProductionTab({ entityId }: { entityId: number }): JSX.Element {
  const [p, setP] = useState<ProductionView | null>(() => readProduction(entityId));
  useEffect(() => {
    const h = window.setInterval(() => setP((prev) => {
      const next = readProduction(entityId);
      return sameProduction(prev, next) ? prev : next;
    }), POLL_MS);
    return () => window.clearInterval(h);
  }, [entityId]);
  if (p === null) return <Box sx={ROW_SX}>No production data</Box>;
  if (p.hullYard) return <HullBuildTab entityId={entityId} p={p} sx={BUILD_SX} />;
  const { recipe, left, canChange } = p;
  const plus = left === undefined ? 1 : Math.min(MAX_BUILD_COUNT, left + 1);
  return (
    <Box data-testid="structure-settings-production" data-recipe={recipe} data-left={left ?? 'forever'} sx={GRID_SX}>
      <Box sx={LABEL_SX}>Makes</Box>
      <Box sx={STEPPER_SX}>
        <Box sx={VALUE_SX} data-testid="settings-production-recipe">{RECIPES[recipe].displayName}</Box>
        {canChange && (
          <Tooltip title="Change what this makes">
            <Box component="button" sx={STEP_BTN_SX} data-testid="structure-action-recipe"
              onClick={() => sendSetRecipe(entityId, nextRecipe(RECIPES[recipe].processors[0]!, recipe))}>Change</Box>
          </Tooltip>
        )}
      </Box>
      <Box sx={LABEL_SX}>Build</Box>
      <Box sx={STEPPER_SX}>
        <Box component="button" sx={STEP_BTN_SX} aria-label="One fewer" data-testid="settings-build-minus"
          disabled={left === undefined || left <= 1} onClick={() => sendSetRecipe(entityId, recipe, left! - 1)}>−</Box>
        <Box sx={COUNT_SX} data-testid="settings-build-count">{buildCountText(left)}</Box>
        <Box component="button" sx={STEP_BTN_SX} aria-label="One more" data-testid="settings-build-plus"
          disabled={left !== undefined && left >= MAX_BUILD_COUNT} onClick={() => sendSetRecipe(entityId, recipe, plus)}>+</Box>
        <Box component="button" sx={STEP_BTN_SX} aria-label="Repeat forever" data-testid="settings-build-forever"
          disabled={left === undefined} onClick={() => sendSetRecipe(entityId, recipe)}>∞</Box>
      </Box>
      <BlueprintRow entityId={entityId} p={p} {...BUILD_SX} />
    </Box>
  );
}

export interface StructureSettingsModalProps {
  open: boolean;
  entityId: number;
  title: string;
  onClose: () => void;
}

export function StructureSettingsModal({ open, entityId, title, onClose }: StructureSettingsModalProps): JSX.Element {
  const tabs = settingsTabsFor(readKind(entityId) ?? '');
  const [tab, setTab] = useState<SettingsTabId>(tabs[0]!.id);
  // Close when the selection moves on (another entity, or none).
  const focusId = useUIStore((s) => s.selection.focusId);
  const openedOn = useRef(focusId);
  useEffect(() => {
    if (open && focusId !== openedOn.current) onClose();
  }, [open, focusId, onClose]);
  // The speed dial collapses as for a game window; the HUD drops the
  // right-edge weapon strip that would sit under the panel.
  useEffect(() => {
    if (!open) return undefined;
    notifyGameWindowOpen();
    useUIStore.setState({ structureSettingsOpen: true });
    return () => useUIStore.setState({ structureSettingsOpen: false });
  }, [open]);
  return (
    <SidePanel open={open} onClose={onClose} testId="structure-settings" size={SETTINGS_PANEL_SIZE}>
      <Box sx={WINDOW_ROOT_SX}>
        <Box sx={WINDOW_HEAD_SX}>
          <Box sx={WINDOW_TITLE_SX}>{title} settings</Box>
          <Box component="button" sx={WINDOW_X_SX} onClick={onClose} aria-label="Close" data-testid="structure-settings-close">✕</Box>
        </Box>
        {open && <SettingsStatus entityId={entityId} pollMs={POLL_MS} />}
        <Tabs value={tab} onChange={(_e, v: SettingsTabId) => setTab(v)} sx={TABS_SX} variant="fullWidth">
          {tabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} data-testid={`structure-settings-tab-${t.id}`} />)}
        </Tabs>
        <Box sx={BODY_SX}>
          {open && tab === 'power' && <PowerTab entityId={entityId} />}
          {open && tab === 'production' && <ProductionTab entityId={entityId} />}
          {open && tab === 'access' && hasGateAccess(readKind(entityId) ?? '') && (
            <GateTab entityId={entityId} pollMs={POLL_MS} gridSx={GRID_SX} labelSx={LABEL_SX} valueSx={VALUE_SX} btnSx={STEP_BTN_SX} />
          )}
          {open && tab === 'access' && <StructureManageTab entityId={entityId} pollMs={POLL_MS} />}
        </Box>
        <Box sx={WINDOW_FOOT_SX}>
          <Box sx={{ flex: 1 }} />
          <Box component="button" sx={WINDOW_BTN_SECONDARY_SX} onClick={onClose} data-testid="structure-settings-close-btn">Close</Box>
        </Box>
      </Box>
    </SidePanel>
  );
}

/** The inspector card's Open button (owner, Build mode); owns the panel's open flag. */
export const StructureSettingsOpen = memo(function StructureSettingsOpen({ entityId, title }: { entityId: number; title: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Box component="button" data-testid="structure-action-settings" sx={OPEN_BTN_SX} onClick={() => setOpen(true)}
        title="Open this building's panel">Open</Box>
      {open && <StructureSettingsModal open entityId={entityId} title={title} onClose={() => setOpen(false)} />}
    </>
  );
});

const C = HUD.color;
// The loot window's palette: dim ink, the HUD's cyan for the open tab.
const TABS_SX = {
  flex: 'none', minHeight: 40, borderBottom: WINDOW_EDGE, px: 1.5,
  '& .MuiTab-root': { minHeight: 40, minWidth: 0, px: 1, fontFamily: HUD.font.label, fontSize: 12, fontWeight: 600, letterSpacing: 1, color: C.inkDim },
  '& .Mui-selected': { color: `${C.auto} !important` },
  '& .MuiTabs-indicator': { backgroundColor: C.auto },
} as const;
// The body scrolls on a short screen (a sideways phone), never the header or footer.
const BODY_SX = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' as const, px: 1.5, py: 1.25 } as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 1, fontSize: 13, maxWidth: 420 } as const;
const LABEL_SX = { color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' as const, alignSelf: 'center' } as const;
const VALUE_SX = { color: C.ink, textAlign: 'right' as const, fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums' } as const;
const STEPPER_SX = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 } as const;
const STEP_BTN_SX = { ...WINDOW_BTN_SECONDARY_SX, minWidth: 32, px: 1, '&:disabled': { opacity: 0.35, cursor: 'default' } } as const;
const COUNT_SX = { ...VALUE_SX, minWidth: 64, textAlign: 'center' as const } as const;
const ROW_SX = { fontSize: 12, color: C.inkDim } as const;
const BUILD_SX = { labelSx: LABEL_SX, valueSx: VALUE_SX, btnSx: STEP_BTN_SX } as const;
// A small text button sized like the card's text: tiny on a phone.
const OPEN_BTN_SX = {
  ...phoneTiny({ fontSize: [9, 16] }), fontFamily: HUD.font.label, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' as const,
  color: C.auto, bgcolor: 'rgba(52,216,255,0.08)', border: `1px solid ${C.autoGlow}`, borderRadius: '3px', px: '6px', py: '1px', cursor: 'pointer',
  '&:hover': { bgcolor: 'rgba(52,216,255,0.2)' },
} as const;
