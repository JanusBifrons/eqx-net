import { useState } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { getShipKind } from '../../shared-types/shipKinds';
import { ShipSilhouette } from '../render/shipShapeSvg';
import { GRID_CELL } from './rosterConstants';
import { useUIStore } from '../state/store';
import type { RosterShipEntry } from './ShipRosterCard';

/**
 * Detail modal for one roster ship. Full silhouette + full stats + a
 * Spawn primary action and an Abandon destructive action.
 *
 * Both actions are gated by an in-modal confirm step (Phase 5):
 *
 *  - **Spawn**:
 *    - If the clicked ship IS the currently-active hull: no-op (just
 *      close the modal — you're already piloting it).
 *    - Else if the player is in-game (`phase === 'game'`): show a
 *      switch-confirm. The pending ship is parked in its current sector
 *      while the new one becomes active.
 *    - Else (galaxy-map landing, no current hull): bypass the confirm
 *      and call `onSpawn` directly — that's just "pick a ship to spawn"
 *      from the post-auth screen.
 *
 *  - **Abandon**:
 *    - Active ship: strong confirm with "ejects to galaxy map" copy.
 *    - Stored / lingering ship: simple confirm ("Abandon {name}?").
 *
 * The dialogs are conditionally rendered (mounted only when their state
 * is true) so their `data-testid` disappears from the DOM after Cancel —
 * important for jsdom / E2E queries.
 */
interface ShipDetailModalProps {
  ship: RosterShipEntry;
  open: boolean;
  onClose: () => void;
  onSpawn: (ship: RosterShipEntry) => void;
  onAbandon: (ship: RosterShipEntry) => void;
}

