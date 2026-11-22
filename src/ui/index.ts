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
export {
  EqxDropdown,
  type EqxDropdownProps,
  type EqxDropdownOption,
  type EqxDropdownSingleProps,
  type EqxDropdownMultipleProps,
} from './EqxDropdown/EqxDropdown.js';
export { EqxTextField, type EqxTextFieldProps } from './EqxTextField/EqxTextField.js';
export { EqxSlider, type EqxSliderProps, type EqxSliderMark } from './EqxSlider/EqxSlider.js';
export { EqxSegmented, type EqxSegmentedProps, type EqxSegmentedOption } from './EqxSegmented/EqxSegmented.js';
