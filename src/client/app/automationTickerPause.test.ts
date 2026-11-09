/**
 * The Pixi ticker pause while a drawer / the galaxy overview covers the game
 * is an E2E-harness workaround (CDP starvation, docs/LESSONS.md 2026-05-13
 * §6). It used to key on `navigator.webdriver`, so the Playwright showcase
 * recorder filmed a frozen game behind every menu (trade-deal shot: 1.2–1.5 s
 * frame gaps). It must key on an explicit flag the E2E harness sets, never on
 * automation being detected.
 */
import { describe, it, expect } from 'vitest';
import { shouldPauseTickerUnderUi } from './automationTickerPause';

const noStorage = { getItem: () => null };

describe('shouldPauseTickerUnderUi', () => {
  it('does not pause under plain automation (webdriver) — the showcase recorder must film a live game', () => {
    expect(shouldPauseTickerUnderUi('', noStorage)).toBe(false);
    expect(shouldPauseTickerUnderUi('?room=sector', noStorage)).toBe(false);
  });

  it('pauses when the E2E harness sets ?e2ePause=1', () => {
    expect(shouldPauseTickerUnderUi('?room=sector&e2ePause=1', noStorage)).toBe(true);
    expect(shouldPauseTickerUnderUi('?e2ePause=0', noStorage)).toBe(false);
  });

  it('pauses when the E2E storageState seeds localStorage.eqxE2ePause=1', () => {
    expect(shouldPauseTickerUnderUi('', { getItem: (k) => (k === 'eqxE2ePause' ? '1' : null) })).toBe(true);
  });

  it('treats an unreadable localStorage as "no flag"', () => {
    const throwing = { getItem: (): string | null => { throw new Error('SecurityError'); } };
    expect(shouldPauseTickerUnderUi('', throwing)).toBe(false);
  });
});
