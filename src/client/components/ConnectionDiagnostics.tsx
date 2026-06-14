import { Box, Typography } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Connection / world-population diagnostics.
 *
 * Lives inside the AdvancedDrawer's Dev tab. Hosts the data that used to
 * be always-visible HUD chips (connection status, clock rate, server tick
 * Hz, ship count, swarm count, correction rate, player ID).
 *
 * The `data-testid` attributes are preserved exactly so the existing E2E
 * suite (feel-test-lockstep, swarm-tidi, tidi-overlay, etc.) keeps working.
 * The drawer uses `ModalProps={{ keepMounted: true }}` so this panel stays
 * in the DOM even when the drawer is closed — Playwright queries that read
 * `textContent` continue to succeed.
 */
export function ConnectionDiagnostics(): JSX.Element {
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const clockRate = useUIStore((s) => s.clockRate);
  const serverTickHz = useUIStore((s) => s.serverTickHz);
  const shipCount = useUIStore((s) => s.shipCount);
  const swarmCount = useUIStore((s) => s.swarmCount);
  const correctionRate = useUIStore((s) => s.correctionRate);
  const devData = useUIStore((s) => s.devData);

  return (
    <Box
      sx={{
        bgcolor: 'rgba(0,0,0,0.6)',
        color: '#dde',
        fontFamily: 'monospace',
        fontSize: 11,
        p: 1,
        borderRadius: 1,
        lineHeight: 1.6,
      }}
    >
      <Typography variant="overline" sx={{ color: '#0f8', fontWeight: 'bold', display: 'block' }}>
        ── Connection ──
      </Typography>
      <Row label="Status" value={connectionStatus} valueColor={connectionStatus === 'connected' ? '#0f8' : '#f44'} />
      <Row
        label="Clock"
        value={`${clockRate.toFixed(2)}×`}
        testid="clock-rate"
        valueColor={clockRate >= 0.99 ? '#0f8' : clockRate >= 0.85 ? '#ff0' : '#f44'}
      />
      <Row
        label="Server Hz"
        value={serverTickHz.toFixed(0)}
        testid="server-tick-hz"
        valueColor={serverTickHz >= 55 ? '#0f8' : serverTickHz >= 40 ? '#ff0' : '#f44'}
      />

      <Typography variant="overline" sx={{ color: '#0f8', fontWeight: 'bold', display: 'block', mt: 1 }}>
        ── World ──
      </Typography>
      <Row label="Ships" value={`Ships: ${shipCount}`} testid="ship-count" rawValue />
      <Row label="Swarm" value={`Swarm: ${swarmCount}`} testid="swarm-count" rawValue />
      <Row
        label="Corr"
        value={`${devData.significantCorrectionCount}/${devData.snapshotCount} (${(correctionRate * 100).toFixed(0)}%)`}
        valueColor={correctionRate === 0 ? '#0f8' : correctionRate < 0.2 ? '#ff0' : '#f44'}
      />
    </Box>
  );
}

interface RowProps {
  label: string;
  value: string;
  valueColor?: string;
  testid?: string;
  /** When true, the value already contains the label-style prefix (e.g.
   *  "Ships: 12") — render the value alone in the value cell so the
   *  textContent matches what existing E2E tests expect to parse. */
  rawValue?: boolean;
}

function Row({ label, value, valueColor, testid, rawValue }: RowProps): JSX.Element {
  if (rawValue) {
    return (
      <Box
        data-testid={testid}
        sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}
      >
        <span style={{ color: valueColor ?? '#dde' }}>{value}</span>
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span data-testid={testid} style={{ color: valueColor ?? '#dde' }}>
        {value}
      </span>
    </Box>
  );
}
