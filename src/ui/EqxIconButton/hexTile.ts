/**
 * The selection-HUD hex tile look, for EqxIconButton `variant="hex"`:
 * a pointy-top regular hexagon (`HUD.hex.w` x `HUD.hex.h`), dark panel body
 * (`HUD.strip.cell`), the tone colour only on the edge and the icon, an optional
 * short word under the icon in light text with a black outline.
 * Sizes and colours from `HUD.hex`; the tone colour from `TONE_COLOR`.
 *
 * The edge is drawn by clipping: the button is the hexagon filled in the edge
 * colour, and a `::before` hexagon inset by the edge width paints the body.
 * The lit glow is a `drop-shadow` on the unclipped wrapper (`hexGlowSx`), since a
 * filter on the clipped element itself would be cut off by its own clip.
 */
import type { SxProps, Theme } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

const H = HUD.hex;

/** Pointy-top hexagon: vertices at top and bottom centre, flat left and right sides. */
export const HEX_CLIP = 'polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)';

/** The button: the hexagon in the edge colour, the body inset over it, icon + word stacked. */
export function hexTileSx(color: string, lit: boolean, dim: boolean): SxProps<Theme> {
  const edge = lit ? H.litEdge : H.edge;
  const body = {
    content: '""',
    position: 'absolute',
    inset: `${edge}px`,
    clipPath: HEX_CLIP,
    bgcolor: HUD.strip.cell,
  };
  return {
    boxSizing: 'border-box',
    position: 'relative',
    width: H.w,
    height: H.h,
    minWidth: H.w,
    minHeight: H.h,
    padding: 0,
    flex: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: `${H.gap}px`,
    borderRadius: 0,
    clipPath: HEX_CLIP,
    bgcolor: color,
    color,
    opacity: dim ? H.dimOpacity : 1,
    '&::before': body,
    '&:hover': { bgcolor: color },
    '&.Mui-disabled': { color, opacity: H.dimOpacity },
    '& > *': { position: 'relative' },
    '& .MuiSvgIcon-root, & svg': { fontSize: H.icon, width: H.icon, height: H.icon },
    // A picture icon (a building portrait) takes the same icon footprint inside the frame.
    '& img': { width: H.icon, height: H.icon, objectFit: 'contain', flex: 'none' },
  } as SxProps<Theme>;
}

/** The unclipped wrapper: a tone-coloured glow when lit. */
export function hexGlowSx(color: string, lit: boolean): SxProps<Theme> {
  return {
    display: 'inline-flex',
    filter: lit ? `drop-shadow(0 0 ${H.glow}px ${color})` : 'none',
  } as SxProps<Theme>;
}

/** The short word under the icon: HUD label font, light ink, black outline. */
export const hexWordSx = {
  display: 'block',
  fontFamily: HUD.font.label,
  fontSize: H.wordFont,
  fontWeight: 700,
  letterSpacing: H.wordTracking,
  lineHeight: 1,
  color: HUD.strip.ink,
  textShadow: H.textOutline,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
} as const;
