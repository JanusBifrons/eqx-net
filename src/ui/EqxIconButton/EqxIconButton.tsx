/**
 * EqxIconButton: the one icon button (right rail, left strip, fly-outs).
 * Wraps MUI `IconButton` (+ `Badge`) inside an EqxTooltip.
 * - One fixed box: `HUD.size.iconButton` square, icon centred, whatever the icon.
 * - `tooltip` is required and is also the accessible name (aria-label).
 * - No label prop: icon-only by design (left-strip rule).
 * - `variant`: `round` (default: outlined circle) or the right-rail tiles `rail` (dim) and
 *   `railTool` (a mode tool, brighter): borderless rounded square `HUD.size.railItem`, line icon,
 *   cyan well plus an inset cyan bar on the left when active, badge as a small pill on the tile corner.
 */
import { Badge, Box, IconButton } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { TONE_COLOR, type EqxTone } from '../EqxButton/EqxButton.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

/** `round`: outlined circle. `rail` / `railTool`: right-rail tile (dim / bright). */
export type EqxIconButtonVariant = 'round' | 'rail' | 'railTool';

export interface EqxIconButtonProps {
  /** The icon element (e.g. an `@mui/icons-material` icon or a game SVG). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  onClick?: () => void;
  /** Default `secondary`. Ignored by the rail variants (they follow the mock's cyan). */
  tone?: EqxTone;
  /** Selected / open state: tone-coloured edge and well. */
  active?: boolean;
  /** Count badge; 0 or undefined shows none. */
  badge?: number;
  /** Touch hold before the tooltip shows (passes to EqxTooltip). */
  holdMs?: number;
  disabled?: boolean;
  /** Default `round`. */
  variant?: EqxIconButtonVariant;
  'data-testid'?: string;
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
  'data-testid': testId,
}: EqxIconButtonProps) {
  if (variant !== 'round') {
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
          sx={{
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
          }}
        >
          <Badge
            badgeContent={badge}
            invisible={!badge}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{ badge: { sx: { fontFamily: HUD.font.num, color: HUD.color.appBg, bgcolor: color } } }}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
