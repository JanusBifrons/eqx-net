import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { useUIStore } from '../state/store';

interface EqxLogEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

declare global {
  interface Window {
    __eqxLogs?: EqxLogEntry[];
    __eqxEpoch?: number;
  }
}

/**
 * Live scrolling log of the last 20 correction / snapshot events.
 *
 * Lives inside the AdvancedDrawer's "Dev" tab. The `showLogPanel` Zustand
 * flag gates visibility independently of the drawer being open.
 */
export function LogPanel(): JSX.Element | null {
  const showLogPanel = useUIStore((s) => s.showLogPanel);
  const [entries, setEntries] = useState<EqxLogEntry[]>([]);

  useEffect(() => {
    if (!showLogPanel) return;
    const id = setInterval(() => {
      const all: EqxLogEntry[] = window.__eqxLogs ?? [];
      const relevant = all.filter((e) => e.tag === 'correction' || e.tag === 'snapshot').slice(-20);
      setEntries([...relevant]);
    }, 300);
    return () => clearInterval(id);
  }, [showLogPanel]);

  if (!showLogPanel) return null;

  const epoch = typeof window.__eqxEpoch === 'number' ? window.__eqxEpoch : 0;
  const t0 = entries[0]?.ts ?? 0;

  return (
    <Box
      data-testid="log-panel"
      sx={{
        bgcolor: 'rgba(0,0,0,0.82)',
        color: '#ccc',
        fontFamily: 'monospace',
        fontSize: 10,
        p: 1,
        borderRadius: 1,
        maxHeight: 240,
        overflow: 'auto',
      }}
    >
      <div style={{ color: '#888', marginBottom: 2 }}>
        Log (epoch+{epoch ? ((Date.now() - epoch) / 1000).toFixed(1) : '?'}s) — corrections=orange, snapshots=grey
      </div>
      {entries.map((e, i) => {
        const isCorr = e.tag === 'correction';
        const rel = (e.ts - t0).toFixed(0).padStart(5);
        const color = isCorr ? '#ff6622' : '#667';
        const d = (k: string): string => String(e.data[k] ?? '?');
        return (
          <div key={i} style={{ color }}>
            t+{rel}ms {isCorr ? 'CORR' : 'snap'}  drift={d('driftUnits').slice(0, 8)}  ahead={d('ticksAhead')}  acked={d('ackedTick')}  tick={d('serverTick')}
          </div>
        );
      })}
    </Box>
  );
}
