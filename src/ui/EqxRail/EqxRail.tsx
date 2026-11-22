/**
 * EqxRail: the slim right rail (UI language plan A3). Composes EqxIconButton.
 * - A full-height column (mock .rail): rail paper, a 1 px left edge, rail tiles (EqxIconButton
 *   variant `railTool` for the mode's own `tools`, `rail` for the always-there `items`), a 1 px
 *   divider between the two groups, then a flexible spacer and the cog pinned at the bottom.
 * - Icons only: every label is the button's tooltip (hover / long-press), never visible text.
 * - At most `RAIL_MAX_ITEMS` tools + items plus the cog: more throws in dev; prod shows the first 8.
 * - Width: `HUD.size.railPhone` when compact, else `HUD.size.railDesktop`. `compact` defaults to the
 *   `(pointer: coarse)` media query (a touch screen); pass it to force either width.
 * - Does not position itself: it fills its parent's height. The right-rail Slot mounts it.
 */
import { Box, useMediaQuery } from '@mui/material';
import type { ReactNode } from 'react';
import { HUD } from '../../client/hud/tokens.js';
import { EqxIconButton } from '../EqxIconButton/EqxIconButton.js';

/** Plan A3: at most 8 rail items (tools + items), plus the cog. */
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
  /** The always-there items (galaxy, jobs, ...), below the divider. */
  items: readonly EqxRailItem[];
  /** The current mode's own tools, brighter, above the divider. Tools + items: at most `RAIL_MAX_ITEMS`. */
  tools?: readonly EqxRailItem[];
  /** The open item (or the cog's id); none when undefined. */
  activeId?: string | undefined;
  onPick: (id: string) => void;
  /** The pinned cog: `true` uses the default cog icon with tooltip "Settings". */
  cog?: EqxRailCog | boolean;
  /** Force the phone (true) or desktop (false) width; default follows `RAIL_COMPACT_QUERY`. */
  compact?: boolean;
  'data-testid'?: string;
}

/** The mock's line cog (stroke, round caps, no fill); the rail tile sizes it. */
const LINE_COG = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </svg>
);

const DEFAULT_COG: Required<EqxRailCog> = { icon: LINE_COG, tooltip: 'Settings', id: RAIL_COG_ID };

function resolveCog(cog: EqxRailProps['cog']): Required<EqxRailCog> | null {
  if (!cog) return null;
  if (cog === true) return DEFAULT_COG;
  return { icon: cog.icon, tooltip: cog.tooltip, id: cog.id ?? RAIL_COG_ID };
}

function capItems(
  tools: readonly EqxRailItem[],
  items: readonly EqxRailItem[],
): { tools: readonly EqxRailItem[]; items: readonly EqxRailItem[] } {
  const total = tools.length + items.length;
  if (total <= RAIL_MAX_ITEMS) return { tools, items };
  const msg = `EqxRail: ${total} items; the rail holds at most ${RAIL_MAX_ITEMS} plus the cog`;
  if (import.meta.env.DEV) throw new Error(msg);
  // Prod: never crash the HUD over a layout cap; show the first 8.
  const keptTools = tools.slice(0, RAIL_MAX_ITEMS);
  return { tools: keptTools, items: items.slice(0, RAIL_MAX_ITEMS - keptTools.length) };
}

const NO_TOOLS: readonly EqxRailItem[] = [];

export function EqxRail({ items, tools = NO_TOOLS, activeId, onPick, cog, compact, 'data-testid': testId }: EqxRailProps) {
  const coarse = useMediaQuery(RAIL_COMPACT_QUERY);
  const isCompact = compact ?? coarse;
  const shown = capItems(tools, items);
  const pinned = resolveCog(cog);
  const width = isCompact ? HUD.size.railPhone : HUD.size.railDesktop;
  const child = (id: string) => (testId ? `${testId}-${id}` : undefined);
  const tile = (it: EqxRailItem, tool: boolean) => (
    <EqxIconButton
      key={it.id}
      variant={tool ? 'railTool' : 'rail'}
      icon={it.icon}
      tooltip={it.tooltip}
      active={it.id === activeId}
      onClick={() => onPick(it.id)}
      {...(it.badge === undefined ? {} : { badge: it.badge })}
      {...(testId ? { 'data-testid': child(it.id) } : {})}
    />
  );
  const divider = shown.tools.length > 0 && shown.items.length > 0;
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
        gap: `${HUD.rail.gap}px`,
        py: `${HUD.rail.padY}px`,
        bgcolor: HUD.color.railBg,
        borderLeft: `1px solid ${HUD.color.edge2}`,
      }}
    >
      {shown.tools.map((it) => tile(it, true))}
      {divider && (
        <Box
          role="separator"
          data-testid={child('divider')}
          sx={{ width: '60%', height: '1px', flex: 'none', bgcolor: HUD.color.edge2, my: `${HUD.rail.dividerGap}px` }}
        />
      )}
      {shown.items.map((it) => tile(it, false))}
      {pinned && (
        <Box sx={{ mt: 'auto', display: 'flex' }}>
          <EqxIconButton
            variant="rail"
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
