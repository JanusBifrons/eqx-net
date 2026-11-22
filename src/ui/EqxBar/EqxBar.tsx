/**
 * EqxBar: a readout bar (hull, shield, battery charge). Mock `.lrow` + `.bar`.
 * - With `label`: one full-width row, the label in a fixed column, the track
 *   filling the rest (the Details panel's bars).
 * - `short`: the track alone at `HUD.bar.shortW`, to sit inline beside other
 *   content (a building card's row). No label.
 * - `tone` picks the fill: `hull` follows the hull thresholds (`hullColor`:
 *   green, gold, red), `shield` cyan, `charge` the battery colour.
 * - `pct` is 0..100 and is clamped. The fill width eases (`HUD.bar.fillMs`);
 *   width and colour go through `style`, so a new value costs no style rebuild.
 * - Does not position itself.
 */
import { Box } from '@mui/material';
import { HUD, hullColor } from '../../client/hud/tokens.js';

export type EqxBarTone = 'hull' | 'shield' | 'charge';

export interface EqxBarProps {
  /** Fill, 0..100 (clamped). */
  pct: number;
  /** Fill colour. Default `hull`. */
  tone?: EqxBarTone;
  /** The row's label ("Hull"); omit for a bare track. */
  label?: string;
  /** A short inline track (no label). */
  short?: boolean;
  'data-testid'?: string;
}

const B = HUD.bar;

/** The fill colour for a tone at `pct` (exported for tests). */
export function barColor(tone: EqxBarTone, pct: number): string {
  if (tone === 'shield') return HUD.color.shield;
  if (tone === 'charge') return B.charge;
  return hullColor(pct);
}

const TRACK_SX = {
  flex: '1 1 auto',
  minWidth: 0,
  height: B.height,
  borderRadius: `${B.height}px`,
  bgcolor: B.track,
  overflow: 'hidden' as const,
};
const SHORT_SX = { ...TRACK_SX, flex: '0 0 auto', width: B.shortW };
const FILL_SX = { height: '100%', transition: `width ${B.fillMs}ms linear` };
const ROW_SX = { display: 'flex', alignItems: 'center', gap: `${B.gap}px`, width: '100%', minWidth: 0 };
const LABEL_SX = {
  flex: 'none',
  width: B.labelW,
  fontFamily: HUD.font.label,
  fontSize: B.labelSize,
  letterSpacing: 0.5,
  textTransform: 'uppercase' as const,
  color: HUD.color.inkDim,
};

export function EqxBar({ pct, tone = 'hull', label, short = false, 'data-testid': testId }: EqxBarProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  const bare = label === undefined || short;
  const track = (
    <Box
      sx={short ? SHORT_SX : TRACK_SX}
      role="meter"
      aria-label={label ?? tone}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      {...(bare ? { 'data-testid': testId, 'data-pct': Math.round(clamped), 'data-tone': tone } : {})}
    >
      <Box sx={FILL_SX} style={{ width: `${clamped}%`, backgroundColor: barColor(tone, clamped) }} />
    </Box>
  );
  if (bare) return track;
  return (
    <Box sx={ROW_SX} data-testid={testId} data-pct={Math.round(clamped)} data-tone={tone}>
      <Box component="span" sx={LABEL_SX}>{label}</Box>
      {track}
    </Box>
  );
}
