/**
 * The building settings section's shared row styles (UI language plan U3-6):
 * the Power / Build / Manage pages in the Details panel (StructureSettings.tsx)
 * lay out as a label / value grid in the loot window's palette. Plain style
 * objects, so the pages share one look without each importing the other.
 */
import { HUD } from '../hud/tokens';
import { WINDOW_BTN_SECONDARY_SX } from './GameWindow';

const C = HUD.color;

/** How often the pages re-read the render mirror while shown (4 Hz, like the teleporter panel). */
export const SETTINGS_POLL_MS = 250;

export const GRID_SX = { display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 2, rowGap: 1, fontSize: 13, maxWidth: 420 } as const;
export const LABEL_SX = { color: C.inkDim, fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' as const, alignSelf: 'center' } as const;
export const VALUE_SX = { color: C.ink, textAlign: 'right' as const, fontFamily: HUD.font.num, fontVariantNumeric: 'tabular-nums' } as const;
export const STEPPER_SX = { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1 } as const;
export const STEP_BTN_SX = { ...WINDOW_BTN_SECONDARY_SX, minWidth: 32, px: 1, '&:disabled': { opacity: 0.35, cursor: 'default' } } as const;
export const COUNT_SX = { ...VALUE_SX, minWidth: 64, textAlign: 'center' as const } as const;
export const ROW_SX = { fontSize: 12, color: C.inkDim } as const;
export const BUILD_SX = { labelSx: LABEL_SX, valueSx: VALUE_SX, btnSx: STEP_BTN_SX } as const;
