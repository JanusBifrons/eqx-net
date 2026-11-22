/**
 * EqxRail: the slim right rail (UI language plan A3). Composes EqxIconButton.
 * - A vertical column of icon buttons, top to bottom, with the cog pinned at the bottom.
 * - Icons only: every label is the button's tooltip (hover / long-press), never visible text.
 * - At most `RAIL_MAX_ITEMS` items plus the cog: more throws in dev; prod shows the first 8.
 * - Width: `HUD.size.railPhone` when compact, else `HUD.size.railDesktop`. `compact` defaults to the
 *   `(pointer: coarse)` media query (a touch screen); pass it to force either width.
 * - Does not position itself: it fills its parent's height. The right-rail Slot mounts it.
 */
import { Box, useMediaQuery } from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';

/** Plan A3: at most 8 rail items, plus the cog. */
export const RAIL_MAX_ITEMS = 8;
/** The id `onPick` receives for the cog unless `cog.id` says otherwise. */
export const RAIL_COG_ID = 'cog';
/** The media query that makes the rail compact by default. */
export const RAIL_COMPACT_QUERY = '(pointer: coarse)';

export interface EqxRailItem {
  id: string;
  icon: ReactNode;
  /** The label: shown on hover / long-press and used as aria-label. */
  tooltip: string;
  badge?: number;
}

export interface EqxRailCog {
  icon: ReactNode;
  tooltip: string;
  /** Default `RAIL_COG_ID`. */
  id?: string;
}

export interface EqxRailProps {
  /** Top to bottom; at most `RAIL_MAX_ITEMS`. */
  items: readonly EqxRailItem[];
  /** The open item (or the cog's id); none when undefined. */
  activeId?: string | undefined;
  onPick: (id: string) => void;
  /** The pinned cog: `true` uses the default cog icon with tooltip "Settings". */
  cog?: EqxRailCog | boolean;
  /** Force the phone (true) or desktop (false) width; default follows `RAIL_COMPACT_QUERY`. */
  compact?: boolean;
  'data-testid'?: string;
}

const DEFAULT_COG: Required<EqxRailCog> = { icon: <SettingsIcon />, tooltip: 'Settings', id: RAIL_COG_ID };

function resolveCog(cog: EqxRailProps['cog']): Required<EqxRailCog> | null {
  if (!cog) return null;
  if (cog === true) return DEFAULT_COG;
  return { icon: cog.icon, tooltip: cog.tooltip, id: cog.id ?? RAIL_COG_ID };
}

function capItems(items: readonly EqxRailItem[]): readonly EqxRailItem[] {
  if (items.length <= RAIL_MAX_ITEMS) return items;
  const msg = `EqxRail: ${items.length} items; the rail holds at most ${RAIL_MAX_ITEMS} plus the cog`;
  if (import.meta.env.DEV) throw new Error(msg);
  // Prod: never crash the HUD over a layout cap; show the first 8.
  return items.slice(0, RAIL_MAX_ITEMS);
}

export function EqxRail({ items, activeId, onPick, cog, compact, 'data-testid': testId }: EqxRailProps) {
  const coarse = useMediaQuery(RAIL_COMPACT_QUERY);
  const isCompact = compact ?? coarse;
  const shown = capItems(items);
  const pinned = resolveCog(cog);
  const width = isCompact ? HUD.size.railPhone : HUD.size.railDesktop;
  const child = (id: string) => (testId ? `${testId}-${id}` : undefined);
  return (
    <Box
      component="nav"
      data-testid={testId}
      data-compact={isCompact ? 'true' : 'false'}
      sx={{
        width,
        minWidth: width,
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        py: 1,
      }}
    >
      {shown.map((it) => (
        <EqxIconButton
          key={it.id}
          icon={it.icon}
          tooltip={it.tooltip}
          active={it.id === activeId}
          onClick={() => onPick(it.id)}
          {...(it.badge === undefined ? {} : { badge: it.badge })}
          {...(testId ? { 'data-testid': child(it.id) } : {})}
        />
      ))}
      {pinned && (
        <Box sx={{ mt: 'auto', display: 'flex' }}>
          <EqxIconButton
            icon={pinned.icon}
            tooltip={pinned.tooltip}
            active={pinned.id === activeId}
            onClick={() => onPick(pinned.id)}
            {...(testId ? { 'data-testid': child(pinned.id) } : {})}
          />
        </Box>
      )}
    </Box>
  );
}
