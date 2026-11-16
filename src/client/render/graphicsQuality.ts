/**
 * Graphics quality: optional, cosmetic-only settings against aliasing
 * (branch exp/antialias). Same pattern as the other Settings → Graphics
 * choices in `art/artMode.ts`: a URL param wins, else the player's saved
 * choice on this device, else the default (today's look). Resolved once on the
 * main thread and carried to the renderer inside `ArtOptions.quality` (and on
 * BOOT to the render worker, which has no `window`).
 *
 *  - `?aa=off|msaa|fxaa|max` — edge smoothing. `msaa` is today (the canvas's
 *    4× multisampling: smooths polygon edges, not detail inside textures);
 *    `fxaa` is a post pass over the world (smooths every edge, textures
 *    included, slightly soft); `max` is both; `off` the cheapest.
 *  - `?renderscale=0.75|1|1.5|2` — the drawing buffer against the screen's
 *    own pixels. Above 1 is supersampling (every edge and texture smoother,
 *    GPU cost ~scale²); 0.75 saves fill on weak phones.
 *  - `?texsoft=0|0.5|1` — mip bias on lit hulls: a softer texture far away
 *    so fine panel lines stop crawling as ships turn (mip levels, not a blur
 *    pass: free).
 */

export type EdgeSmoothing = 'off' | 'msaa' | 'fxaa' | 'max';

/** Plain data only: crosses the worker boundary in BOOT. */
export interface GraphicsQuality {
  aa: EdgeSmoothing;
  renderScale: number;
  texSoft: number;
}

export const DEFAULT_GRAPHICS_QUALITY: Readonly<GraphicsQuality> = { aa: 'msaa', renderScale: 1, texSoft: 0 };

export const EDGE_SMOOTHING_LEVELS: readonly EdgeSmoothing[] = ['off', 'msaa', 'fxaa', 'max'];
export const RENDER_SCALES: readonly number[] = [0.75, 1, 1.5, 2];
export const TEX_SOFT_LEVELS: readonly number[] = [0, 0.5, 1];

/** Largest drawing-buffer side (px) supersampling may ask for. */
export const MAX_BUFFER_SIDE = 4096;

const isAa = (v: unknown): v is EdgeSmoothing => typeof v === 'string' && (EDGE_SMOOTHING_LEVELS as readonly string[]).includes(v);
const isScale = (v: unknown): v is number => typeof v === 'number' && RENDER_SCALES.includes(v);
const isSoft = (v: unknown): v is number => typeof v === 'number' && TEX_SOFT_LEVELS.includes(v);

/** URL overrides; each absent or unknown value is left out. */
export function readGraphicsQualityParams(search: string): Partial<GraphicsQuality> {
  const out: Partial<GraphicsQuality> = {};
  const aa = /[?&]aa=(off|msaa|fxaa|max)\b/.exec(search);
  if (aa) out.aa = aa[1] as EdgeSmoothing;
  const rs = /[?&]renderscale=([0-9.]+)/.exec(search);
  if (rs && isScale(Number(rs[1]))) out.renderScale = Number(rs[1]);
  const ts = /[?&]texsoft=([0-9.]+)/.exec(search);
  if (ts && isSoft(Number(ts[1]))) out.texSoft = Number(ts[1]);
  return out;
}

/** URL > saved > default, per setting. */
export function resolveGraphicsQuality(search: string, saved: Partial<GraphicsQuality> | null): GraphicsQuality {
  return { ...DEFAULT_GRAPHICS_QUALITY, ...(saved ?? {}), ...readGraphicsQualityParams(search) };
}

/**
 * The renderer resolution for a screen of `w`×`h` CSS px at `dpr`: the
 * screen's density times the render scale, held so neither buffer side
 * passes `MAX_BUFFER_SIDE` (never below the screen's own density, so the
 * cap only trims supersampling).
 */
export function renderResolution(dpr: number, scale: number, w: number, h: number): number {
  const want = dpr * scale;
  if (scale <= 1) return want;
  const side = Math.max(1, w, h);
  return Math.max(dpr, Math.min(want, MAX_BUFFER_SIDE / side));
}

// ---------------------------------------------------------------- the setting

const KEY = 'eqxGfxQuality';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};

/** The saved choices on this device (only the valid ones), or null. */
export function loadGraphicsQualityPreference(store: Store | null = defaultStore()): Partial<GraphicsQuality> | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<GraphicsQuality> = {};
    if (isAa(v['aa'])) out.aa = v['aa'];
    if (isScale(v['renderScale'])) out.renderScale = v['renderScale'];
    if (isSoft(v['texSoft'])) out.texSoft = v['texSoft'];
    return out;
  } catch {
    return null;
  }
}

export function saveGraphicsQualityPreference(q: GraphicsQuality, store: Store | null = defaultStore()): void {
  try { store?.setItem(KEY, JSON.stringify(q)); } catch { /* blocked storage: not saved */ }
}
