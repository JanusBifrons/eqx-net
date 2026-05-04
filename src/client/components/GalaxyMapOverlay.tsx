import { useCallback, useMemo } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { HexGalaxyMap } from './HexGalaxyMap';
import { useUIStore } from '../state/store';
import { GALAXY_SECTORS, getSector, isNeighbour } from '../../core/galaxy/galaxy';

interface GalaxyMapOverlayProps {
  open: boolean;
  onClose: () => void;
  /** Fired when the player picks a neighbour to transit to. */
  onTransit: (targetSectorKey: string) => void;
}

/**
 * Phase 8 sub-phase B — in-game galaxy-map overlay.
 *
 * Reuses [HexGalaxyMap] (from sub-phase A's landing screen) configured for
 * the in-game flow:
 *   - `highlightKey` = current sector ("you are here")
 *   - `selectableKeys` = direct neighbours of the current sector. Non-
 *     adjacent sectors render dimmed and are non-clickable. Defence-
 *     in-depth: the server orchestrator also rejects non-neighbour transit
 *     attempts with `reason: 'not_neighbour'`.
 *
 * Disabled while `transitState !== 'DOCKED'` (the HyperspaceOverlay covers
 * the screen during SPOOLING/IN_TRANSIT/ARRIVED). Engineering rooms have
 * `currentSectorKey === null` and so render with no selectable hexes —
 * effectively read-only for those flows.
 */
export function GalaxyMapOverlay({ open, onClose, onTransit }: GalaxyMapOverlayProps): JSX.Element | null {
  const currentSectorKey = useUIStore((s) => s.currentSectorKey);
  const transitState     = useUIStore((s) => s.transitState);

  const selectableKeys = useMemo<string[]>(() => {
    if (transitState !== 'DOCKED') return [];
    if (!currentSectorKey) return [];
    const cur = getSector(currentSectorKey);
    if (!cur) return [];
    return cur.neighbours.filter((k) => isNeighbour(currentSectorKey, k));
  }, [currentSectorKey, transitState]);

  const handleSelect = useCallback(
    (key: string) => {
      onTransit(key);
      onClose();
    },
    [onTransit, onClose],
  );

  if (!open) return null;

  const cur = currentSectorKey ? getSector(currentSectorKey) : null;
  const subtitle = transitState !== 'DOCKED'
    ? 'Transit in progress — map is read-only.'
    : cur
      ? `You are in ${cur.name}. Select a neighbouring sector to engage hyperspace.`
      : currentSectorKey
        ? 'Unknown sector.'
        : 'Engineering room — galaxy transit unavailable.';

  return (
    <Box
      data-testid="galaxy-map-overlay"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        bgcolor: 'rgba(5,7,15,0.94)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        pt: 6,
      }}
    >
      <IconButton
        aria-label="close"
        onClick={onClose}
        sx={{ position: 'absolute', top: 12, right: 12, color: '#9aa0b4' }}
      >
        <CloseIcon />
      </IconButton>

      <Typography variant="h5" sx={{ color: '#00ff88', letterSpacing: 4, textTransform: 'uppercase' }}>
        Galaxy Map
      </Typography>
      <Typography variant="caption" sx={{ color: '#9aa0b4', mt: 0.5, mb: 2, textAlign: 'center', maxWidth: 600 }}>
        {subtitle}
      </Typography>

      <Box sx={{ width: 'min(720px, 90vw)', height: 'min(520px, 60vh)' }}>
        <HexGalaxyMap
          selectableKeys={selectableKeys}
          highlightKey={currentSectorKey ?? null}
          onSelect={handleSelect}
        />
      </Box>

      <Box sx={{ mt: 2, display: 'flex', gap: 2, color: '#666', fontSize: 11 }}>
        <Typography variant="caption" sx={{ color: '#888' }}>
          {GALAXY_SECTORS.length} sectors, {selectableKeys.length} reachable from here.
        </Typography>
      </Box>
    </Box>
  );
}
