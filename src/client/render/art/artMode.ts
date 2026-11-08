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
import { LOOK_NIGHT, lightingFromSearch, type LightingSettings } from './lightingSettings.js';

export type ArtMode = 'classic' | 'machined';

export interface ArtOptions {
  mode: ArtMode;
  /** Test-only bake delay (`?artDelayMs=`). */
  delayMs?: number;
  /** New effects + backdrop (plan iridescent-seeking-rainbow v3). Needs the
   *  Machined art service; off by default until the rollout's last PR. */
  fx?: boolean;
  /** Speed effects (C3): dust streaks + a slight zoom-out when flying fast.
   *  Absent means on. Only drawn with the new backdrop (`fx`). */
  speedFx?: boolean;
  /** GPU-lit art (plan prancy-squishing-donut R2, `?shiplight=gpu`): ships,
   *  guns, scrap (and per settings structures and rocks) lit live from maps
   *  instead of baked sun frames. Absent = today's baked art. */
  lighting?: LightingSettings;
}

export const ART_OFF: ArtOptions = { mode: 'classic' };

export function readArtMode(search: string): ArtMode | null {
  const m = /[?&]art=(classic|machined)\b/.exec(search);
  return m ? (m[1] as ArtMode) : null;
}

export function resolveArtMode(search: string, isAutomation: boolean, saved: ArtMode | null): ArtMode {
  // GPU-lit art needs the Machined look: asking for it implies Machined (an
  // automated browser would otherwise get classic and the flag do nothing).
  const explicit = readArtMode(search);
  if (explicit === null && SHIPLIGHT_RE.test(search)) return 'machined';
  return explicit ?? saved ?? (isAutomation ? 'classic' : 'machined');
}

const SHIPLIGHT_RE = /[?&]shiplight=gpu\b/;

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

/**
 * GPU lighting (R&D): `?shiplight=gpu` turns it on with the night-side look;
 * `look=` and the per-feature switches (lightingSettings.ts) adjust it. Only
 * with the Machined art. Off otherwise (today's baked art, unchanged).
 */
export function resolveShipLighting(search: string, mode: ArtMode): LightingSettings | undefined {
  if (mode !== 'machined' || !SHIPLIGHT_RE.test(search)) return undefined;
  return lightingFromSearch(search, LOOK_NIGHT);
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

const SPEED_KEY = 'eqxSpeedFx';

/** Speed effects: `?speedfx=0|1` wins, else the saved choice, else on. */
export function resolveSpeedFx(search: string, saved: boolean | null): boolean {
  const m = /[?&]speedfx=(0|1)\b/.exec(search);
  return m ? m[1] === '1' : saved ?? true;
}

/** The player's saved speed-effects choice on this device, or null. */
export function loadSpeedFxPreference(store: Store | null = defaultStore()): boolean | null {
  try {
    const v = store?.getItem(SPEED_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

export function saveSpeedFxPreference(on: boolean, store: Store | null = defaultStore()): void {
  try { store?.setItem(SPEED_KEY, on ? '1' : '0'); } catch { /* blocked storage: not saved */ }
}

export function saveArtPreference(mode: ArtMode, store: Store | null = defaultStore()): void {
  try { store?.setItem(KEY, mode); } catch { /* private mode / blocked storage: not saved */ }
}
