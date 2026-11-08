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
import { defaultLightingPreset, lightingFromSearch, presetSettings, type LightingPreset, type LightingSettings } from './lightingSettings.js';

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
  const sl = readShipLight(search);
  if (explicit === null && sl !== null && sl !== 'baked') return 'machined';
  return explicit ?? saved ?? (isAutomation ? 'classic' : 'machined');
}

/** `?shiplight=gpu|high|medium|low|baked` (gpu = high), or null. */
export function readShipLight(search: string): LightingPreset | null {
  const m = /[?&]shiplight=(gpu|high|medium|low|baked)\b/.exec(search);
  if (!m) return null;
  return m[1] === 'gpu' ? 'high' : (m[1] as LightingPreset);
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

export interface ShipLightingContext {
  /** The player's saved level on this device (Settings), or null. */
  saved?: LightingPreset | null;
  touch?: boolean;
  deviceMemoryGb?: number;
  /** Automated browsers keep the baked look unless the URL asks (tests and
   *  the netgate stay deterministic; same rule as the art mode). */
  automation?: boolean;
}

/**
 * GPU lighting: the URL (`?shiplight=`) wins, then the saved level, then the
 * device's default (`defaultLightingPreset`). `look=` and the per-feature
 * switches (lightingSettings.ts) adjust any live level. Only with the
 * Machined art; `baked` (or an automated browser that didn't ask) = today's
 * baked art. With no context, nothing is saved and it behaves as automation.
 */
export function resolveShipLighting(search: string, mode: ArtMode, ctx: ShipLightingContext = { automation: true }): LightingSettings | undefined {
  if (mode !== 'machined') return undefined;
  const url = readShipLight(search);
  const level = url ?? (ctx.automation ? 'baked' : ctx.saved ?? defaultLightingPreset(ctx.touch === true, ctx.deviceMemoryGb));
  if (level === 'baked') return undefined;
  return lightingFromSearch(search, presetSettings(level));
}

// ---------------------------------------------------------------- the lighting setting

const LIGHT_KEY = 'eqxShipLight';

/** The player's saved lighting level on this device, or null. */
export function loadLightingPreference(store: Pick<Storage, 'getItem'> | null = lightStore()): LightingPreset | null {
  try {
    const v = store?.getItem(LIGHT_KEY);
    return v === 'baked' || v === 'low' || v === 'medium' || v === 'high' ? v : null;
  } catch {
    return null;
  }
}

export function saveLightingPreference(p: LightingPreset, store: Pick<Storage, 'setItem'> | null = lightStore()): void {
  try { store?.setItem(LIGHT_KEY, p); } catch { /* blocked storage: not saved */ }
}

function lightStore(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
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
