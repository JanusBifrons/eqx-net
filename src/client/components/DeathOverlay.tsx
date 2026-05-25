import { useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { Slot } from '../layout/Slot';
import { useUIStore } from '../state/store';
import { captureDiagnostic } from '../debug/diagCapture';

/**
 * Death / respawn overlay.
 *
 * Extracted from App.tsx (SRP + testability) when the smoke-test feedback
 * loop needed a "Send diagnostics" affordance right where the player most
 * often notices a problem: the moment they die. Capturing from the Debug
 * drawer requires opening a hidden tab mid-frustration; a button on the
 * death screen closes that loop with one tap.
 *
 * `DeathOverlayContent` is exported WITHOUT the `Slot` / `isDead` wrapper
 * so it is unit-testable without a `LayoutProvider` + portal host. The
 * `DeathOverlay` wrapper is the thin glue (identical to the already-
 * shipped Respawn-button wiring).
 */
export function DeathOverlayContent({ onRespawn }: { onRespawn: () => void }): JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [diagStatus, setDiagStatus] = useState<string | null>(null);

  const onSendDiagnostics = async (): Promise<void> => {
    setCapturing(true);
    setDiagStatus('Sending…');
    // Same `stats` source the Debug-tab capture uses (clientSingleton
    // mirrors `gameClient.stats` onto `window.__eqxClient`).
    const stats = (window as unknown as { __eqxClient?: { stats?: Record<string, unknown> } }).__eqxClient?.stats;
    const result = await captureDiagnostic({ note: 'sent from death overlay', stats });
    setCapturing(false);
    setDiagStatus(
      result.noopBecauseStreaming
        ? `Streaming active → ${result.dir ?? '(session unknown)'}`
        : result.ok
          ? `Sent: ${result.dir ?? result.filename ?? '(ok)'}`
          : `Failed: ${result.error ?? 'unknown error'}`,
    );
  };

  return (
    <Box
      data-testid="death-overlay"
      sx={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.65)',
        gap: 3,
      }}
    >
      <Typography
        variant="h2"
        sx={{ color: '#ff3333', fontWeight: 700, letterSpacing: 6, textTransform: 'uppercase', textShadow: '0 0 30px #ff0000' }}
      >
        You Died
      </Typography>
      <Button
        variant="contained"
        size="large"
        onClick={onRespawn}
        sx={{
          bgcolor: '#00ff88',
          color: '#000',
          fontWeight: 700,
          px: 6,
          fontSize: '1.1rem',
          '&:hover': { bgcolor: '#00cc6a' },
        }}
      >
        Respawn
      </Button>
      <Button
        variant="outlined"
        size="small"
        onClick={() => void onSendDiagnostics()}
        disabled={capturing}
        data-testid="death-diag-capture-button"
        sx={{
          color: '#9aa0b4',
          borderColor: '#3a3f55',
          fontSize: 11,
          '&:hover': { borderColor: '#5a6075', bgcolor: 'rgba(255,255,255,0.04)' },
        }}
      >
        {capturing ? 'Sending…' : 'Send diagnostics'}
      </Button>
      {diagStatus && (
        <Typography variant="caption" sx={{ color: '#9aa0b4' }} data-testid="death-diag-capture-status">
          {diagStatus}
        </Typography>
      )}
    </Box>
  );
}

export function DeathOverlay({ onRespawn }: { onRespawn: () => void }): JSX.Element | null {
  const isDead = useUIStore((s) => s.isDead);
  if (!isDead) return null;
  return (
    <Slot anchor="fullscreen" order={10}>
      <DeathOverlayContent onRespawn={onRespawn} />
    </Slot>
  );
}
