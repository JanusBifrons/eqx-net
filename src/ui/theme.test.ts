import { describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material';
import { HUD } from '../client/hud/tokens.js';
import { THEME_PALETTE, eqxTheme } from './theme.js';

/** The palette as it was before the theme moved to tokens (main.tsx createTheme). */
const TODAY = { primary: '#00ff88', backgroundDefault: '#05070f', backgroundPaper: '#0d1117' } as const;

describe('eqxTheme', () => {
  it('every palette value comes from a token and equals today\'s value', () => {
    const tokenValues = new Set<string>(Object.values(HUD.color));
    for (const v of Object.values(THEME_PALETTE)) expect(tokenValues.has(v)).toBe(true);
    expect(eqxTheme.palette.primary.main).toBe(HUD.color.brand);
    expect(eqxTheme.palette.background.default).toBe(HUD.color.appBg);
    expect(eqxTheme.palette.background.paper).toBe(HUD.color.appPaper);
    expect(eqxTheme.palette.primary.main).toBe(TODAY.primary);
    expect(eqxTheme.palette.background.default).toBe(TODAY.backgroundDefault);
    expect(eqxTheme.palette.background.paper).toBe(TODAY.backgroundPaper);
    expect(eqxTheme.palette.mode).toBe('dark');
  });

  it('font comes from the HUD label token', () => {
    expect(eqxTheme.typography.fontFamily).toBe(HUD.font.label);
  });

  it('slide motion comes from tokens and matches MUI defaults (no visible change)', () => {
    const base = createTheme();
    expect(eqxTheme.transitions.duration.enteringScreen).toBe(HUD.motion.slideInMs);
    expect(eqxTheme.transitions.duration.leavingScreen).toBe(HUD.motion.slideOutMs);
    expect(eqxTheme.transitions.easing.easeOut).toBe(HUD.motion.slideEasing);
    expect(HUD.motion.slideInMs).toBe(base.transitions.duration.enteringScreen);
    expect(HUD.motion.slideOutMs).toBe(base.transitions.duration.leavingScreen);
    expect(HUD.motion.slideEasing).toBe(base.transitions.easing.easeOut);
  });

  it('size tokens follow plan B3', () => {
    expect(HUD.size.railPhone).toBe(48);
    expect(HUD.size.railDesktop).toBe(56);
    expect(HUD.size.iconButton).toBeGreaterThanOrEqual(HUD.touchMin);
  });
});

describe('the other two palettes read tokens and keep today\'s colours', () => {
  it('game dialog chrome', async () => {
    const d = await import('../client/components/gameDialogChrome.js');
    expect(d.GAME_DIALOG_BG).toBe(HUD.color.dialogBg);
    expect(d.GAME_DIALOG_BG).toBe('#0c1020');
    expect(d.GAME_DIALOG_PAPER_SX.border).toBe('1px solid #2a2f40');
    expect(d.GAME_DIALOG_TITLE_SX.color).toBe('#00ff88');
    expect(d.GAME_DIALOG_CONTENT_SX.color).toBe('#ccc');
  });

  it('side panel paper', async () => {
    const s = await import('../client/components/SidePanel.js');
    const sx = s.rightPaperSx(s.SECTOR_PANEL_SIZE, false);
    expect(sx['bgcolor']).toBe('rgba(8,12,24,0.98)');
    expect(sx['color']).toBe('#dffff0');
    expect(sx['border']).toBe('1px solid #2a3550');
    expect(sx['bgcolor']).toBe(HUD.color.sidePanelBg);
  });
});
