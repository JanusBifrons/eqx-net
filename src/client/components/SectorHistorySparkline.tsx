import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { SectorHistoryResponseSchema, type SectorHistorySample } from '../../shared-types/galaxySnapshot';
import { factionColor } from '../render/galaxy/galaxyTerritories';
import { sparklinePath } from './sectorSparkline';

const W = 240;
const H = 28;

/**
 * Control over the last hour for the sector in the info panel: fetched once
 * from `GET /galaxy/sector/:key/history` when the panel opens on a sector (no
 * polling, no live stream). Line height = the holder's share; ticks mark a
 * change of hands; the line takes the current holder's colour.
 */
export function SectorHistorySparkline({ sectorKey }: { sectorKey: string }): JSX.Element {
  const [samples, setSamples] = useState<SectorHistorySample[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSamples(null);
    void (async () => {
      try {
        const res = await fetch(`/galaxy/sector/${encodeURIComponent(sectorKey)}/history`);
        if (!res.ok) return;
        const parsed = SectorHistoryResponseSchema.safeParse(await res.json());
        if (!cancelled && parsed.success) setSamples(parsed.data.samples);
      } catch {
        /* network blip: the panel just shows no history */
      }
    })();
    return () => { cancelled = true; };
  }, [sectorKey]);

  const g = samples ? sparklinePath(samples, W, H) : null;
  const color = `#${factionColor(g?.holder ?? '').toString(16).padStart(6, '0')}`;
  return (
    <Box data-testid="sector-drawer-history" data-samples={samples?.length ?? -1} sx={{ mt: 0.75 }}>
      <Typography sx={{ color: '#66ffcc', fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        Control, last hour
      </Typography>
      {g && g.path !== '' ? (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block', marginTop: 2 }}>
          <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#26304a" strokeWidth={1} />
          {g.flips.map((x) => (
            <line key={x} x1={x} y1={0} x2={x} y2={H} stroke="#ff9f43" strokeWidth={1} strokeDasharray="2 2" />
          ))}
          <path d={g.path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
      ) : (
        <Typography sx={{ color: '#6b7280', fontSize: 10, mt: 0.25 }}>
          {samples === null ? 'Loading…' : 'No history yet'}
        </Typography>
      )}
    </Box>
  );
}
