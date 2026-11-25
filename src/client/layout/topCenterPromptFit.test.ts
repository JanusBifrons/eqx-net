import { describe, expect, it } from 'vitest';
import { topCenterPromptVars } from './topCenterPromptFit';
import { ANCHOR_STYLES } from './anchors';
import { Z } from './zIndex';

describe('topCenterPromptVars', () => {
  it('is the host bottom edge, rounded, while the column has content', () => {
    expect(topCenterPromptVars(131.6, 60)).toEqual({ '--hud-tc-bottom': '132px' });
  });

  it('is 0px while the column is empty (the anchor falls back to the safe top)', () => {
    expect(topCenterPromptVars(64, 0)).toEqual({ '--hud-tc-bottom': '0px' });
  });
});

describe('top-center-prompt anchor', () => {
  it('sits on the prompt tier, above Windows, under the measured column', () => {
    const s = ANCHOR_STYLES['top-center-prompt'];
    expect(s.zIndex).toBe(Z.prompt);
    expect(Z.prompt).toBeGreaterThan(Z.modal);
    expect(String(s.top)).toContain('var(--hud-tc-bottom');
    expect(ANCHOR_STYLES['top-center'].zIndex).toBe(Z.mobileControls);
  });
});
