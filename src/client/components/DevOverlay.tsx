import { Box } from '@mui/material';
import { useUIStore } from '../state/store';

/**
 * Dev-only sync diagnostics card. RTT, drift, ack/server tick deltas,
 * server-ghost vs predicted positions.
 *
 * Lives inside the AdvancedDrawer's "Dev" tab. The `showDevOverlay` Zustand
 * flag still gates visibility — toggle it from `SettingsModal` (or the
 * keybinding) and this card hides without closing the drawer.
 */
export function DevOverlay(): JSX.Element | null {
  const showDevOverlay = useUIStore((s) => s.showDevOverlay);
  const devData = useUIStore((s) => s.devData);
  const healthStats = useUIStore((s) => s.healthStats);
  if (!showDevOverlay) return null;

  const corrRate = devData.snapshotCount > 0
    ? ((devData.significantCorrectionCount / devData.snapshotCount) * 100).toFixed(0)
    : '0';
  const f = (n: number): string => n.toFixed(2);

  return (
    <Box
      data-testid="dev-overlay"
      sx={{
        bgcolor: 'rgba(0,0,0,0.82)',
        color: '#0f0',
        fontFamily: 'monospace',
        fontSize: 11,
        p: 1,
        borderRadius: 1,
        lineHeight: 1.6,
        minWidth: 260,
      }}
    >
      <div style={{ color: '#0f8', fontWeight: 'bold' }}>── Sync ──</div>
      <div>RTT: {devData.rtt} ms</div>
      <div>Drift: {devData.drift.toFixed(4)} u  Max: {devData.maxDriftUnits.toFixed(4)} u</div>
      <div style={{ color: devData.significantCorrectionCount / Math.max(1, devData.snapshotCount) > 0.05 ? '#f44' : '#0f0' }}>
        Corrections: {devData.significantCorrectionCount}/{devData.snapshotCount} ({corrRate}%)
      </div>
      <div>Lerping: {devData.lerping ? 'yes' : 'no'}</div>
      <div style={{ borderTop: '1px solid #0f04', marginTop: 4, paddingTop: 4, color: '#0f8', fontWeight: 'bold' }}>── Ticks ──</div>
      <div>ackedTick: {devData.ackedTick}  inputTick: {devData.inputTick}</div>
      <div style={{ color: devData.ticksAhead > 10 ? '#ff0' : '#0f0' }}>
        ticksAhead: {devData.ticksAhead}  serverTick: {devData.serverTick}
      </div>
      <div>Snap interval: {devData.snapshotIntervalMs.toFixed(0)} ms</div>
      <div style={{ borderTop: '1px solid #0f04', marginTop: 4, paddingTop: 4, color: '#0f8', fontWeight: 'bold' }}>── Positions ──</div>
      <div style={{ color: '#ff6622' }}>Server(ghost): ({f(devData.serverX)}, {f(devData.serverY)})</div>
      <div>Before: ({f(devData.beforeX)}, {f(devData.beforeY)})</div>
      <div>After:  ({f(devData.afterX)}, {f(devData.afterY)})</div>
      <div style={{ borderTop: '1px solid #0f04', marginTop: 4, paddingTop: 4, color: '#0f8', fontWeight: 'bold' }}>── Health (30 s) ──</div>
      <div data-testid="dev-health-server-gc" style={{ color: healthStats.serverGc.count30s > 5 ? '#ff0' : '#0f0' }}>
        ServerGC: {healthStats.serverGc.count30s} pauses  max {healthStats.serverGc.maxMs30s.toFixed(1)} ms
      </div>
      <div data-testid="dev-health-longtask" style={{ color: healthStats.longtask.count30s > 10 ? '#ff0' : '#0f0' }}>
        Longtask: {healthStats.longtask.count30s} blocks  max {healthStats.longtask.maxMs30s.toFixed(1)} ms
      </div>
    </Box>
  );
}
