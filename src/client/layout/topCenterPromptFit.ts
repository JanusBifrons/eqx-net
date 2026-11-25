/**
 * Keeps the top-centre prompts (`top-center-prompt` anchor, EqxPrompt) just
 * under the top-centre HUD column (status capsule, lock band, disabled
 * countdown, pilot toggle), never over it: the prompt anchor draws on a
 * higher z tier (`Z.prompt`), so it must sit below the column, not on it.
 *
 * Writes `--hud-tc-bottom` on :root: the bottom edge of the `top-center` host,
 * 0px while the column is empty (the anchor then falls back to the safe top).
 * DOM-only: nothing goes in the store.
 */
import { useEffect } from 'react';

/** Pure: the anchor variable for the top-centre host's bottom edge and height (px). */
export function topCenterPromptVars(bottom: number, height: number): Record<string, string> {
  return { '--hud-tc-bottom': height > 0 ? `${Math.max(0, Math.round(bottom))}px` : '0px' };
}

/** Measures the `top-center` host while it is mounted, writing the var on :root. */
export function useTopCenterPromptFit(host: HTMLElement | null): void {
  useEffect(() => {
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement.style;
    const write = (): void => {
      const r = host.getBoundingClientRect();
      const vars = topCenterPromptVars(r.bottom, r.height);
      for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    };
    const ro = new ResizeObserver(write);
    ro.observe(host);
    window.addEventListener('resize', write);
    write();
    return () => { ro.disconnect(); window.removeEventListener('resize', write); root.setProperty('--hud-tc-bottom', '0px'); };
  }, [host]);
}
