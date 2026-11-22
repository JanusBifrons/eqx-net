/**
 * The EQX catalogue barrel: the only import path for UI elements.
 * Feature code imports from here, never from `@mui/*` / `@emotion/*` directly.
 * Entry list and the "extend, never hand-roll" process: ./README.md.
 */
export { eqxTheme, buildEqxTheme } from './theme.js';
export { EqxButton, TONE_COLOR, type EqxButtonProps, type EqxButtonSize, type EqxTone } from './EqxButton/EqxButton.js';
export { EqxIconButton, type EqxIconButtonProps } from './EqxIconButton/EqxIconButton.js';
export { EqxTooltip, type EqxTooltipProps } from './EqxTooltip/EqxTooltip.js';
export { EqxSwitch, type EqxSwitchProps } from './EqxSwitch/EqxSwitch.js';
export { EqxStrip, type EqxStripProps, type EqxStripSeparatorProps } from './EqxStrip/EqxStrip.js';
export { EqxStripIdentity, HEALTH_RING, type EqxStripIdentityProps, type EqxStripHealth } from './EqxStripIdentity/EqxStripIdentity.js';
export { EQX_ICONS, EQX_ICON_NAMES, type EqxIconName } from './icons.js';
export { EqxIcon, type EqxIconProps, type EqxIconSize } from './EqxIcon/EqxIcon.js';
