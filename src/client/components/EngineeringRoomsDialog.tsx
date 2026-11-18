import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';

interface EngineeringRoom {
  roomName: string;
  label: string;
  description: string;
}

const ENGINEERING_ROOMS: EngineeringRoom[] = [
  { roomName: 'sector',          label: 'Sector (legacy)',     description: 'Original Phase-1..7 default room. 30-drone hostile ring, no persistence.' },
  { roomName: 'test-sector',     label: 'Test Sector',         description: 'Deterministic E2E room. Zero drones, zero asteroids.' },
  { roomName: 'shield-test',     label: 'Shield Test (5)',     description: 'Five non-hostile drones (one of each non-fighter kind) in a 200 u ring. Ram + shoot to verify shield bubble math. Drones only turn hostile after they take damage.' },
  { roomName: 'hull-collision-test', label: 'Hull Collision (T-pair)', description: 'Two stationary Crossguard T-ships, shields off, stem-tips facing with a 20 u gap. Bounding circles overlap massively but polygon hulls do NOT touch. Negative control for concave-hull collision correctness — server log should show NO collision_resolved between the pair.' },
  { roomName: 'hull-collision-overlap-test', label: 'Hull Collision (overlap +control)', description: 'Two Crossguards stacked at (0,0), shields off. POSITIVE control: polygons fully overlap so collision_resolved + ram_damage must fire constantly. If they do NOT, the test surface is dead.' },
  { roomName: 'mount-test',      label: 'Mount Test (6)',      description: 'Phase 4c turret refactor room. 6 interceptor+gunship drones in a 250 u ring for verifying rotating-mount visuals.' },
  { roomName: 'feel-test',       label: 'Feel Test (10)',      description: 'AI lockstep / network-feel test room. 10 drones in a 300 u ring around origin; player spawns at (0,0).' },
  { roomName: 'swarm-soak',      label: 'Swarm Soak (500)',    description: 'Phase 5e bandwidth + perf soak. 500 mixed entities. Stress room — server can hitch under combat.' },
  { roomName: 'swarm-tidi',      label: 'Swarm TiDi (4000)',   description: 'Phase 6 stress room. 4000 entities; TiDi rarely engages.' },
  { roomName: 'swarm-tidi-burn', label: 'Swarm TiDi (burn)',   description: 'Phase 6 synthetic burn. Forces TiDi to ramp to its 0.7× floor.' },
];

/** The galaxy map's "Engineering rooms" dialog: dev/test rooms with no
 *  persistence, plus (dev builds) the Visual FX Sandbox link. */
export function EngineeringRoomsDialog({ open, onClose, onSelectRoom }: {
  open: boolean;
  onClose: () => void;
  onSelectRoom?: (roomName: string) => void;
}): JSX.Element {
  return (
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
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
                onClick={() => onSelectRoom?.(r.roomName)}
                data-testid={`engineering-room-${r.roomName}`}
              >
                <Typography variant="subtitle2" sx={{ color: '#00ff88' }}>{r.label}</Typography>
                <Typography variant="caption" sx={{ color: '#888' }}>{r.description}</Typography>
              </Box>
            ))}
            {import.meta.env.DEV && (
              <Box component="a" href="/__offscreen-spike__/visual-effects-sandbox.html" data-testid="engineering-sandbox-link" sx={{ color: '#88ddff', fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', textDecoration: 'none' }}>
                Visual FX Sandbox →
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ bgcolor: '#0c1020' }}>
          <Button onClick={onClose} sx={{ color: '#9aa0b4' }}>Close</Button>
        </DialogActions>
      </Dialog>
  );
}
