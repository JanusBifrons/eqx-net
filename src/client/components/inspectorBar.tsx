/**
 * The inspector's thin progress bar (hull, shield, build, charge), shared by
 * the entity inspector (`EntityStatsPanel`) and its building card
 * (`structureCard.tsx`). Moved out of EntityStatsPanel.tsx (size cap).
 */
import { Box } from '@mui/material';
import { phoneTiny } from './inspectorSizes';

const TRACK_W = 72;
const BAR_H = 4;

// Static fill styling hoisted (drawer-perf sx rule); the two per-render
// dynamics (width %, colour) go through the plain `style` prop — no per-render
// emotion serialisation.
const BAR_FILL_SX = { height: '100%', transition: 'width 1000ms linear' };

const BAR_TRACK_SX = {
  ...phoneTiny({ width: [TRACK_W, TRACK_W * 2], height: [BAR_H, BAR_H * 2] }),
  borderRadius: '2px',
  backgroundColor: 'rgba(255,255,255,0.12)',
  overflow: 'hidden' as const,
};
/** The card's short hull bar: half the track. */
const SHORT_TRACK_SX = {
  ...BAR_TRACK_SX,
  ...phoneTiny({ width: [TRACK_W / 2, TRACK_W], height: [BAR_H, BAR_H * 2] }),
  flex: '0 0 auto',
};

export function Bar({ pct, color, short = false }: { pct: number; color: string; short?: boolean }): JSX.Element {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <Box sx={short ? SHORT_TRACK_SX : BAR_TRACK_SX}>
      <Box sx={BAR_FILL_SX} style={{ width: `${clamped}%`, backgroundColor: color }} />
    </Box>
  );
}
