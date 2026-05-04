import { useState, useMemo, useCallback } from 'react';
import { Box, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Stack, Alert } from '@mui/material';
import { HexGalaxyMap } from './HexGalaxyMap';
import { GALAXY_SECTORS, getSector } from '../../core/galaxy/galaxy';

interface GalaxyMapScreenProps {
  /** Sub-phase B will pass the active Limbo entry here. Sub-phase A: always null. */
  activeLimboSectorKey?: string | null;
  /** Called with the selected room name (e.g. 'galaxy-sol-prime' or 'test-sector'). */
  onSelectRoom: (roomName: string) => void;
  /** Called when the user picks the local-only single-player diagnostic. */
  onSelectLocal: () => void;
}

interface EngineeringRoom {
  roomName: string;
  label: string;
  description: string;
}

const ENGINEERING_ROOMS: EngineeringRoom[] = [
  { roomName: 'sector',          label: 'Sector (legacy)',     description: 'Original Phase-1..7 default room. 30-drone hostile ring, no persistence.' },
  { roomName: 'test-sector',     label: 'Test Sector',         description: 'Deterministic E2E room. Zero drones, zero asteroids.' },
  { roomName: 'swarm-soak',      label: 'Swarm Soak (500)',    description: 'Phase 5e bandwidth + perf soak. 500 mixed entities.' },
  { roomName: 'swarm-tidi',      label: 'Swarm TiDi (4000)',   description: 'Phase 6 stress room. 4000 entities; TiDi rarely engages.' },
  { roomName: 'swarm-tidi-burn', label: 'Swarm TiDi (burn)',   description: 'Phase 6 synthetic burn. Forces TiDi to ramp to its 0.7× floor.' },
];

export function GalaxyMapScreen({
  activeLimboSectorKey,
  onSelectRoom,
  onSelectLocal,
}: GalaxyMapScreenProps): JSX.Element {
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // If the player has an active Limbo entry, only their existing-ship sector
  // is selectable; otherwise all 7 are. (Sub-phase A always passes null.)
  const selectableKeys: readonly string[] = useMemo(() => {
    if (activeLimboSectorKey) return [activeLimboSectorKey];
    return GALAXY_SECTORS.map((s) => s.key);
  }, [activeLimboSectorKey]);

  const handleSelect = useCallback(
    (key: string) => {
      onSelectRoom(`galaxy-${key}`);
    },
    [onSelectRoom],
  );

  const limboSector = activeLimboSectorKey ? getSector(activeLimboSectorKey) : null;
  const hovered = hoveredKey ? getSector(hoveredKey) : null;

  return (
    <Box
      data-testid="galaxy-map-screen"
      sx={{
        position: 'fixed',
        inset: 0,
        pt: '48px', // AppHeader spacer
        bgcolor: '#05070f',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', pt: 2, pb: 1, gap: 0.5 }}>
        <Typography variant="h3" sx={{ color: '#00ff88', fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase' }}>
          EQX Peri
        </Typography>
        <Typography variant="caption" sx={{ color: '#888', letterSpacing: 2, textTransform: 'uppercase' }}>
          Galaxy Map · Select a sector to enter
        </Typography>
      </Box>

      {limboSector && (
        <Alert
          severity="info"
          sx={{ mx: 'auto', mt: 1, mb: 0, bgcolor: 'rgba(0,255,136,0.08)', color: '#00ff88', border: '1px solid #1f7a4d' }}
          data-testid="limbo-resume-banner"
        >
          Resume your ship in {limboSector.name}.
        </Alert>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 2,
        }}
        onMouseMove={(e) => {
          // Hover detection delegated to the SVG layer's data-sector-key attrs.
          const t = e.target as Element | null;
          if (!t) return;
          const node = (t.closest?.('[data-sector-key]') ?? null) as HTMLElement | null;
          setHoveredKey(node?.dataset['sectorKey'] ?? null);
        }}
        onMouseLeave={() => setHoveredKey(null)}
      >
        <Box sx={{ width: 'min(900px, 95vw)', height: 'min(700px, 70vh)' }}>
          <HexGalaxyMap
            selectableKeys={selectableKeys}
            highlightKey={activeLimboSectorKey ?? null}
            onSelect={handleSelect}
          />
        </Box>
      </Box>

      <Box
        sx={{
          minHeight: 60,
          px: 3,
          pb: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {hovered ? (
          <Typography variant="body2" sx={{ color: '#9aa0b4', maxWidth: 600, textAlign: 'center' }}>
            <strong style={{ color: '#00ff88' }}>{hovered.name}</strong> — {hovered.description}
          </Typography>
        ) : (
          <Typography variant="caption" sx={{ color: '#555' }}>
            Hover a sector for details. {limboSector ? '' : 'Click any sector to drop in.'}
          </Typography>
        )}
      </Box>

      <Stack
        direction="row"
        spacing={2}
        sx={{
          position: 'absolute',
          bottom: 16,
          right: 16,
          alignItems: 'center',
        }}
      >
        <Button
          variant="text"
          size="small"
          onClick={onSelectLocal}
          sx={{ color: '#ff8800', '&:hover': { bgcolor: 'rgba(255,136,0,0.08)' } }}
          data-testid="single-player-button"
        >
          Single-Player Diagnostic
        </Button>
        <Button
          variant="outlined"
          size="small"
          onClick={() => setEngineeringOpen(true)}
          sx={{ color: '#9aa0b4', borderColor: '#2a2f40', '&:hover': { borderColor: '#9aa0b4' } }}
          data-testid="engineering-rooms-button"
        >
          Engineering rooms
        </Button>
      </Stack>

      <Dialog open={engineeringOpen} onClose={() => setEngineeringOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ bgcolor: '#0c1020', color: '#00ff88' }}>Engineering rooms</DialogTitle>
        <DialogContent sx={{ bgcolor: '#0c1020', color: '#ccc' }}>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Engineering rooms have no persistence. Disconnects lose all state.
          </Alert>
          <Stack spacing={1.5}>
            {ENGINEERING_ROOMS.map((r) => (
              <Box
                key={r.roomName}
                sx={{
                  p: 1.5,
                  border: '1px solid #2a2f40',
                  borderRadius: 1,
                  cursor: 'pointer',
                  '&:hover': { borderColor: '#1f7a4d', bgcolor: 'rgba(0,255,136,0.04)' },
                }}
                onClick={() => onSelectRoom(r.roomName)}
                data-testid={`engineering-room-${r.roomName}`}
              >
                <Typography variant="subtitle2" sx={{ color: '#00ff88' }}>{r.label}</Typography>
                <Typography variant="caption" sx={{ color: '#888' }}>{r.description}</Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ bgcolor: '#0c1020' }}>
          <Button onClick={() => setEngineeringOpen(false)} sx={{ color: '#9aa0b4' }}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
