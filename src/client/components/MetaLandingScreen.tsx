import { Alert, Box, Button, Typography } from '@mui/material';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import { useUIStore } from '../state/store.js';
import { logEvent } from '../debug/ClientLogger.js';
import { useMountLog } from '../debug/useMountLog.js';

interface Props {
  onJoin: () => void;
  onSelectLocal?: () => void;
}

/**
 * Pre-game "main menu" landing screen.
 *
 * Shown to everyone (logged-in or not) as the first screen after page
 * load. Single primary CTA `Join the fight!` — `App.tsx` decides whether
 * that routes to LoginPage (logged-out) or galaxy-map (logged-in).
 *
 * The "X players fighting" hype number is served by the **server**
 * (`/healthz` response) so all concurrent visitors see the same value;
 * we read it from Zustand where the poller in `App.tsx` writes the
 * latest poll result. Falls back to a placeholder dash when the
 * server hasn't replied yet or is unreachable — at which point the
 * banner is the load-bearing UI surface, not the hype number.
 *
 * The Join CTA is disabled ONLY when the server is `warming` or
 * `unreachable` — `unknown` (the initial state before the first poll
 * completes) is treated optimistically as enabled. If the click then
 * fails, the Colyseus connection-error path surfaces an error to the
 * user. Disabling the button during `unknown` produced a "click does
 * nothing" UX on flaky networks where the first poll takes seconds
 * (2026-05-13 smoke-test feedback).
 */
export function MetaLandingScreen({ onJoin, onSelectLocal }: Props): JSX.Element {
  const serverHealth = useUIStore((s) => s.serverHealth);
  const playersOnline = useUIStore((s) => s.playersOnline);
  // Optimistic gate: unknown ⇒ enabled. Only the two explicit
  // not-ready states block the click.
  const canJoin = serverHealth !== 'warming' && serverHealth !== 'unreachable';

  useMountLog('MetaLandingScreen');

  const handleJoinClick = (): void => {
    logEvent('button_click', {
      name: 'meta-join-button',
      serverHealth,
      playersOnline,
      canJoin,
    });
    onJoin();
  };

  const handleLocalClick = (): void => {
    logEvent('button_click', { name: 'meta-local-button' });
    if (onSelectLocal) onSelectLocal();
  };

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

      <ServerHealthBanner health={serverHealth} />

      <Box
        data-testid="meta-player-count"
        sx={{
          px: 3,
          py: 1.5,
          border: '1px solid rgba(0, 255, 136, 0.35)',
          borderRadius: 2,
          bgcolor: 'rgba(0, 255, 136, 0.06)',
          maxWidth: 420,
          opacity: canJoin ? 1 : 0.5,
        }}
      >
        <Typography
          variant="body1"
          sx={{ color: '#dde', fontWeight: 600, lineHeight: 1.4 }}
        >
          <span style={{ color: '#00ff88' }} data-testid="meta-player-count-number">
            {playersOnline !== null ? playersOnline.toLocaleString() : '—'}
          </span>{' '}
          players fighting for domination right now
        </Typography>
      </Box>

      <Button
        data-testid="meta-join-button"
        variant="contained"
        size="large"
        startIcon={<RocketLaunchIcon />}
        onClick={handleJoinClick}
        disabled={!canJoin}
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
          '&.Mui-disabled': {
            bgcolor: 'rgba(0, 255, 136, 0.15)',
            color: 'rgba(255, 255, 255, 0.4)',
            boxShadow: 'none',
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
          onClick={handleLocalClick}
          sx={{ color: '#ff8800', '&:hover': { bgcolor: 'rgba(255, 136, 0, 0.08)' } }}
        >
          Single-player diagnostic
        </Button>
      )}
    </Box>
  );
}

interface BannerProps {
  health: 'unknown' | 'healthy' | 'warming' | 'unreachable';
}

/**
 * Pre-game server-health banner. Renders nothing while healthy or
 * during the very first probe (`unknown`) so the landing screen looks
 * normal in the steady state. Surfaces both flavours of "not ready":
 * `warming` (server is up but mid-boot) and `unreachable` (no reply).
 */
function ServerHealthBanner({ health }: BannerProps): JSX.Element | null {
  if (health === 'healthy' || health === 'unknown') return null;

  const isWarming = health === 'warming';
  return (
    <Alert
      severity={isWarming ? 'info' : 'error'}
      variant="outlined"
      data-testid="server-health-banner"
      data-state={health}
      sx={{
        maxWidth: 420,
        bgcolor: isWarming ? 'rgba(2, 136, 209, 0.08)' : 'rgba(211, 47, 47, 0.08)',
        color: isWarming ? '#90caf9' : '#ef9a9a',
        '& .MuiAlert-icon': { color: isWarming ? '#90caf9' : '#ef9a9a' },
      }}
    >
      {isWarming
        ? 'Server is starting up — Join will be enabled in a moment.'
        : 'Server unavailable. Reconnecting…'}
    </Alert>
  );
}
