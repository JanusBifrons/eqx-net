/**
 * EqxIcon: draws the registered line icon for a game meaning (`src/ui/icons.tsx`).
 * Features write `<EqxIcon name="patrol" />` and never import an icon directly.
 * - `name` is the `EqxIconName` union, so a typo fails tsc.
 * - Line icon as the mock-ups: no fill, stroke currentColor, round caps and joins.
 *   `stroke` picks the weight from `HUD.size.iconStroke` (`light` for the rail).
 * - Size comes from `HUD.size.iconGlyph`; colour is inherited (the parent's tone).
 * - Decorative by default (aria-hidden); pass `title` when the icon stands alone
 *   and must be announced. Inside an EqxIconButton the button's tooltip names it.
 */
import { SvgIcon } from '@mui/material';
import { HUD } from '../../client/hud/tokens.js';
import { EQX_ICONS, type EqxIconName } from '../icons.js';

export type EqxIconSize = keyof typeof HUD.size.iconGlyph;
export type EqxIconStroke = keyof typeof HUD.size.iconStroke;

export interface EqxIconProps {
  name: EqxIconName;
  /** Default `medium` (the glyph inside an EqxIconButton). */
  size?: EqxIconSize;
  /** Line weight; default `regular`. `light` matches the right rail in the mock. */
  stroke?: EqxIconStroke;
  /** Accessible name; when set the icon is role="img" instead of hidden. */
  title?: string;
  'data-testid'?: string;
}

export function EqxIcon({
  name,
  size = 'medium',
  stroke = 'regular',
  title,
  'data-testid': testId,
}: EqxIconProps) {
  const px = HUD.size.iconGlyph[size];
  return (
    <SvgIcon
      viewBox="0 0 24 24"
      data-testid={testId}
      data-icon={name}
      data-size={size}
      data-stroke={stroke}
      {...(title === undefined
        ? { 'aria-hidden': true }
        : { titleAccess: title, role: 'img', 'aria-label': title })}
      sx={{
        fontSize: px,
        width: px,
        height: px,
        color: 'inherit',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: HUD.size.iconStroke[stroke],
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }}
    >
      {EQX_ICONS[name]}
    </SvgIcon>
  );
}