export function ShipDetailModal({ ship, open, onClose, onSpawn, onAbandon }: ShipDetailModalProps): JSX.Element {
  const kind = getShipKind(ship.kind);
  const healthPct = Math.max(0, Math.min(100, Math.round((ship.health / kind.maxHealth) * 100)));
  const gx = Math.round(ship.x / GRID_CELL);
  const gy = Math.round(ship.y / GRID_CELL);
  // Phase 5 — "Piloting" means THIS browser session is bound to this hull.
  // The server-side `ship.isActive` flag stays true through the 15-min
  // reconnect-linger window, so it can't distinguish "my current pilot"
  // from "any hull recently bound to me". Welcome's `shipInstanceId` is
  // the source of truth for the local session. The legacy `isActive`
  // (server's broad flag) still drives the card-level ACTIVE chip + the
  // strong-warning-on-abandon copy — that's correct, since abandoning a
  // hull whose session might reconnect IS more destructive than abandoning
  // a fully-stored one.
  const localShipInstanceId = useUIStore((s) => s.localShipInstanceId);
  const phase = useUIStore((s) => s.phase);
  const inGame = phase === 'game';
  const isMyPilotedShip = inGame && localShipInstanceId === ship.shipId;
  const isActive = ship.isActive && ship.activeRoomId !== null;

  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  const handleSpawnClick = (): void => {
    if (isMyPilotedShip) {
      // The user clicked Spawn on the ship THIS session is currently
      // piloting — no-op. (Pre-Phase-5 the check used the broad
      // `ship.isActive`, which incorrectly disabled every recently-bound
      // hull during the 15-min linger window.)
      onClose();
      return;
    }
    if (inGame) {
      setConfirmSwitch(true);
      return;
    }
    onSpawn(ship);
  };

  const handleSwitchConfirm = (): void => {
    setConfirmSwitch(false);
    onSpawn(ship);
  };

  const handleSwitchCancel = (): void => {
    setConfirmSwitch(false);
  };

  const handleAbandonClick = (): void => {
    setConfirmAbandon(true);
  };

  const handleAbandonConfirm = (): void => {
    setConfirmAbandon(false);
    onAbandon(ship);
  };

  const handleAbandonCancel = (): void => {
    setConfirmAbandon(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      data-testid="ship-detail-modal"
      PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a2f40' } }}
    >
      <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88', display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <span>{kind.displayName}</span>
        {isActive && (
          <Chip
            label="ACTIVE"
            size="small"
            sx={{
              height: 18,
              bgcolor: 'rgba(0,255,136,0.15)',
              color: '#00ff88',
              '& .MuiChip-label': { px: 0.75, fontSize: 10, letterSpacing: 0.5 },
            }}
          />
        )}
      </DialogTitle>
      <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
        <Box sx={{ display: 'flex', justifyContent: 'center', my: 1 }}>
          <ShipSilhouette shape={kind.shape} size={96} />
        </Box>
        <Typography variant="caption" sx={{ color: '#888', display: 'block', textAlign: 'center', mb: 1.5 }}>
          {kind.description}
        </Typography>
        <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <StatChip label="Top" value={Math.round(kind.maxSpeed)} />
          <StatChip label="Turn" value={kind.maxAngvel.toFixed(1)} />
          <StatChip label="Hull max" value={Math.round(kind.maxHealth)} />
        </Stack>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.5, mb: 1 }}>
          <StatRow label="Hull" value={`${Math.round(ship.health)} / ${Math.round(kind.maxHealth)} (${healthPct}%)`} />
          <StatRow label="Sector" value={ship.sectorKey} testid="ship-detail-sector" />
          <StatRow label="Grid" value={`${gx}, ${gy}`} testid="ship-detail-grid" />
        </Box>
      </DialogContent>
      <DialogActions sx={{ bgcolor: '#0c1020', justifyContent: 'space-between', px: 2.5, pb: 2 }}>
        <Button
          onClick={handleAbandonClick}
          startIcon={<DeleteForeverIcon />}
          data-testid="ship-detail-abandon"
          sx={{
            color: '#ff5566',
            border: '1px solid #5a2030',
            '&:hover': { bgcolor: 'rgba(255,85,102,0.08)' },
          }}
        >
          Abandon
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} sx={{ color: '#9aa0b4' }} data-testid="ship-detail-close">Close</Button>
          <Button
            onClick={handleSpawnClick}
            startIcon={<RocketLaunchIcon />}
            variant="contained"
            data-testid="ship-detail-spawn"
            disabled={isMyPilotedShip}
            sx={{
              bgcolor: '#1f7a4d',
              color: '#fff',
              '&:hover': { bgcolor: '#288c5b' },
            }}
          >
            {isMyPilotedShip ? 'Piloting' : 'Spawn'}
          </Button>
        </Box>
      </DialogActions>

      {/* Phase 5 — switch-active-ship confirm. Fires when the player is
          in-game and clicks Spawn on a different (non-active) hull.
          Bypassed entirely on the post-auth galaxy-map landing screen
          since that flow IS first-spawn / sector-pick. */}
      {confirmSwitch && (
        <Dialog
          open
          onClose={handleSwitchCancel}
          maxWidth="xs"
          fullWidth
          data-testid="ship-detail-switch-confirm"
          PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #2a4f30' } }}
        >
          <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88', fontSize: 14 }}>
            Switch ships?
          </DialogTitle>
          <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
            <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.5 }}>
              Your current ship will be parked where it is. You&apos;ll spawn
              as {kind.displayName} in {ship.sectorKey}.
            </Typography>
          </DialogContent>
          <DialogActions sx={{ bgcolor: '#0c1020', justifyContent: 'flex-end', gap: 1, px: 2.5, pb: 2 }}>
            <Button
              onClick={handleSwitchCancel}
              sx={{ color: '#9aa0b4' }}
              data-testid="ship-detail-switch-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSwitchConfirm}
              variant="contained"
              data-testid="ship-detail-switch-confirm-button"
              sx={{
                bgcolor: '#1f7a4d',
                color: '#fff',
                '&:hover': { bgcolor: '#288c5b' },
              }}
            >
              Switch
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Phase 5 — abandon confirm. Mounted only while open so the
          testid disappears from the DOM after Cancel. Active ships
          get a stronger warning ("ejects to galaxy map"); stored ships
          get a plain "Abandon {name}?" prompt. */}
      {confirmAbandon && (
        <Dialog
          open
          onClose={handleAbandonCancel}
          maxWidth="xs"
          fullWidth
          data-testid={isMyPilotedShip ? 'ship-detail-abandon-active-confirm' : 'ship-detail-abandon-confirm'}
          PaperProps={{ sx: { bgcolor: '#0c1020', border: '1px solid #5a2030' } }}
        >
          <DialogTitle sx={{ bgcolor: '#0c1020', color: '#ff5566', fontSize: 14 }}>
            {isMyPilotedShip ? 'Abandon active ship?' : `Abandon ${kind.displayName}?`}
          </DialogTitle>
          <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
            <Typography variant="body2" sx={{ fontSize: 12, lineHeight: 1.5 }}>
              {isMyPilotedShip
                ? 'This is your active ship — abandoning will eject you to the galaxy map. Continue?'
                : 'The hull will shatter into scrap. This cannot be undone.'}
            </Typography>
          </DialogContent>
          <DialogActions sx={{ bgcolor: '#0c1020', justifyContent: 'flex-end', gap: 1, px: 2.5, pb: 2 }}>
            <Button
              onClick={handleAbandonCancel}
              sx={{ color: '#9aa0b4' }}
              data-testid={isMyPilotedShip ? 'ship-detail-abandon-active-cancel' : 'ship-detail-abandon-cancel'}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAbandonConfirm}
              variant="contained"
              data-testid={isMyPilotedShip ? 'ship-detail-abandon-active-confirm-button' : 'ship-detail-abandon-confirm-button'}
              sx={{
                bgcolor: '#5a2030',
                color: '#fff',
                '&:hover': { bgcolor: '#7a2840' },
              }}
            >
              Abandon
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Dialog>
  );
}

function StatChip({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <Chip
      size="small"
      label={`${label} ${value}`}
      sx={{
        bgcolor: 'rgba(0,255,136,0.06)',
        color: '#cde',
        height: 22,
        '& .MuiChip-label': { px: 1, fontSize: 11 },
      }}
    />
  );
}

function StatRow({ label, value, testid }: { label: string; value: string; testid?: string }): JSX.Element {
  return (
    <>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Typography variant="caption" data-testid={testid} sx={{ color: '#cde' }}>
        {value}
      </Typography>
    </>
  );
}
