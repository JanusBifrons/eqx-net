import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Snackbar,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import HexagonOutlinedIcon from '@mui/icons-material/HexagonOutlined';
import { useUIStore, type ArrivalMode } from '../../../state/store';
import { getSector } from '../../../../core/galaxy/galaxy';
import { getGameClient } from '../../../net/clientSingleton';
import {
  SECTOR_PLAYABLE_HALF_EXTENT,
  clampToSectorBounds,
} from '../../../../shared-types/sectorBounds';

/**
 * Mobile-drawer Galaxy tab.
 *
 * Replaces the floating MAP button (removed from `MobileControls`). Below
 * the "Show galaxy map" button is the **arrival picker**: three modes for
 * where the ship lands when you warp.
 *
 *  - **X/Y**  — editable target coords (clamped to ±SECTOR_PLAYABLE_HALF_EXTENT
 *               on blur, with a toast warning when the value snaps).
 *  - **Same** — read-only display of the local ship's current x/y, polled
 *               from the render mirror every 5 s. Server falls back to
 *               departure pose when no `arrival` is sent (legacy default).
 *  - **Home** — read-only "home" coord, today hardcoded to 0/0 by the UI;
 *               persisted per-user so a future feature can let the player
 *               pick their own.
 *
 * The map is read-only / disabled while the transit lifecycle is active —
 * the in-game `GalaxyOverviewScreen` (warp-mode) and the additive
 * `GalaxyMapLayer` both reflect the same disabled state internally, but we
 * surface the reason here so the user understands why the button is inert.
 */

const POLL_INTERVAL_MS = 5_000;

