import { useEffect, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { SectorHistoryResponseSchema, type SectorHistorySample } from '../../shared-types/galaxySnapshot';
import { sparklinePath } from './sectorSparkline';

const W = 240;
const H = 44;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const AXIS_SX = { color: '#5d6a85', fontSize: 8, letterSpacing: 0.5, fontFamily: MONO } as const;

/**
 * Control over the last hour for the sector in the info panel: fetched once
 * from `GET /galaxy/sector/:key/history` when the panel opens on a sector (no
 * polling, no live stream). `null` while loading; `[]` when the fetch fails or
 * the sector has no history yet.
 */
export function useSectorHistory(sectorKey: string | null): SectorHistorySample[] | null {
  const [samples, setSamples] = useState<SectorHistorySample[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSamples(null);
    if (sectorKey === null) return undefined;
    void (async () => {
      try {
        const res = await fetch(`/galaxy/sector/${encodeURIComponent(sectorKey)}/history`);
        const parsed = res.ok ? SectorHistoryResponseSchema.safeParse(await res.json()) : null;
        if (!cancelled) setSamples(parsed?.success ? parsed.data.samples : []);
      } catch {
        // Network blip: the panel shows the "history builds up" line, never a gap.
        if (!cancelled) setSamples([]);
      }
    })();
    return () => { cancelled = true; };
  }, [sectorKey]);
  return samples;
}

/**
 * The last-hour sparkline (holder share): a dashed 50 % "changes hands" line,
 * orange ticks where the holder changed, a white dot on the latest point and
 * "<n> MIN AGO" (the minutes the samples cover; 60 once the hour fills) / "NOW"
 * axis labels. Under two samples it shows one quiet line, never an empty box.
 */
export function SectorHistorySparkline({
  samples,
  color,
}: {
  samples: readonly SectorHistorySample[] | null;
  color: string;
}): JSX.Element {
  const g = samples && samples.length >= 2 ? sparklinePath(samples, W, H) : null;
  // The line spans the samples there are: label the left edge with their real age.
  // Each sample stands for a minute, so n samples cover n minutes (60 = the hour).
  const spanMin = samples && samples.length >= 2
    ? Math.min(60, Math.round((samples[samples.length - 1]!.atMs - samples[0]!.atMs) / 60_000) + 1)
    : 0;
  return (
    <Box data-testid="sector-drawer-history" data-samples={samples?.length ?? -1} sx={{ mt: 0.75 }}>
      {g && g.last ? (
        <>
          <Box sx={{ position: 'relative', height: H }}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
              <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#26304a" strokeWidth={1} />
              <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#5d6a85" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              {g.flips.map((x) => (
                <line key={x} x1={x} y1={0} x2={x} y2={H} stroke="#ff9f43" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
              ))}
              <path d={g.path} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
            </svg>
            {/* HTML overlays: SVG text/circles would stretch under preserveAspectRatio="none". */}
            <Typography sx={{ ...AXIS_SX, position: 'absolute', right: 0, top: H / 2 - 12, lineHeight: 1, px: 0.25, bgcolor: 'rgba(8,12,24,0.92)' }}>
              50% · CHANGES HANDS
            </Typography>
            <Box
              data-testid="sector-drawer-history-now"
              sx={{
                position: 'absolute', width: 6, height: 6, borderRadius: '50%', bgcolor: '#fff',
                left: `calc(${(g.last.x / W) * 100}% - 3px)`, top: g.last.y - 3,
              }}
            />
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.25 }}>
            <Typography sx={AXIS_SX}>{spanMin} MIN AGO</Typography>
            <Typography sx={AXIS_SX}>NOW</Typography>
          </Box>
        </>
      ) : (
        <Typography data-testid="sector-drawer-history-empty" sx={{ color: '#6b7280', fontSize: 10 }}>
          {samples === null ? 'Loading…' : 'History builds up over the next hour'}
        </Typography>
      )}
    </Box>
  );
}
