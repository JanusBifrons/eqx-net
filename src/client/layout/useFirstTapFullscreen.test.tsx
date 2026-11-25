import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFirstTapFullscreen } from './useFirstTapFullscreen';

/**
 * First-tap full screen (UI plan U5-3): in game, the first tap on a touch
 * browser asks for full screen once; never by itself, never on desktop or in
 * an installed app.
 */
let request: ReturnType<typeof vi.fn>;

function setMedia(coarse: boolean, standalone = false): void {
  window.matchMedia = ((q: string) => ({
    matches: (coarse && q.includes('pointer: coarse')) || (standalone && q.includes('display-mode: standalone')),
    addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

const tap = (): void => { window.dispatchEvent(new Event('pointerup')); };

beforeEach(() => {
  request = vi.fn().mockResolvedValue(undefined);
  (document.documentElement as unknown as { requestFullscreen: unknown }).requestFullscreen = request;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('useFirstTapFullscreen', () => {
  it('a phone in game asks for full screen on the first tap only, never before it', () => {
    setMedia(true);
    renderHook(() => useFirstTapFullscreen(true));
    expect(request).not.toHaveBeenCalled();
    tap();
    tap();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('outside the game a tap does nothing', () => {
    setMedia(true);
    renderHook(() => useFirstTapFullscreen(false));
    tap();
    expect(request).not.toHaveBeenCalled();
  });

  it('desktop and an installed app never ask', () => {
    setMedia(false); // jsdom has no touch points: a desktop browser
    const desk = renderHook(() => useFirstTapFullscreen(true));
    tap();
    desk.unmount();
    setMedia(true, true);
    renderHook(() => useFirstTapFullscreen(true));
    tap();
    expect(request).not.toHaveBeenCalled();
  });

  it('leaving the game before a tap drops the listener', () => {
    setMedia(true);
    const h = renderHook(({ on }) => useFirstTapFullscreen(on), { initialProps: { on: true } });
    h.rerender({ on: false });
    tap();
    expect(request).not.toHaveBeenCalled();
  });
});
