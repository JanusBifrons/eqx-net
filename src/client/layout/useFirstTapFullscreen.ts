import { useEffect } from 'react';
import { useFullscreen } from './useFullscreen';
import { isStandaloneNow } from './useStandalone';
import { isTouchDevice } from '../input/TouchInput';

/**
 * First-tap full screen (UI language plan B4, U5-3): while `active` (the game
 * phase), the first tap on a touch browser asks for full screen through
 * `useFullscreen`, the same enter the cog's Full screen switch uses. Once per
 * game: if the player leaves full screen, the cog switch brings it back.
 *
 * Never by itself: browsers grant full screen only inside a user gesture, so
 * it waits for a tap (`pointerup` counts as one; `pointerdown` from a touch
 * does not). Desktop and an installed app (already full screen) do nothing.
 * Where the browser can't go full screen (iOS Safari) nothing shows: the cog's
 * Install row is the way there.
 */
export function useFirstTapFullscreen(active: boolean): void {
  const { enterFullscreen } = useFullscreen();
  useEffect(() => {
    if (!active || !isTouchDevice() || isStandaloneNow()) return undefined;
    if (document.fullscreenElement) return undefined;
    const onTap = (): void => {
      window.removeEventListener('pointerup', onTap, true);
      void enterFullscreen();
    };
    window.addEventListener('pointerup', onTap, true);
    return () => window.removeEventListener('pointerup', onTap, true);
  }, [active, enterFullscreen]);
}
