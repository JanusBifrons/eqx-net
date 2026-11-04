/**
 * Machined art — which look the renderer draws (plan iridescent-seeking-rainbow).
 *
 * Resolved ONCE on the main thread when the renderer is chosen, then handed
 * to the renderer (and on BOOT to the render worker, which has no `window`).
 * Precedence:
 *  1. `?art=machined|classic` in the URL (testing, A/B);
 *  2. the player's saved choice (Settings → Graphics, per device);
 *  3. automated browsers (`navigator.webdriver`) get `classic`, so bake work
 *     on CI runners can't skew the netcode gate or slow the suite (the same
 *     rule as the WebRTC transport) — the Machined specs ask for it;
 *  4. everyone else gets `machined`.
 */
export type ArtMode = 'classic' | 'machined';

export interface ArtOptions {
  mode: ArtMode;
  /** Test-only bake delay (`?artDelayMs=`). */
  delayMs?: number;
  /** New effects + backdrop (plan iridescent-seeking-rainbow v3). Needs the
   *  Machined art service; off by default until the rollout's last PR. */
  fx?: boolean;
}

export const ART_OFF: ArtOptions = { mode: 'classic' };

export function readArtMode(search: string): ArtMode | null {
  const m = /[?&]art=(classic|machined)\b/.exec(search);
  return m ? (m[1] as ArtMode) : null;
}

export function resolveArtMode(search: string, isAutomation: boolean, saved: ArtMode | null): ArtMode {
  return readArtMode(search) ?? saved ?? (isAutomation ? 'classic' : 'machined');
}

/**
 * The new effects and backdrop (plan iridescent-seeking-rainbow v3). They
 * ride the Machined look (one player switch: Settings → Graphics → Detailed
 * art), so classic art means classic effects. `?fx=new|classic` wins; else
 * on for players, off for automated browsers (the same rule as the art mode:
 * specs that test the effects ask for them).
 */
export function resolveFxMode(search: string, mode: ArtMode, isAutomation = false): boolean {
  if (mode !== 'machined') return false;
  const m = /[?&]fx=(new|classic)\b/.exec(search);
  return m ? m[1] === 'new' : !isAutomation;
}

/** Test-only: delay every bake by this many ms (`?artDelayMs=`), so an E2E can
 *  watch a sprite start in the fallback look and swap once its art is ready. */
export function readArtDelayMs(search: string): number {
  const m = /[?&]artDelayMs=(\d{1,6})\b/.exec(search);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------- the setting

const KEY = 'eqxArtStyle';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** The player's saved look on this device, or null if they never chose. */
export function loadArtPreference(store: Store | null = defaultStore()): ArtMode | null {
  try {
    const v = store?.getItem(KEY);
    return v === 'machined' || v === 'classic' ? v : null;
  } catch {
    return null;
  }
}

export function saveArtPreference(mode: ArtMode, store: Store | null = defaultStore()): void {
  try { store?.setItem(KEY, mode); } catch { /* private mode / blocked storage: not saved */ }
}