export function GalaxyTab(): JSX.Element {
  const transitState   = useUIStore((s) => s.transitState);
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const setGalaxyOverviewOpen = useUIStore((s) => s.setGalaxyOverviewOpen);
  const setDrawerOpen    = useUIStore((s) => s.setDrawerOpen);
  const arrivalMode      = useUIStore((s) => s.arrivalMode);
  const arrivalTargetX   = useUIStore((s) => s.arrivalTargetX);
  const arrivalTargetY   = useUIStore((s) => s.arrivalTargetY);
  const homePosX         = useUIStore((s) => s.homePosX);
  const homePosY         = useUIStore((s) => s.homePosY);
  const setArrivalMode   = useUIStore((s) => s.setArrivalMode);
  const setArrivalTarget = useUIStore((s) => s.setArrivalTarget);
  const isDrawerOpen     = useUIStore((s) => s.isDrawerOpen);
  const drawerTab        = useUIStore((s) => s.drawerTab);

  const sector = currentSectorKey ? getSector(currentSectorKey) : null;
  const inTransit = transitState !== 'DOCKED';

  // 5-second snapshot of the local ship's current x/y, used in `same` mode
  // to show "where you are right now". Stored in component-local state to
  // keep spatial reads out of Zustand (per src/client/CLAUDE.md invariant
  // #2). Polling only runs when this tab is the visible one.
  const [snapshot, setSnapshot] = useState<{ x: number; y: number } | null>(null);
  const tabVisible = isDrawerOpen && drawerTab === 'galaxy';
  useEffect(() => {
    if (!tabVisible || arrivalMode !== 'same') {
      setSnapshot(null);
      return;
    }
    const read = (): void => {
      const c = getGameClient();
      const id = c?.mirror.localPlayerId;
      const ship = id ? c?.mirror.ships.get(id) : null;
      setSnapshot(ship ? { x: ship.x, y: ship.y } : null);
    };
    read();
    const handle = window.setInterval(read, POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [tabVisible, arrivalMode]);

  // Local string buffers for the XY inputs so the user can type intermediate
  // values like "-" / "-5" without us trying to parseFloat each keystroke.
  // Re-synced from the store when mode changes or the store value updates
  // from outside (e.g. clamp on blur, persistence rehydration).
  const [xInput, setXInput] = useState<string>('0');
  const [yInput, setYInput] = useState<string>('0');
  useEffect(() => {
    if (arrivalMode === 'xy') {
      setXInput(formatNumber(arrivalTargetX));
      setYInput(formatNumber(arrivalTargetY));
    } else if (arrivalMode === 'home') {
      setXInput(formatNumber(homePosX));
      setYInput(formatNumber(homePosY));
    } else {
      setXInput(formatNumber(snapshot?.x ?? 0));
      setYInput(formatNumber(snapshot?.y ?? 0));
    }
  }, [arrivalMode, arrivalTargetX, arrivalTargetY, homePosX, homePosY, snapshot]);

  const [toastOpen, setToastOpen] = useState(false);
  const lastToastRef = useRef<string>('');

  const onShowMap = (): void => {
    setGalaxyOverviewOpen(true);
    setDrawerOpen(false);
  };

  const onModeChange = (_e: unknown, next: ArrivalMode | null): void => {
    if (!next) return; // user clicked the already-selected pill — keep current
    setArrivalMode(next);
  };

  const commitXY = (): void => {
    if (arrivalMode !== 'xy') return;
    const xRaw = parseFloat(xInput);
    const yRaw = parseFloat(yInput);
    const xN = Number.isFinite(xRaw) ? xRaw : 0;
    const yN = Number.isFinite(yRaw) ? yRaw : 0;
    const result = clampToSectorBounds(xN, yN);
    setArrivalTarget(result.x, result.y);
    setXInput(formatNumber(result.x));
    setYInput(formatNumber(result.y));
    if (result.clamped) {
      lastToastRef.current = `Arrival clamped to sector bounds (±${SECTOR_PLAYABLE_HALF_EXTENT}).`;
      setToastOpen(true);
    }
  };

  const xyEditable = arrivalMode === 'xy' && !inTransit;

  // Memoised so prop identity doesn't churn on every render.
  const inputProps = useMemo(
    () => ({ inputMode: 'decimal' as const, 'data-testid': '' }),
    [],
  );

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block', mb: 0.5 }}>
          Sector
        </Typography>
        <Typography variant="subtitle1" sx={{ color: '#dde', fontWeight: 600 }}>
          {sector?.name ?? (currentSectorKey ? currentSectorKey : 'Engineering room')}
        </Typography>
        {inTransit && (
          <Typography variant="caption" sx={{ color: '#ff8800', display: 'block', mt: 0.5 }}>
            Transit in progress — map is read-only.
          </Typography>
        )}
      </Box>

      <Button
        fullWidth
        variant="contained"
        startIcon={<HexagonOutlinedIcon />}
        onClick={onShowMap}
        disabled={inTransit}
        data-testid="galaxy-tab-show-map"
        sx={{
          bgcolor: '#00ff88',
          color: '#000',
          fontWeight: 700,
          '&:hover': { bgcolor: '#00cc6a' },
        }}
      >
        Show galaxy map
      </Button>
      <Typography variant="caption" sx={{ color: '#9aa0b4' }}>
        Drag / pinch / scroll to navigate. Tap a neighbouring sector to engage hyperspace.
      </Typography>

      <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Typography variant="overline" sx={{ color: '#9aa0b4', display: 'block' }}>
          Arrival
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          color="primary"
          size="small"
          value={arrivalMode}
          onChange={onModeChange}
          disabled={inTransit}
          data-testid="arrival-mode-toggle"
          sx={{
            '& .MuiToggleButton-root': { color: '#9aa0b4', borderColor: 'rgba(255,255,255,0.15)' },
            '& .Mui-selected': { color: '#00ff88 !important' },
          }}
        >
          <ToggleButton value="xy"   data-testid="arrival-mode-xy">X/Y</ToggleButton>
          <ToggleButton value="same" data-testid="arrival-mode-same">Same</ToggleButton>
          <ToggleButton value="home" data-testid="arrival-mode-home">Home</ToggleButton>
        </ToggleButtonGroup>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField
            size="small"
            label="Arrival X"
            type="number"
            value={xInput}
            disabled={!xyEditable}
            onChange={(e) => setXInput(e.target.value)}
            onBlur={commitXY}
            inputProps={{ ...inputProps, 'data-testid': 'arrival-x-input' }}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            label="Arrival Y"
            type="number"
            value={yInput}
            disabled={!xyEditable}
            onChange={(e) => setYInput(e.target.value)}
            onBlur={commitXY}
            inputProps={{ ...inputProps, 'data-testid': 'arrival-y-input' }}
            sx={{ flex: 1 }}
          />
        </Box>
        <Typography variant="caption" sx={{ color: '#666' }}>
          {arrivalMode === 'xy'   && `Type a target. Clamped to ±${SECTOR_PLAYABLE_HALF_EXTENT} on blur.`}
          {arrivalMode === 'same' && 'Lands at your current position when you warp. Updated every 5 s.'}
          {arrivalMode === 'home' && 'Lands at your home coord on every warp.'}
        </Typography>
      </Box>

      <Snackbar
        open={toastOpen}
        autoHideDuration={3500}
        onClose={() => setToastOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="warning"
          onClose={() => setToastOpen(false)}
          data-testid="arrival-clamp-toast"
          sx={{ width: '100%' }}
        >
          {lastToastRef.current}
        </Alert>
      </Snackbar>
    </Box>
  );
}

/** Format a number for display in the input field — trims trailing zeros
 *  on simple integers, keeps decimals readable. */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
