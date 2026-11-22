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
export { EqxThemeProvider, type EqxThemeProviderProps } from './EqxThemeProvider/EqxThemeProvider.js';
export { EqxStrip, type EqxStripProps, type EqxStripSeparatorProps } from './EqxStrip/EqxStrip.js';
export { EqxStripIdentity, HEALTH_RING, type EqxStripIdentityProps, type EqxStripHealth } from './EqxStripIdentity/EqxStripIdentity.js';
export { EqxStatusFlyout, type EqxStatusFlyoutProps, type EqxStatusOption } from './EqxStatusFlyout/EqxStatusFlyout.js';
export { EQX_ICONS, EQX_ICON_NAMES, type EqxIconName } from './icons.js';
export { EqxIcon, type EqxIconProps, type EqxIconSize } from './EqxIcon/EqxIcon.js';
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
export { EqxPanel, EQX_PANEL_SIZE, type EqxPanelProps, type EqxPanelApply } from './EqxPanel/EqxPanel.js';
export { EqxRail, RAIL_MAX_ITEMS, RAIL_COG_ID, railWidthFor, useRailCompact, type EqxRailProps, type EqxRailItem, type EqxRailCog } from './EqxRail/EqxRail.js';
export { EqxBar, barColor, type EqxBarProps, type EqxBarTone } from './EqxBar/EqxBar.js';
export { EqxSection, type EqxSectionProps } from './EqxSection/EqxSection.js';
export { EqxListRow, type EqxListRowProps } from './EqxListRow/EqxListRow.js';
export { EqxTable, tableGridTemplate, type EqxTableProps, type EqxTableColumn, type EqxTableSort, type EqxSortDir } from './EqxTable/EqxTable.js';
export { TABLE_PAGER_SLOTS, tablePageList, tablePageWindow, type EqxTablePageSlot, type EqxTablePageWindow } from './EqxTable/tablePaging.js';
export { EqxWindow, type EqxWindowProps } from './EqxWindow/EqxWindow.js';
export { onGameWindowOpen, notifyGameWindowOpen, isAnyWindowOpen, useAnyWindowOpen } from './EqxWindow/windowOpen.js';
