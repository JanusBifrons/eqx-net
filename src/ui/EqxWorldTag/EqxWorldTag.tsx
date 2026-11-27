/**
 * EqxWorldTag: the floating name tag over the selection focus (selection HUD
 * S6b, Clash-of-Clans style). No box or background: light text with a black
 * outline (text-stroke painted under the fill), then a thin hull bar and a
 * small pointer triangle pointing down at the entity. A gentle bob, none
 * under prefers-reduced-motion. Fixed screen size (`HUD.worldTag`).
 * - line 1 `title` ("Type · Name"), line 2 `owner` in `ownerColor`
 *   (the relation colour), then the hull bar when `hullPct` is given.
 * - Does not position itself: the caller places its bottom-centre (the
 *   pointer tip) on the entity.
 * - Edge-stuck (S9, off-screen anchor): an arrow + distance row, hidden by
 *   default. The caller's per-frame writer (`hud/worldTag.ts`) shows it,
 *   hides the down pointer, rotates the arrow and writes the distance via
 *   the `data-world-tag-*` hooks. The arrow takes the relation colour.
 */
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { barColor } from '../EqxBar/EqxBar.js';

export interface EqxWorldTagProps {
  /** Line 1: "Type · Name". */
  title: string;
  /** Line 2: the owner ("you", their name, a faction) or a stance word. */
  owner?: string;
  /** Line 2 colour: the relation colour (friendly / hostile / neutral). */
  ownerColor?: string;
  /** Hull 0..100 (clamped); omit for no bar (a rock, a pending read). */
  hullPct?: number;
  'data-testid'?: string;
}

const T = HUD.worldTag;

const ROOT_SX = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  pointerEvents: 'none' as const,
  userSelect: 'none' as const,
  whiteSpace: 'nowrap' as const,
  fontFamily: HUD.font.label,
  lineHeight: 1.15,
  color: HUD.color.ink,
  WebkitTextStroke: `${T.outlineW}px ${T.outline}`,
  paintOrder: 'stroke fill',
  textShadow: `0 0 2px ${T.outline}`,
  '@keyframes eqxWorldTagBob': {
    '0%, 100%': { transform: `translateY(${-T.bobPx}px)` },
    '50%': { transform: `translateY(${T.bobPx}px)` },
  },
  animation: `eqxWorldTagBob ${T.bobMs}ms ease-in-out infinite`,
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
};
const TITLE_SX = { fontSize: T.titleSize, fontWeight: 700 };
const OWNER_SX = { fontSize: T.ownerSize, fontWeight: 700 };
const TRACK_SX = {
  width: T.barW,
  height: T.barH,
  mt: `${T.barGap}px`,
  bgcolor: HUD.bar.track,
  outline: `1px solid ${T.outline}`,
  overflow: 'hidden' as const,
};
const FILL_SX = { height: '100%' };
const POINTER_SX = {
  width: 0,
  height: 0,
  mt: `${T.barGap}px`,
  borderLeft: `${T.pointerHalf}px solid transparent`,
  borderRight: `${T.pointerHalf}px solid transparent`,
  borderTop: `${T.pointerH}px solid ${HUD.color.ink}`,
  filter: `drop-shadow(0 1px 0 ${T.outline})`,
};
/** S9 edge row: hidden until the writer shows it (display flex). */
const EDGE_SX = { display: 'none', alignItems: 'center', gap: '4px', mb: `${T.barGap}px`, fontSize: T.ownerSize, fontWeight: 700 };
/** A right-pointing triangle; the writer rotates it toward the anchor. */
const ARROW_SX = {
  width: 0,
  height: 0,
  borderTop: `${T.pointerHalf}px solid transparent`,
  borderBottom: `${T.pointerHalf}px solid transparent`,
  borderLeft: `${T.pointerH + 2}px solid ${HUD.color.ink}`,
  filter: `drop-shadow(0 0 1px ${T.outline})`,
};

export function EqxWorldTag({ title, owner, ownerColor, hullPct, 'data-testid': testId }: EqxWorldTagProps) {
  const hull = hullPct === undefined ? undefined : Math.max(0, Math.min(100, hullPct));
  return (
    <Box sx={ROOT_SX} data-testid={testId} aria-label={owner ? `${title}, ${owner}` : title}>
      <Box sx={EDGE_SX} data-world-tag-edge aria-hidden>
        <Box sx={ARROW_SX} data-world-tag-arrow style={ownerColor ? { borderLeftColor: ownerColor } : undefined} />
        <Box component="span" data-world-tag-dist />
      </Box>
      <Box component="span" sx={TITLE_SX}>{title}</Box>
      {owner !== undefined && owner !== '' && (
        <Box component="span" sx={OWNER_SX} style={ownerColor ? { color: ownerColor } : undefined}>{owner}</Box>
      )}
      {hull !== undefined && (
        <Box
          sx={TRACK_SX}
          role="meter"
          aria-label="Hull"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hull)}
        >
          <Box sx={FILL_SX} style={{ width: `${hull}%`, backgroundColor: barColor('hull', hull) }} />
        </Box>
      )}
      <Box sx={POINTER_SX} data-world-tag-pointer aria-hidden />
    </Box>
  );
}
