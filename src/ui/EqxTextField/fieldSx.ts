/**
 * The panel field look (mock `.field`), shared by EqxTextField and EqxDropdown:
 * an MUI filled input with no underline, drawn as an edge2 box; the label
 * sits small and dim at the top-left once there is a value (or focus), and
 * centred in the box while empty. Focus = cyan edge, ring and label.
 * Sizes and colours from `HUD.field`.
 */
import { HUD } from '../../client/hud/tokens.js';

const F = HUD.field;

export const FIELD_SX = {
  '& .MuiFilledInput-root, & .MuiFilledInput-root:hover, & .MuiFilledInput-root.Mui-focused, & .MuiFilledInput-root.Mui-disabled': {
    bgcolor: 'transparent',
  },
  '& .MuiFilledInput-root': {
    fontFamily: HUD.font.label,
    fontSize: F.font,
    color: HUD.color.ink,
    border: 1,
    borderColor: HUD.color.edge2,
    borderRadius: `${HUD.panel.radius}px`,
  },
  '& .MuiFilledInput-root.Mui-focused': {
    borderColor: HUD.color.auto,
    boxShadow: `0 0 0 ${F.focusRing}px ${F.focusRingColor}`,
  },
  '& .MuiFilledInput-root.Mui-error': { borderColor: HUD.color.danger },
  '& .MuiFilledInput-root.Mui-disabled': { opacity: HUD.panel.offOpacity },
  '& .MuiFilledInput-input': {
    pt: `${F.padTop}px`,
    pb: `${F.padBottom}px`,
    pl: `${F.padX}px`,
  },
  // A text input pads both sides; a Select keeps MUI's right padding for its arrow.
  '& .MuiFilledInput-input:not(.MuiSelect-select)': { pr: `${F.padX}px` },
  '& .MuiFilledInput-input.Mui-disabled': { WebkitTextFillColor: HUD.color.ink },
  '& .MuiSelect-icon': { color: HUD.color.inkDim },
  '& .MuiInputLabel-root': {
    fontFamily: HUD.font.label,
    fontSize: F.font,
    color: HUD.color.inkDim,
    transform: `translate(${F.padX}px, ${F.labelRestTop}px) scale(1)`,
  },
  '& .MuiInputLabel-root.MuiInputLabel-shrink': {
    letterSpacing: F.labelTracking,
    transform: `translate(${F.padX}px, ${F.labelTop}px) scale(${F.labelFont / F.font})`,
  },
  '& .MuiInputLabel-root.Mui-focused': { color: HUD.color.auto },
  '& .MuiInputLabel-root.Mui-error': { color: HUD.color.danger },
  '& .MuiInputLabel-root.Mui-disabled': { color: HUD.color.inkDim, opacity: HUD.panel.offOpacity },
  '& .MuiFormHelperText-root': { fontFamily: HUD.font.label, fontSize: HUD.list.rowSmallFont, mx: `${F.padX}px` },
  '& .MuiFormHelperText-root.Mui-error': { color: HUD.color.danger },
} as const;

/** The option list (mock kit `.kmenu`): window paper, edge2 box, dim items, picked = cyan wash. */
export const FIELD_MENU_PAPER_SX = {
  bgcolor: HUD.color.paper,
  backgroundImage: 'none',
  border: 1,
  borderColor: HUD.color.edge2,
  borderRadius: `${HUD.panel.radius}px`,
  '& .MuiList-root': { p: `${F.menuPad}px` },
} as const;

export const FIELD_MENU_ITEM_SX = {
  fontFamily: HUD.font.label,
  fontSize: F.font,
  color: HUD.color.inkDim,
  py: `${F.itemPadY}px`,
  px: `${F.itemPadX}px`,
  borderRadius: `${HUD.panel.radius}px`,
  '&.Mui-selected, &.Mui-selected:hover, &.Mui-selected.Mui-focusVisible': {
    bgcolor: F.itemSelectedBg,
    color: HUD.color.auto,
  },
} as const;
