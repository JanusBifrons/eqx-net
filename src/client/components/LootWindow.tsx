/**
 * Cargo pods: the loot window. The game's window frame (GameWindow.tsx: a
 * fixed, opaque, screen-space Dialog) that holds the cargo panel for a
 * pod, a storage structure or a ship. It replaces the panel that used to grow
 * inside the world-anchored inspector: the window keeps its size and place
 * while stacks reveal or move, so taps always land.
 */
import { memo, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import Inventory2Icon from '@mui/icons-material/Inventory2';
import { GameWindow } from './GameWindow';
import { CargoPanel, type CargoPanelProps } from './CargoPanel';

export interface LootWindowProps extends CargoPanelProps {
  open: boolean;
  /** What is being looted ("Cargo pod", a structure's or ship's name). */
  title: string;
  /** A chip beside the name, e.g. the pod's size. */
  subtitle?: string;
  /** The left grid's heading ("Pod contents"). */
  theirsLabel?: string;
  onClose: () => void;
}

export function LootWindow({ open, title, subtitle, theirsLabel, onClose, entityId, ship }: LootWindowProps): JSX.Element {
  return (
    <GameWindow open={open} onClose={onClose} testId="loot-window">
      {open && (
        <CargoPanel
          {...(ship !== undefined ? { ship } : { entityId })} title={title} onClose={onClose}
          {...(subtitle !== undefined ? { subtitle } : {})} {...(theirsLabel !== undefined ? { theirsLabel } : {})}
        />
      )}
    </GameWindow>
  );
}

const TOGGLE_ROW_SX = { display: 'flex', gap: '4px', alignItems: 'center', pointerEvents: 'auto' as const, mt: 0.5 };
const TOGGLE_BTN_SX = { color: '#8fe0bd', p: 0.5 };
const TOGGLE_ICON_SX = { fontSize: { xs: 16, sm: 22 } };
const OPEN_BTN_SX = {
  py: '2px', px: 1, fontWeight: 700, letterSpacing: 1, fontSize: 10, color: '#8fe0bd', background: 'rgba(143,224,189,0.12)',
  border: '1px solid rgba(143,224,189,0.45)', borderRadius: '3px',
};

/** Cargo pods 16 — a selected pod's Open button: live within the open reach
 *  (`withinLootOpenReach`), greyed with a hint beyond it. The window it opens
 *  shuts again when the ship leaves the reach. */
export const PodOpen = memo(function PodOpen({ entityId, inReach, subtitle }: { entityId: number; inReach: boolean; subtitle?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = open && inReach;
  return (
    <Box>
      <Box sx={TOGGLE_ROW_SX}>
        <Box
          component="button" data-testid="pod-open" data-in-reach={inReach ? '1' : '0'} disabled={!inReach}
          onClick={() => setOpen(true)}
          sx={{ ...OPEN_BTN_SX, opacity: inReach ? 1 : 0.45, cursor: inReach ? 'pointer' : 'default' }}
        >
          OPEN
        </Box>
        {!inReach && <Box sx={{ fontSize: 9, color: '#9fb8ad' }}>Fly closer to open</Box>}
      </Box>
      <LootWindow open={shown} title="Cargo pod" theirsLabel="Pod contents" {...(subtitle !== undefined ? { subtitle } : {})} entityId={entityId} onClose={() => setOpen(false)} />
    </Box>
  );
});

/** The inspector's "Cargo" toggle for a storage structure or a ship: opens
 *  the loot window (which asks the server, so a locked or far one says why). */
export const CargoAction = memo(function CargoAction({ entityId, ship, title }: CargoPanelProps & { title: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <Box sx={TOGGLE_ROW_SX}>
        <Tooltip title="Open cargo">
          <IconButton data-testid="cargo-open-toggle" size="small" sx={TOGGLE_BTN_SX} onClick={() => setOpen(true)}>
            <Inventory2Icon sx={TOGGLE_ICON_SX} />
          </IconButton>
        </Tooltip>
      </Box>
      <LootWindow open={open} title={title} {...(ship !== undefined ? { ship } : { entityId })} onClose={() => setOpen(false)} />
    </Box>
  );
});
