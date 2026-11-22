import { HUD } from '../hud/tokens.js';

/**
 * The in-game Dialog look (ShipDetailModal, UpgradeModal, the loot window):
 * opaque navy paper, a thin slate edge, a green title. One place, so every
 * game dialog looks the same. Colours come from `hud/tokens.ts`.
 */
export const GAME_DIALOG_BG = HUD.color.dialogBg;
export const GAME_DIALOG_EDGE = HUD.color.dialogEdge;
export const GAME_DIALOG_PAPER_SX = { bgcolor: GAME_DIALOG_BG, border: `1px solid ${GAME_DIALOG_EDGE}` } as const;
export const GAME_DIALOG_TITLE_SX = { bgcolor: GAME_DIALOG_BG, color: HUD.color.brand, display: 'flex', alignItems: 'center', gap: 1.5 } as const;
export const GAME_DIALOG_CONTENT_SX = { bgcolor: GAME_DIALOG_BG, color: HUD.color.dialogInk } as const;
export const GAME_DIALOG_ACTIONS_SX = { bgcolor: GAME_DIALOG_BG, justifyContent: 'flex-end', gap: 1, px: 2.5, pb: 2 } as const;
