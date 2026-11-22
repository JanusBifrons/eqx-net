/**
 * EqxListRow: one row of a panel list (mock `.lrow`): optional icon, a primary
 * line, an optional dim second line, an optional right-hand value (mono, dim).
 * - With `onOpen` the row is a drill-down: the whole row is a button (its
 *   accessible name is `primary`), a › chevron sits at the right, and a tap
 *   calls `onOpen` once. The panel's ← back returns.
 * - Without `onOpen` it is a plain readout row.
 * - Does not position itself.
 */
import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';

export interface EqxListRowProps {
  /** The main text ("Offers"). Also the accessible name of a drill-down row. */
  primary: string;
  /** A dim second line under the main text. */
  secondary?: ReactNode;
  /** A leading icon (usually an `EqxIcon`). Decorative. */
  icon?: ReactNode;
  /** A short value at the right (mock `.r`: a count, a distance). */
  side?: ReactNode;
  /** Makes the row a drill-down: tapping it opens its page. */
  onOpen?: () => void;
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
const ICON_SX = { display: 'flex', flex: 'none', color: HUD.color.inkDim } as const;
const TEXT_SX = { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0 } as const;
const PRIMARY_SX = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
const SECONDARY_SX = { fontSize: L.rowSmallFont, color: HUD.color.inkDim } as const;
const SIDE_SX = { flex: 'none', ml: 'auto', fontFamily: HUD.font.num, fontSize: L.rowSmallFont, color: HUD.color.inkDim } as const;
const CHEVRON_SX = { flex: 'none', color: HUD.color.inkDim, fontSize: L.rowFont } as const;

export function EqxListRow({ primary, secondary, icon, side, onOpen, 'data-testid': testId }: EqxListRowProps) {
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
  if (onOpen === undefined) return <Box sx={ROW_SX} data-testid={testId}>{body}</Box>;
  return (
    <Box component="button" type="button" sx={BUTTON_SX} onClick={onOpen} aria-label={primary} data-testid={testId}>
      {body}
      <Box component="span" sx={CHEVRON_SX} aria-hidden>›</Box>
    </Box>
  );
}
