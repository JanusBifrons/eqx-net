import { useEffect, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { useUIStore } from '../state/store.js';
import { logEvent } from '../debug/ClientLogger.js';
import { useMountLog } from '../debug/useMountLog.js';

const AUTO_RETURN_SECONDS = 15;
/** Wait this long after `connectionStatus` becomes disconnected/error
 *  before actually showing the overlay. A brief blip + recovery within
 *  this window never paints anything — avoids flicker. */
export const SHOW_DEBOUNCE_MS = 2_000;
/** Wait this long after `connectionStatus` recovers before hiding
 *  the overlay. Prevents the "blink" pattern where a connection
 *  bounces between connected → disconnected → connected very rapidly. */
export const HIDE_DEBOUNCE_MS = 1_500;

/**
 * Show-stopping full-screen overlay for in-game connection loss
 * (2026-05-13 smoke-test request).
 *
 * Visible iff phase is `'game'` AND `connectionStatus` is
 * `'disconnected' | 'error'` for at least {@link SHOW_DEBOUNCE_MS}.
 * Hides only after the connection has been recovered for at least
 * {@link HIDE_DEBOUNCE_MS}. This hysteresis means a 1-second cell-
 * tower hop / WS reconnect blip never paints the overlay; only
 * genuinely-sustained loss does.
 *
 * Distinct from the pre-game `MetaLandingScreen` banner:
 *   - Pre-game (`phase !== 'game'`): the banner gates the Join CTA.
 *   - In-game (this component): full-screen takeover, no gameplay
 *     interaction possible.
 *
 * Auto-return: while visible, a {@link AUTO_RETURN_SECONDS} countdown
 * routes the player back to the meta landing. Manual "Return to menu"
 * button is the immediate-exit alternative.
 */
export function LostConnectionOverlay(): JSX.Element | null {
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const phase = useUIStore((s) => s.phase);
  const setPhase = useUIStore((s) => s.setPhase);
  const isDisconnected = connectionStatus === 'disconnected' || connectionStatus === 'error';
  const isInGame = phase === 'game';
  const wantsVisible = isDisconnected && isInGame;

  // Debounced "visible" state. Transitions to match `wantsVisible`
  // after the appropriate debounce window — show timer cancelled by a
  // recovery within SHOW_DEBOUNCE_MS, hide timer cancelled by a
  // re-drop within HIDE_DEBOUNCE_MS.
  const [visible, setVisible] = useState(false);
  const [remaining, setRemaining] = useState<number>(AUTO_RETURN_SECONDS);

  useMountLog('LostConnectionOverlay');

  // Debounced visibility transition. Runs whenever wantsVisible diverges
  // from visible; the cleanup cancels the pending timer so a flap back
  // to the target state never reaches setVisible.
  useEffect(() => {
    if (wantsVisible === visible) return;
    const delay = wantsVisible ? SHOW_DEBOUNCE_MS : HIDE_DEBOUNCE_MS;
    const id = window.setTimeout(() => {
      setVisible(wantsVisible);
      if (wantsVisible) {
        logEvent('lost_connection_overlay_shown', { connectionStatus });
      } else {
        logEvent('lost_connection_overlay_hidden', { connectionStatus });
      }
    }, delay);
    return () => window.clearTimeout(id);
  }, [wantsVisible, visible, connectionStatus]);

  // Auto-return countdown — runs only while the overlay is actually
  // visible (post-debounce). Resets to AUTO_RETURN_SECONDS each time
  // the overlay opens.
  useEffect(() => {
    if (!visible) {
      setRemaining(AUTO_RETURN_SECONDS);
      return;
    }
    const id = window.setInterval(() => {
      setRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  // Side-effect on countdown expiry. Split from the interval effect so
  // we don't call setPhase inside a setRemaining updater (React warns
  // about cross-component setState during render).
  useEffect(() => {
    if (visible && remaining === 0) {
      logEvent('lost_connection_overlay_auto_return', {});
      setPhase('meta');
    }
  }, [visible, remaining, setPhase]);

  if (!visible) return null;

  const handleReturnClick = (): void => {
    logEvent('lost_connection_overlay_manual_return', {});
    setPhase('meta');
  };

  return (
    <Box
      data-testid="lost-connection-overlay"
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999, // above everything — joystick, drawer, HUD
        bgcolor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        px: 3,
      }}
    >
      <Box
        sx={{
          maxWidth: 480,
          width: '100%',
          border: '2px solid #ff3333',
          borderRadius: 2,
          bgcolor: 'rgba(0, 0, 0, 0.55)',
          p: 3,
          textAlign: 'center',
          boxShadow: '0 0 30px rgba(255, 51, 51, 0.4)',
        }}
      >
        <Typography
          variant="h5"
          sx={{
            color: '#ff3333',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 2,
            mb: 2,
          }}
        >
          Warning: Lost connection to server.
        </Typography>
        <Typography
          variant="body2"
          sx={{ color: '#ffaaaa', mb: 3 }}
          data-testid="lost-connection-countdown"
        >
          Returning to main menu in {remaining}s
        </Typography>
        <Button
          data-testid="lost-connection-return-button"
          variant="outlined"
          onClick={handleReturnClick}
          sx={{
            color: '#ff3333',
            borderColor: '#ff3333',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 1,
            '&:hover': {
              bgcolor: 'rgba(255, 51, 51, 0.12)',
              borderColor: '#ff6666',
            },
          }}
        >
          Return to menu now
        </Button>
      </Box>
    </Box>
  );
}
