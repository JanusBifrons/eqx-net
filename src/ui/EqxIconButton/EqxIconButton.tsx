/**
 * EqxIconButton: the one icon button (right rail, left strip, fly-outs).
 * Wraps MUI `IconButton` (+ `Badge`) inside an EqxTooltip.
 * - One fixed box: `HUD.size.iconButton` square, icon centred, whatever the icon.
 * - `tooltip` is required and is also the accessible name (aria-label).
 * - No label prop: icon-only by design (left-strip rule).
 * - `variant="strip"`: the left-strip / fly-out tile (mock .ib), a rounded square
 *   `HUD.strip.tile`, no ripple, gold badge pill; look in `stripTile.ts`.
 * - `variant` `rail` (dim) / `railTool` (a mode tool, brighter): the right-rail tiles, a
 *   borderless rounded square `HUD.size.railItem`, line icon, cyan well plus an inset cyan bar on
 *   the left when active, badge as a small pill on the tile corner.
 */
import { Badge, Box, IconButton } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { TONE_COLOR, type EqxTone } from '../EqxButton/EqxButton.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';
import { STRIP_BADGE_ROOT, stripBadgeSx, stripTileSx } from './stripTile.js';

/** Strip status tile: `calm` = cyan icon, `alert` = red icon (aggressive stance). */
export type EqxStripStatus = 'calm' | 'alert';

/** `round`: outlined circle. `rail` / `railTool`: right-rail tile (dim / bright). `strip`: left-strip square tile. */
export type EqxIconButtonVariant = 'round' | 'rail' | 'railTool' | 'strip';

export interface EqxIconButtonProps {
  /** The icon element (e.g. an `@mui/icons-material` icon or a game SVG). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  onClick?: () => void;
  /** Default `secondary`. Strip: primary = filled green ok, danger = red outline (stop / cancel). Ignored by the rail variants (they follow the mock's cyan). */
  tone?: EqxTone;
  /** Selected / open state: tone-coloured edge and well. Strip: cyan edge (status: + cyan ring). */
  active?: boolean;
  /** Count badge; 0 or undefined shows none. */
  badge?: number;
  /** Touch hold before the tooltip shows (passes to EqxTooltip). */
  holdMs?: number;
  disabled?: boolean;
  /** Default `round`; `strip` = the left-strip tile; `rail` / `railTool` = the right-rail tile. */
  variant?: EqxIconButtonVariant;
  /** Strip variant only: a status tile (current order / stance). */
  status?: EqxStripStatus;
  /** Strip variant only: the colour this action has in the world (`#rrggbb`, e.g. the move-order
   *  green), so the button and its mark read as one thing. Overrides tone / status colour. */
  accent?: string;
  'data-testid'?: string;
  /** Round / strip only: a machine-readable state for tests (`data-state`), e.g. a lock's stage. Never shown. */
  'data-state'?: string;
}

export function EqxIconButton({
  icon,
  tooltip,
  onClick,
  tone = 'secondary',
  active = false,
  badge,
  holdMs,
  disabled = false,
  variant = 'round',
  status,
  accent,
  'data-testid': testId,
  'data-state': dataState,
}: EqxIconButtonProps) {
  if (variant === 'rail' || variant === 'railTool') {
    return (
      <RailTile
        icon={icon}
        tooltip={tooltip}
        onClick={onClick}
        active={active}
        badge={badge}
        holdMs={holdMs}
        disabled={disabled}
        tool={variant === 'railTool'}
        testId={testId}
      />
    );
  }
  const color = TONE_COLOR[tone];
  const box = HUD.size.iconButton;
  const strip = variant === 'strip';
  return (
    <EqxTooltip title={tooltip} {...(holdMs === undefined ? {} : { holdMs })}>
      {/* A wrapper so the tooltip still works when the button is disabled. */}
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <IconButton
          aria-label={tooltip}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          data-testid={testId}
          data-tone={tone}
          data-active={active ? 'true' : 'false'}
          data-variant={variant}
          {...(dataState !== undefined ? { 'data-state': dataState } : {})}
          {...(strip && status !== undefined ? { 'data-status': status } : {})}
          {...(strip && accent !== undefined ? { 'data-accent': accent } : {})}
          disableRipple={strip}
          sx={
            strip
              ? stripTileSx(tone, active, status, accent)
              : {
                  width: box,
                  height: box,
                  minWidth: box,
                  minHeight: box,
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 'none',
                  color,
                  bgcolor: active ? HUD.color.cell : 'transparent',
                  border: `1px solid ${active ? color : HUD.color.panelEdge}`,
                  borderRadius: '50%',
                  '&:hover': { bgcolor: HUD.color.panel },
                }
          }
        >
          <Badge
            badgeContent={badge}
            invisible={!badge}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{
              badge: {
                sx: strip
                  ? stripBadgeSx
                  : { fontFamily: HUD.font.num, color: HUD.color.appBg, bgcolor: color },
              },
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...(strip ? STRIP_BADGE_ROOT : {}),
            }}
          >
            {icon}
          </Badge>
        </IconButton>
      </Box>
    </EqxTooltip>
  );
}

interface RailTileProps {
  icon: ReactNode;
  tooltip: string;
  onClick: (() => void) | undefined;
  active: boolean;
  badge: number | undefined;
  holdMs: number | undefined;
  disabled: boolean;
  tool: boolean;
  testId: string | undefined;
}

/** The right-rail tile (mock .ri, .ri.ctx, .ri.on). */
function RailTile({ icon, tooltip, onClick, active, badge, holdMs, disabled, tool, testId }: RailTileProps) {
  const box = HUD.size.railItem;
  const rest = tool ? HUD.color.ink : HUD.color.inkDim;
  const well = active ? HUD.color.railActive : 'transparent';
  return (
    <EqxTooltip title={tooltip} {...(holdMs === undefined ? {} : { holdMs })}>
      {/* A wrapper so the tooltip still works when the button is disabled. */}
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <IconButton
          aria-label={tooltip}
          aria-pressed={active}
          disabled={disabled}
          disableRipple
          onClick={onClick}
          data-testid={testId}
          data-variant={tool ? 'railTool' : 'rail'}
          data-active={active ? 'true' : 'false'}
          sx={{
            position: 'relative',
            width: box,
            height: box,
            minWidth: box,
            minHeight: box,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            border: 'none',
            borderRadius: `${HUD.rail.radius}px`,
            color: active ? HUD.color.auto : rest,
            bgcolor: well,
            boxShadow: active ? `inset ${HUD.rail.activeBar}px 0 0 ${HUD.color.auto}` : 'none',
            transition: 'background-color .2s, color .2s',
            '&:hover': { bgcolor: well },
            '& svg': { width: HUD.rail.icon, height: HUD.rail.icon, fontSize: HUD.rail.icon },
          }}
        >
          <Badge
            badgeContent={badge}
            invisible={!badge}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{
              badge: {
                sx: {
                  // The Badge root is static, so the pill pins to the tile's corner, not the icon's.
                  top: -3,
                  right: -2,
                  transform: 'none',
                  height: 'auto',
                  minWidth: 0,
                  padding: '0 4px',
                  borderRadius: '9px',
                  lineHeight: 1.4,
                  fontFamily: HUD.font.num,
                  fontSize: HUD.rail.badgeFont,
                  fontWeight: 600,
                  color: HUD.color.appBg,
                  bgcolor: HUD.color.auto,
                },
              },
            }}
            sx={{ position: 'static', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </Badge>
        </IconButton>
      </Box>
    </EqxTooltip>
  );
}
