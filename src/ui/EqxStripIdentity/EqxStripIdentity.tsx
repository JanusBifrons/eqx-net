/**
 * EqxStripIdentity: the top of the left strip, a small ROUND icon for the
 * selected thing (never a rectangular portrait).
 * Wraps MUI `IconButton` (+ `Badge`) inside an EqxTooltip, like EqxIconButton:
 * - the same outer box (`HUD.size.iconButton`), icon centred;
 * - the ring colour shows health (ok = hullOk green, warn = hullWarn amber, crit = hullCrit red);
 * - `count` > 1 shows a badge (groups); the badge is the only text allowed on the strip;
 * - `tooltip` is required and is also the accessible name. No label prop.
 */
import { Badge, Box, IconButton } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxTooltip } from '../EqxTooltip/EqxTooltip.js';

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
  /** Group size; a badge shows when > 1. */
  count?: number;
  onClick?: () => void;
  /** Touch hold before the tooltip shows (passes to EqxTooltip). */
  holdMs?: number;
  'data-testid'?: string;
}

export function EqxStripIdentity({
  icon,
  tooltip,
  health,
  count,
  onClick,
  holdMs,
  'data-testid': testId,
}: EqxStripIdentityProps) {
  const ring = HEALTH_RING[health];
  const box = HUD.size.iconButton;
  const showCount = count !== undefined && count > 1;
  return (
    <EqxTooltip title={tooltip} {...(holdMs === undefined ? {} : { holdMs })}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <IconButton
          aria-label={tooltip}
          onClick={onClick}
          data-testid={testId}
          data-health={health}
          sx={{
            width: box,
            height: box,
            minWidth: box,
            minHeight: box,
            padding: 0,
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            color: HUD.color.ink,
            bgcolor: HUD.color.cell,
            borderStyle: 'solid',
            borderWidth: 2,
            borderColor: ring,
            borderRadius: '50%',
            '&:hover': { bgcolor: HUD.color.panel },
          }}
        >
          <Badge
            badgeContent={showCount ? count : undefined}
            invisible={!showCount}
            data-testid={testId ? `${testId}-badge` : undefined}
            slotProps={{ badge: { sx: { fontFamily: HUD.font.num, color: HUD.color.appBg, bgcolor: ring } } }}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </Badge>
        </IconButton>
      </Box>
    </EqxTooltip>
  );
}
