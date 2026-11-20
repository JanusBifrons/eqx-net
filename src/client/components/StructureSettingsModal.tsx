/**
 * Settings window for your own building: a cog in the inspector's owner
 * action row opens a tabbed window on the loot window's frame (GameWindow.tsx):
 * the same dimmed, opaque, nearly full-screen-on-a-phone window, header, ✕,
 * footer and HUD palette.
 *
 * Tabs come from `settingsTabsFor(kindId)`, so later tabs (On/Off, Throttle,
 * and the inspector's recipe / gate / upgrade controls) are added per building
 * kind in one place. Today: Power, read-only.
 *
 * Tapping outside, the ✕ or Close shuts it.
 * Numbers are read from the render mirror at 4 Hz while open (low cadence,
 * like the teleporter panel) — the same slice the PWR line reads.
 */
import { memo, useEffect, useState } from 'react';
import { Box, IconButton, Tab, Tabs, Tooltip } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { getGameClient } from '../net/clientSingleton';
import { HUD } from '../hud/tokens';
import {
  GameWindow, WINDOW_BTN_SECONDARY_SX, WINDOW_EDGE, WINDOW_FOOT_SX, WINDOW_HEAD_SX, WINDOW_ROOT_SX, WINDOW_TITLE_SX, WINDOW_X_SX,
} from './GameWindow';
import { powerSummary, signed, type PowerSummary } from './structureSettingsPower';

export type SettingsTabId = 'power';
interface SettingsTab { id: SettingsTabId; label: string }

const POWER_TAB: SettingsTab = { id: 'power', label: 'Power' };

/** The tabs a building kind shows, in order. Every building sits on a grid,
 *  so every kind has Power; later tabs are appended here per kind. */
export function settingsTabsFor(_kindId: string): readonly SettingsTab[] {
  return [POWER_TAB];
}

const POLL_MS = 250;

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
  return a.selfPower === b.selfPower && a.load === b.load && a.gridNet === b.gridNet && a.powered === b.powered;
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
  return (
    <GameWindow open={open} onClose={onClose} testId="structure-settings">
      <Box sx={WINDOW_ROOT_SX}>
        <Box sx={WINDOW_HEAD_SX}>
          <Box sx={WINDOW_TITLE_SX}>{title} settings</Box>
          <Box component="button" sx={WINDOW_X_SX} onClick={onClose} aria-label="Close" data-testid="structure-settings-close">✕</Box>
        </Box>
        <Tabs value={tab} onChange={(_e, v: SettingsTabId) => setTab(v)} sx={TABS_SX} variant="fullWidth">
          {tabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} data-testid={`structure-settings-tab-${t.id}`} />)}
        </Tabs>
        <Box sx={BODY_SX}>
          {open && tab === 'power' && <PowerTab entityId={entityId} />}
        </Box>
        <Box sx={WINDOW_FOOT_SX}>
          <Box sx={{ flex: 1 }} />
          <Box component="button" sx={WINDOW_BTN_SECONDARY_SX} onClick={onClose} data-testid="structure-settings-close-btn">Close</Box>
        </Box>
      </Box>
    </GameWindow>
  );
}

/** The cog for the inspector's owner action row; owns the window's open flag. */
export const StructureSettingsCog = memo(function StructureSettingsCog({ entityId, title }: { entityId: number; title: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip title="Settings">
        <IconButton data-testid="structure-action-settings" size="small" sx={COG_SX} onClick={() => setOpen(true)}>
          <SettingsIcon sx={COG_ICON_SX} />
        </IconButton>
      </Tooltip>
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
const ROW_SX = { fontSize: 12, color: C.inkDim } as const;
const COG_SX = { p: '2px', color: 'rgba(180,220,255,0.85)', '&:hover': { color: '#cde', bgcolor: 'rgba(120,200,255,0.15)' } } as const;
const COG_ICON_SX = { fontSize: { xs: 16, sm: 28 } } as const;
