/**
 * EqxListRow: one row of a panel list (mock `.lrow`): optional icon, a primary
 * line, an optional dim second line, an optional right-hand value (mono, dim).
 * - With `onOpen` the row is a drill-down: the whole row is a button (its
 *   accessible name is `primary`), a › chevron sits at the right, and a tap
 *   calls `onOpen` once. The panel's ← back returns.
 * - With `onTap` the row is an action (a contact: tap locks it): the whole row
 *   is a button named by `primary`, no chevron, a tap calls `onTap` once.
 * - Without either it is a plain readout row.
 * - `dim` fades the row (out of reach), `selected` washes it (yours, active);
 *   `dataAttrs` adds `data-*` attributes for tests.
 * - Does not position itself.
 */
import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxListRowProps {
  /** The main text ("Offers"). Also the accessible name of a button row. */
  primary: string;
  /** A dim second line under the main text. */
  secondary?: ReactNode;
  /** A leading icon (usually an `EqxIcon`). Decorative. */
  icon?: ReactNode;
  /** A short value at the right (mock `.r`: a count, a distance). */
  side?: ReactNode;
  /** Makes the row a drill-down: tapping it opens its page. */
  onOpen?: () => void;
  /** Makes the row an action: tapping it does it (no chevron). Ignored with `onOpen`. */
  onTap?: () => void;
  /** Faded row (e.g. out of reach). */
  dim?: boolean;
  /** Washed row (e.g. the active group's own lock). */
  selected?: boolean;
  /** Extra `data-*` attributes (keys without the `data-` prefix). */
  dataAttrs?: Readonly<Record<string, string | number>>;
  'data-testid'?: string;
}

const L = HUD.list;

const ROW_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: `${L.rowGap}px`,
  width: '100%',
  minWidth: 0,
  m: 0,
  py: `${L.rowPadY}px`,
  px: `${L.rowPadX}px`,
  border: `1px solid ${HUD.color.panelEdge}`,
  borderRadius: `${L.rowRadius}px`,
  bgcolor: 'transparent',
  color: HUD.color.ink,
  fontFamily: HUD.font.label,
  fontSize: L.rowFont,
  textAlign: 'left',
  transition: 'background .2s',
} as const;
const BUTTON_SX = {
  ...ROW_SX,
  cursor: 'pointer',
  '&:hover, &:active': { bgcolor: L.rowHoverBg },
  '&:focus-visible': { outline: `1px solid ${HUD.color.auto}`, outlineOffset: 1 },
} as const;
const DIM_SX = { opacity: L.rowDimOpacity } as const;
const SELECTED_SX = { bgcolor: L.rowSelectedBg } as const;
const ICON_SX = { display: 'flex', flex: 'none', color: HUD.color.inkDim } as const;
const TEXT_SX = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 } as const;
const PRIMARY_SX = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const SECONDARY_SX = { fontSize: L.rowSmallFont, color: HUD.color.inkDim } as const;
const SIDE_SX = { flex: 'none', ml: 'auto', fontFamily: HUD.font.num, fontSize: L.rowSmallFont, color: HUD.color.inkDim } as const;
const CHEVRON_SX = { flex: 'none', color: HUD.color.inkDim, fontSize: L.rowFont } as const;

function dataProps(attrs: EqxListRowProps['dataAttrs']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (attrs === undefined) return out;
  for (const k of Object.keys(attrs)) out[`data-${k}`] = attrs[k]!;
  return out;
}

export function EqxListRow({
  primary, secondary, icon, side, onOpen, onTap, dim = false, selected = false, dataAttrs, 'data-testid': testId,
}: EqxListRowProps) {
  const body = (
    <>
      {icon !== undefined && <Box component="span" sx={ICON_SX} aria-hidden>{icon}</Box>}
      <Box component="span" sx={TEXT_SX}>
        <Box component="span" sx={PRIMARY_SX}>{primary}</Box>
        {secondary !== undefined && <Box component="span" sx={SECONDARY_SX}>{secondary}</Box>}
      </Box>
      {side !== undefined && <Box component="span" sx={SIDE_SX}>{side}</Box>}
    </>
  );
  const extra = [dim && DIM_SX, selected && SELECTED_SX];
  const data = dataProps(dataAttrs);
  const onClick = onOpen ?? onTap;
  if (onClick === undefined) return <Box sx={[ROW_SX, ...extra]} data-testid={testId} {...data}>{body}</Box>;
  return (
    <Box component="button" type="button" sx={[BUTTON_SX, ...extra]} onClick={onClick} aria-label={primary}
      data-testid={testId} {...data}>
      {body}
      {onOpen !== undefined && <Box component="span" sx={CHEVRON_SX} aria-hidden>›</Box>}
    </Box>
  );
}
