/**
 * The left-strip tile look (mock .ib / .ib .n / .fo), shared by
 * EqxIconButton `variant="strip"` and EqxStripIdentity so the strip look
 * lives in one place. Sizes and colours from `HUD.strip`.
 */
import type { SxProps, Theme } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import type { EqxTone } from '../EqxButton/EqxButton.js';

const S = HUD.strip;

/** Shared tile box: rounded square, edge, well, centred line icon, no MUI hover tint. */
const TILE_BASE = {
  boxSizing: 'border-box',
  width: S.tile,
  height: S.tile,
  minWidth: S.tile,
  minHeight: S.tile,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  position: 'relative',
  border: `1px solid ${S.edge}`,
  borderRadius: `${S.tileRadius}px`,
  bgcolor: S.cell,
  color: HUD.color.ink,
  '& .MuiSvgIcon-root, & svg': { fontSize: S.icon, width: S.icon, height: S.icon },
} as const;

/**
 * Tile look for EqxIconButton `variant="strip"`:
 * - tone primary = ok (green fill, dark icon); danger = no (red icon, red-ish edge);
 * - `status` = cyan icon + cyan-tinted edge (`alert`: red icon, aggressive stance);
 * - `active` = cyan edge (+ a 1 px cyan ring on a status tile: its fly-out is open;
 *   a plain tile also turns its icon cyan: the current fly-out option).
 */
export function stripTileSx(tone: EqxTone, active: boolean, status: 'calm' | 'alert' | undefined): SxProps<Theme> {
  let look: Record<string, unknown>;
  if (status) {
    look = { color: status === 'alert' ? HUD.color.danger : HUD.color.auto, borderColor: S.statusEdge };
    if (active) look = { ...look, borderColor: HUD.color.auto, boxShadow: `0 0 0 1px ${HUD.color.auto}` };
  } else if (tone === 'primary') {
    look = { bgcolor: HUD.color.hullOk, borderColor: HUD.color.hullOk, color: S.okInk };
  } else if (tone === 'danger') {
    look = { color: HUD.color.danger, borderColor: S.noEdge };
  } else {
    look = active ? { color: HUD.color.auto, borderColor: HUD.color.auto } : {};
  }
  const bg = (look['bgcolor'] as string | undefined) ?? S.cell;
  return { ...TILE_BASE, ...look, '&:hover': { bgcolor: bg } } as SxProps<Theme>;
}

/** Round identity tile: health-coloured edge + inset ring, gold icon. */
export function stripIdentitySx(ring: string): SxProps<Theme> {
  return {
    ...TILE_BASE,
    borderRadius: '50%',
    borderColor: ring,
    boxShadow: `inset 0 0 0 1px ${ring}`,
    color: HUD.color.credits,
    '&:hover': { bgcolor: S.cell },
  } as SxProps<Theme>;
}

/** Count badge: gold pill on the tile's top-right corner (JetBrains Mono 700). */
export const stripBadgeSx = {
  position: 'absolute',
  top: -S.badgeOffset,
  right: -S.badgeOffset,
  transform: 'none',
  minWidth: S.badge,
  height: S.badge,
  padding: '0 3px',
  borderRadius: `${S.badge / 2}px`,
  bgcolor: HUD.color.credits,
  color: S.badgeInk,
  fontFamily: HUD.font.num,
  fontWeight: 700,
  fontSize: S.badgeFont,
  lineHeight: `${S.badge}px`,
  '&.MuiBadge-invisible': { display: 'none' },
} as const;

/** The badge root sits static so the pill anchors to the tile, not the icon. */
export const STRIP_BADGE_ROOT = { position: 'static' } as const;
