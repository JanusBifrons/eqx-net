import { afterEach, describe, expect, it, vi } from 'vitest';
import { lockLandscape } from './useFullscreen';
import { isStandaloneNow } from './useStandalone';

/**
 * The installed app locks sideways at launch (main.tsx): Android bakes the
 * manifest's `orientation` in at install and refreshes it late, so the
 * runtime lock is what makes an existing install play sideways.
 */
afterEach(() => vi.unstubAllGlobals());

function stubWindow(modes: string[], iosStandalone = false): void {
  vi.stubGlobal('window', {
    matchMedia: (q: string) => ({ matches: modes.some((m) => q.includes(m)) }),
    navigator: { standalone: iosStandalone },
  });
}

describe('isStandaloneNow()', () => {
  it('true for an installed Android app (display-mode fullscreen or standalone)', () => {
    stubWindow(['fullscreen']);
    expect(isStandaloneNow()).toBe(true);
    stubWindow(['standalone']);
    expect(isStandaloneNow()).toBe(true);
  });
  it('true for an iOS home-screen app', () => {
    stubWindow([], true);
    expect(isStandaloneNow()).toBe(true);
  });
  it('false in a browser tab', () => {
    stubWindow(['browser']);
    expect(isStandaloneNow()).toBe(false);
  });
});

describe('lockLandscape()', () => {
  it('asks the screen for a landscape lock', () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('screen', { orientation: { lock } });
    lockLandscape();
    expect(lock).toHaveBeenCalledWith('landscape');
  });
  it('swallows a refused lock and does nothing without the API (iOS)', async () => {
    const lock = vi.fn().mockRejectedValue(new Error('NotSupportedError'));
    vi.stubGlobal('screen', { orientation: { lock } });
    expect(() => lockLandscape()).not.toThrow();
    await Promise.resolve();
    vi.stubGlobal('screen', {});
    expect(() => lockLandscape()).not.toThrow();
  });
});
