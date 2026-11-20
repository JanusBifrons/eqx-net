/**
 * Settings window for your own building: a cog in the inspector's owner
 * action row opens a small tabbed window in the game dialog chrome
 * (gameDialogChrome.ts) and the drawer's tab look (TradeTab's TABS_SX).
 *
 * Tabs come from `settingsTabsFor(kindId)`, so later tabs (On/Off, Throttle,
 * and the inspector's recipe / gate / upgrade controls) are added per building
 * kind in one place. Today: Power, read-only.
 *
 * The window sits at the top centre with an invisible backdrop, so the world
 * (and the selected building) stays visible; tapping outside closes it.
 * Numbers are read from the render mirror at 4 Hz while open (low cadence,
 * like the teleporter panel) — the same slice the PWR line reads.
 */
import { memo, useEffect, useState } from 'react';
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Tab, Tabs, Tooltip } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import CloseIcon from '@mui/icons-material/Close';
import { getGameClient } from '../net/clientSingleton';
import { Z } from '../layout/zIndex';
import { GAME_DIALOG_CONTENT_SX, GAME_DIALOG_PAPER_SX, GAME_DIALOG_TITLE_SX } from './gameDialogChrome';
import { powerSummary, signed, type PowerSummary } from './structureSettingsPower';
import { TABS_SX as TRADE_TABS_SX } from '../layout/Drawer/tabs/TradeTab';

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
    <Dialog
      open={open} onClose={onClose} maxWidth={false} data-testid="structure-settings"
      sx={DIALOG_SX} BackdropProps={{ invisible: true }} disableScrollLock
      PaperProps={{ sx: PAPER_SX }}
    >
      <DialogTitle sx={TITLE_SX}>
        <span>{title} settings</span>
        <IconButton size="small" aria-label="Close" data-testid="structure-settings-close" onClick={onClose} sx={CLOSE_SX}>
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </DialogTitle>
      <Tabs value={tab} onChange={(_e, v: SettingsTabId) => setTab(v)} sx={TABS_SX} variant="fullWidth">
        {tabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} data-testid={`structure-settings-tab-${t.id}`} />)}
      </Tabs>
      <DialogContent sx={CONTENT_SX}>
        {open && tab === 'power' && <PowerTab entityId={entityId} />}
      </DialogContent>
    </Dialog>
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

// The drawer's tab look, on the dialog's navy.
const TABS_SX = { ...TRADE_TABS_SX, px: 1, bgcolor: '#0c1020' } as const;
// Top centre (the free zone on a phone), below the app bar: never over the
// middle of the screen where the camera and the selected building are.
const DIALOG_SX = { zIndex: Z.modal, '& .MuiDialog-container': { alignItems: 'flex-start' } } as const;
const PAPER_SX = { ...GAME_DIALOG_PAPER_SX, m: 0, mt: 'calc(env(safe-area-inset-top, 0px) + 8px)', width: 'min(280px, calc(100% - 24px))', backgroundImage: 'none' } as const;
const TITLE_SX = { ...GAME_DIALOG_TITLE_SX, fontSize: 12, py: 0.75, px: 1.5, justifyContent: 'space-between' } as const;
const CLOSE_SX = { color: '#9aa0b4', p: '2px' } as const;
const CONTENT_SX = { ...GAME_DIALOG_CONTENT_SX, px: 1.5, py: 1 } as const;
const GRID_SX = { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1.5, rowGap: 0.5, fontSize: 11 } as const;
const LABEL_SX = { color: '#9aa0b4' } as const;
const VALUE_SX = { color: '#ccc', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' } as const;
const ROW_SX = { fontSize: 11, color: '#9aa0b4' } as const;
const COG_SX = { p: '2px', color: 'rgba(180,220,255,0.85)', '&:hover': { color: '#cde', bgcolor: 'rgba(120,200,255,0.15)' } } as const;
const COG_ICON_SX = { fontSize: { xs: 16, sm: 28 } } as const;
