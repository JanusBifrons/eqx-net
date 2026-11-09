/**
 * Should the Pixi ticker pause while a drawer / the galaxy overview covers
 * the game?
 *
 * Only under the E2E harness: at 60 Hz Pixi's rAF tax starves Playwright's
 * CDP loop (~500 ms median roundtrip, docs/LESSONS.md 2026-05-13 §6), so
 * drawer-heavy specs time out. Real players always keep 60 fps underneath.
 *
 * The flag is EXPLICIT — `?e2ePause=1`, or `localStorage.eqxE2ePause === '1'`
 * (seeded by the e2e projects' storageState in `tests/e2e/global-setup.ts`).
 * It used to be inferred from `navigator.webdriver`, which also froze the
 * game behind every menu in the Playwright showcase recorder (2026-11-08,
 * trade-deal shot: 1.2–1.5 s frame gaps). Never key it on webdriver again.
 */
export const E2E_PAUSE_PARAM = 'e2ePause';
export const E2E_PAUSE_STORAGE_KEY = 'eqxE2ePause';

export function shouldPauseTickerUnderUi(
  search: string,
  storage: Pick<Storage, 'getItem'> | null | undefined,
): boolean {
  if (new URLSearchParams(search).get(E2E_PAUSE_PARAM) === '1') return true;
  try {
    return storage?.getItem(E2E_PAUSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** `window.localStorage`, or null where reading it throws (blocked site data). */
export function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
