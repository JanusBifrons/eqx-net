/**
 * EqxStripIdentity: the top of the left strip, a small ROUND icon for the
 * selected thing (never a rectangular portrait).
 * Wraps MUI `IconButton` (+ `Badge`) inside an EqxTooltip, like EqxIconButton:
 * - the same outer box as a strip tile (`HUD.strip.tile`), icon centred, gold icon;
 * - `iconColor` tints the icon (the left strip: the focus's stance to you);
 * - edge + inset ring colour shows health (ok = hullOk green, warn = hullWarn gold, crit = hullCrit red);
 *   `ringColor` overrides it (the left strip: a focus that is not friendly rings in its stance colour);
 * - `count` > 1 shows a gold pill badge (groups); the badge is the only text allowed on the strip;
 * - `tooltip` is required and is also the accessible name. No label prop.
 */
import { Badge, Box, IconButton } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';
import { STRIP_BADGE_ROOT, stripBadgeSx, stripIdentitySx } from '../EqxIconButton/stripTile.js';

export type EqxStripHealth = 'ok' | 'warn' | 'crit';

/** Ring colour per health, from the hull tokens. */
export const HEALTH_RING: Record<EqxStripHealth, string> = {
  ok: HUD.color.hullOk,
  warn: HUD.color.hullWarn,
  crit: HUD.color.hullCrit,
};

export interface EqxStripIdentityProps {
  /** The thing's icon (from the icon registry once it lands). */
  icon: ReactNode;
  /** Required: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  /** Ring colour. */
  health: EqxStripHealth;
  /** Icon colour (`#rrggbb`, e.g. the thing's stance to you); default gold. */
  iconColor?: string;
  /** Ring colour override (`#rrggbb`, e.g. a hostile's stance red); default the health ring. */
  ringColor?: string;
  /** Group size; a badge shows when > 1. */
  count?: number;
  onClick?: () => void;
  /** Touch hold before the tooltip shows (passes to EqxTooltip). */
  holdMs?: number;
  'data-testid'?: string;
  /** A machine-readable state for tests (`data-state`), e.g. the stance. Never shown. */
  'data-state'?: string;
}

export function EqxStripIdentity({
  icon,
  tooltip,
  health,
  count,
  onClick,
  holdMs,
  iconColor,
  ringColor,
  'data-testid': testId,
  'data-state': dataState,
}: EqxStripIdentityProps) {
  const ring = ringColor ?? HEALTH_RING[health];
  const showCount = count !== undefined && count > 1;
  return (
    <EqxTooltip title={tooltip} {...(holdMs === undefined ? {} : { holdMs })}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <IconButton
          aria-label={tooltip}
          onClick={onClick}
          data-testid={testId}
          data-health={health}
          {...(dataState !== undefined ? { 'data-state': dataState } : {})}
          disableRipple
          sx={stripIdentitySx(ring, iconColor)}
        >
          <Badge
            badgeContent={showCount ? count : undefined}
            invisible={!showCount}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{ badge: { sx: stripBadgeSx } }}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', ...STRIP_BADGE_ROOT }}
          >
            {icon}
          </Badge>
        </IconButton>
      </Box>
    </EqxTooltip>
  );
}
