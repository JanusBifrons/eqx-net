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
 * - Compact (S10, far zoom): ONE line, `compactTitle` (the type name, or
 *   "5 ships") + a small dot in `ownerColor`; no owner line, no hull bar;
 *   pointer and bob stay. Both layouts are always rendered and CSS picks one
 *   by the root's `data-compact`, so the per-frame writer flips it with one
 *   DOM write (no React render); `compact` sets only the initial value.
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
  /** The compact line's text (S10); defaults to `title`. */
  compactTitle?: string;
  /** Start compact (S10); the per-frame writer flips `data-compact` after that. */
  compact?: boolean;
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
  // S10: one layout or the other by the root's data-compact (flipped on change).
  '&[data-compact="1"] [data-world-tag-full]': { display: 'none' },
  '&:not([data-compact="1"]) [data-world-tag-compact]': { display: 'none' },
};
const TITLE_SX = { fontSize: T.titleSize, fontWeight: 700 };
const FULL_SX = { display: 'flex', flexDirection: 'column' as const, alignItems: 'center' };
const COMPACT_SX = { display: 'flex', alignItems: 'center', gap: '4px' };
const DOT_SX = {
  width: T.dotPx,
  height: T.dotPx,
  borderRadius: '50%',
  bgcolor: HUD.color.ink,
  outline: `1px solid ${T.outline}`,
};
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

export function EqxWorldTag({
  title, owner, ownerColor, hullPct, compactTitle, compact = false, 'data-testid': testId,
}: EqxWorldTagProps) {
  const hull = hullPct === undefined ? undefined : Math.max(0, Math.min(100, hullPct));
  return (
    <Box sx={ROOT_SX} data-testid={testId} data-world-tag data-compact={compact ? '1' : '0'}
      aria-label={owner ? `${title}, ${owner}` : title}>
      <Box sx={EDGE_SX} data-world-tag-edge aria-hidden>
        <Box sx={ARROW_SX} data-world-tag-arrow style={ownerColor ? { borderLeftColor: ownerColor } : undefined} />
        <Box component="span" data-world-tag-dist />
      </Box>
      <Box sx={COMPACT_SX} data-world-tag-compact>
        <Box component="span" sx={TITLE_SX}>{compactTitle ?? title}</Box>
        <Box sx={DOT_SX} data-world-tag-dot aria-hidden style={ownerColor ? { backgroundColor: ownerColor } : undefined} />
      </Box>
      <Box sx={FULL_SX} data-world-tag-full>
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
      </Box>
      <Box sx={POINTER_SX} data-world-tag-pointer aria-hidden />
    </Box>
  );
}
