/**
 * EqxIcon: draws the registered icon for a game meaning (`src/ui/icons.ts`).
 * Features write `<EqxIcon name="patrol" />` and never import an icon directly.
 * - `name` is the `EqxIconName` union, so a typo fails tsc.
 * - Size comes from `HUD.size.iconGlyph`; colour is inherited (the parent's tone).
 * - Decorative by default (aria-hidden); pass `title` when the icon stands alone
 *   and must be announced. Inside an EqxIconButton the button's tooltip names it.
 */
import { HUD } from '../../client/hud/tokens.js';
import { EQX_ICONS, type EqxIconName } from '../icons.js';

export type EqxIconSize = keyof typeof HUD.size.iconGlyph;

export interface EqxIconProps {
  name: EqxIconName;
  /** Default `medium` (the glyph inside an EqxIconButton). */
  size?: EqxIconSize;
  /** Accessible name; when set the icon is role="img" instead of hidden. */
  title?: string;
  'data-testid'?: string;
}

export function EqxIcon({ name, size = 'medium', title, 'data-testid': testId }: EqxIconProps) {
  const Icon = EQX_ICONS[name];
  const px = HUD.size.iconGlyph[size];
  return (
    <Icon
      data-testid={testId}
      data-icon={name}
      data-size={size}
      {...(title === undefined
        ? { 'aria-hidden': true }
        : { titleAccess: title, role: 'img', 'aria-label': title })}
      sx={{ fontSize: px, width: px, height: px, color: 'inherit' }}
    />
  );
}
