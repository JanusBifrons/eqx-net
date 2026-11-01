/**
 * Radar (off-screen indicator) preferences — plan sparkling-wondering-rose.
 *
 * ONE schema + per-DEVICE defaults. Desktop and touch are separate designs (a
 * phone is not a scaled-down monitor), and saved overrides are stored per device
 * class (Wave 2 / PR 3b). Rationale for every default value:
 * docs/architecture/off-screen-indicators.md §3–4.
 *
 * Flat scalars only (Zustand purity, invariant #2 — no spatial keys), and the
 * object is structured-cloneable (it crosses the renderer worker boundary).
 */
import { z } from 'zod';

export const RADAR_PREFS_VERSION = 1;

export const DEVICE_CLASSES = ['desktop', 'touch'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/** Radar-only contact categories. The first four share the entity visual
 *  language (`entityVisuals.ts`); asteroid / scrap / lingering are radar-only
 *  and OFF by default. Append-only order (it is the UI row order). */
export const RADAR_CATEGORIES = [
  'hostile',
  'player',
  'neutral',
  'structure',
  'asteroid',
  'scrap',
  'lingering',
  // Living World P1a-2: loot pods + derelicts (cargo-pod scrap). ON by default.
  'loot',
  // Living World P2: trade haulers (traders side). ON by default.
  'trader',
] as const;
export type RadarCategory = (typeof RADAR_CATEGORIES)[number];

export const RADAR_SHAPES = ['star', 'diamond', 'triangle', 'hexagon', 'circle', 'square'] as const;
export type RadarShape = (typeof RADAR_SHAPES)[number];

const CategorySchema = z
  .object({
    enabled: z.boolean(),
    shape: z.enum(RADAR_SHAPES),
    /** 0xRRGGBB */
    color: z.number().int().min(0).max(0xffffff),
    /** Multiplies the distance-derived icon size. */
    sizeMul: z.number().min(0.25).max(3),
    /** Multiplies the distance-derived opacity. */
    opacityMul: z.number().min(0).max(2),
  })
  .strict();
export type RadarCategoryPrefs = z.infer<typeof CategorySchema>;

export const RadarPrefsSchema = z
  .object({
    /** Gap between the icon track and the screen edge (CSS px). */
    edgeInsetPx: z.number().min(0).max(120),
    /** Icon diameter for a contact just off-screen / at saturation distance. */
    sizeNearPx: z.number().min(2).max(48),
    sizeFarPx: z.number().min(2).max(48),
    /** Hostile icons never draw smaller than this (legibility of the star). */
    hostileMinSizePx: z.number().min(0).max(48),
    opacityNear: z.number().min(0).max(1),
    opacityFar: z.number().min(0).max(1),
    /** Shapes the near→far ramp: 1 = log-linear, >1 holds "near" longer. */
    sizeGamma: z.number().min(0.25).max(4),
    /** Log-curve knee (world units beyond the screen edge). */
    nearDistance: z.number().min(10).max(20_000),
    /** World units beyond the screen edge at which a contact reads as "far". */
    farDistance: z.number().min(100).max(50_000),
    /** Absolute range cutoff from the radar reference point (world units). */
    maxRange: z.number().min(500).max(100_000),
    /** Fraction of `maxRange` over which icons fade out (no pop). */
    fadeBand: z.number().min(0).max(1),
    /** A contact that was on screen re-appears on the radar only once it is
     *  this many CSS px fully outside the viewport (anti-flicker). */
    hysteresisPx: z.number().min(0).max(120),
    /** Minimum spacing between neighbouring icons along the edge (CSS px). */
    minSpacingPx: z.number().min(0).max(80),
    maxIcons: z.number().int().min(1).max(64),
    /** Faint glow under hostile icons. */
    hostileGlow: z.boolean(),
    categories: z
      .object({
        hostile: CategorySchema,
        player: CategorySchema,
        neutral: CategorySchema,
        structure: CategorySchema,
        asteroid: CategorySchema,
        scrap: CategorySchema,
        lingering: CategorySchema,
        loot: CategorySchema,
        trader: CategorySchema,
      })
      .strict(),
  })
  .strict();
export type RadarPrefs = z.infer<typeof RadarPrefsSchema>;

function categories(touch: boolean): RadarPrefs['categories'] {
  return {
    hostile: { enabled: true, shape: 'star', color: 0xff6b6b, sizeMul: 1, opacityMul: 1 },
    player: { enabled: true, shape: 'triangle', color: 0x6bff9b, sizeMul: 1, opacityMul: 1 },
    neutral: { enabled: true, shape: 'diamond', color: 0xffd479, sizeMul: touch ? 0.9 : 1, opacityMul: 0.9 },
    structure: { enabled: true, shape: 'hexagon', color: 0x9ab4dd, sizeMul: 1, opacityMul: 0.9 },
    asteroid: { enabled: false, shape: 'circle', color: 0x9a8f80, sizeMul: 0.8, opacityMul: 0.7 },
    scrap: { enabled: false, shape: 'square', color: 0xb8b8b8, sizeMul: 0.7, opacityMul: 0.7 },
    lingering: { enabled: false, shape: 'triangle', color: 0x6b9b7b, sizeMul: 0.9, opacityMul: 0.7 },
    loot: { enabled: true, shape: 'circle', color: 0xffc94a, sizeMul: touch ? 0.8 : 0.9, opacityMul: 0.9 },
    trader: { enabled: true, shape: 'square', color: 0x7fd6a8, sizeMul: 1, opacityMul: 0.95 },
  };
}

/** The researched defaults (docs/architecture/off-screen-indicators.md §4). */
export const DEFAULT_RADAR_PREFS: Readonly<Record<DeviceClass, RadarPrefs>> = {
  desktop: {
    edgeInsetPx: 20,
    sizeNearPx: 12,
    sizeFarPx: 7,
    hostileMinSizePx: 8,
    opacityNear: 0.75,
    opacityFar: 0.2,
    sizeGamma: 1,
    nearDistance: 500,
    farDistance: 4000,
    maxRange: 10_000,
    fadeBand: 0.15,
    hysteresisPx: 16,
    minSpacingPx: 12,
    maxIcons: 24,
    hostileGlow: true,
    categories: categories(false),
  },
  touch: {
    edgeInsetPx: 14,
    sizeNearPx: 10,
    sizeFarPx: 6,
    hostileMinSizePx: 7,
    opacityNear: 0.85,
    opacityFar: 0.35,
    sizeGamma: 1,
    nearDistance: 500,
    farDistance: 4000,
    maxRange: 10_000,
    fadeBand: 0.15,
    hysteresisPx: 12,
    minSpacingPx: 10,
    maxIcons: 12,
    hostileGlow: true,
    categories: categories(true),
  },
};

export function defaultRadarPrefs(device: DeviceClass): RadarPrefs {
  return structuredCloneRadarPrefs(DEFAULT_RADAR_PREFS[device]);
}

/** Deep copy without `structuredClone` (not on every target runtime). */
export function structuredCloneRadarPrefs(p: RadarPrefs): RadarPrefs {
  const cats = {} as RadarPrefs['categories'];
  for (const c of RADAR_CATEGORIES) cats[c] = { ...p.categories[c] };
  return { ...p, categories: cats };
}

/** Screen-space HUD geometry the radar must keep clear of (CSS px). Measured on
 *  the main thread from the layout slot hosts; pushed to the renderer. */
export interface RadarInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Rectangles (x, y, w, h) occupied by HUD widgets near the edge. */
  exclusions: Array<{ x: number; y: number; w: number; h: number }>;
}

export const EMPTY_RADAR_INSETS: RadarInsets = { top: 0, right: 0, bottom: 0, left: 0, exclusions: [] };
