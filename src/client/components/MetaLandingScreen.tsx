import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';

interface Props {
  onJoin: () => void;
  onSelectLocal?: () => void;
}

/**
 * Pre-game "main menu" landing screen.
 *
 * Shown to everyone (logged-in or not) as the first screen after page load.
 * Single primary CTA `Join the fight!` — `App.tsx` decides whether that
 * routes to LoginPage (logged-out) or galaxy-map (logged-in).
 *
 * The "X players fighting" hype number is **fake** but deterministic per
 * minute — same value across all clients hitting at the same minute, ticks
 * over each minute. Re-renders once a minute via a setInterval.
 */
export function MetaLandingScreen({ onJoin, onSelectLocal }: Props): JSX.Element {
  const [count, setCount] = useState<number>(() => fakePlayerCount());

  useEffect(() => {
    const id = window.setInterval(() => setCount(fakePlayerCount()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Box
      data-testid="meta-landing"
      sx={{
        position: 'fixed',
        inset: 0,
        pt: 'var(--app-bar-h, 48px)',
        bgcolor: '#05070f',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        px: 3,
        textAlign: 'center',
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="h2"
          sx={{
            color: '#00ff88',
            fontWeight: 700,
            letterSpacing: { xs: 4, sm: 8 },
            textTransform: 'uppercase',
            fontSize: { xs: '2.4rem', sm: '3.4rem' },
          }}
        >
          EQX Peri
        </Typography>
        <Typography variant="caption" sx={{ color: '#888', letterSpacing: 3, textTransform: 'uppercase' }}>
          Multiplayer space combat
        </Typography>
      </Box>

      <Box
        data-testid="meta-player-count"
        sx={{
          px: 3,
          py: 1.5,
          border: '1px solid rgba(0, 255, 136, 0.35)',
          borderRadius: 2,
          bgcolor: 'rgba(0, 255, 136, 0.06)',
          maxWidth: 420,
        }}
      >
        <Typography
          variant="body1"
          sx={{ color: '#dde', fontWeight: 600, lineHeight: 1.4 }}
        >
          <span style={{ color: '#00ff88' }} data-testid="meta-player-count-number">
            {count.toLocaleString()}
          </span>{' '}
          players fighting for domination right now
        </Typography>
      </Box>

      <Button
        data-testid="meta-join-button"
        variant="contained"
        size="large"
        startIcon={<RocketLaunchIcon />}
        onClick={onJoin}
        sx={{
          bgcolor: '#00ff88',
          color: '#000',
          fontWeight: 700,
          fontSize: '1.1rem',
          px: 5,
          py: 1.5,
          letterSpacing: 1,
          textTransform: 'uppercase',
          boxShadow: '0 0 24px rgba(0, 255, 136, 0.45)',
          '&:hover': {
            bgcolor: '#00cc6a',
            boxShadow: '0 0 30px rgba(0, 255, 136, 0.65)',
          },
        }}
      >
        Join the fight!
      </Button>

      {onSelectLocal && (
        <Button
          data-testid="meta-local-button"
          variant="text"
          size="small"
          onClick={onSelectLocal}
          sx={{ color: '#ff8800', '&:hover': { bgcolor: 'rgba(255, 136, 0, 0.08)' } }}
        >
          Single-player diagnostic
        </Button>
      )}
    </Box>
  );
}

/**
 * Deterministic fake player count, stable per minute, range 600–900.
 *
 * Same value across all clients hitting at the same minute. Cheap hash of
 * the floor-minute timestamp — no server call, no entropy source needed.
 */
export function fakePlayerCount(now = Date.now()): number {
  const minute = Math.floor(now / 60_000);
  let h = (minute * 2654435761) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return 600 + (h % 300);
}
