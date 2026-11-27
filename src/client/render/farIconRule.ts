/**
 * The far-zoom "icon only" rule (pure, no pixi), shared by
 * `pixi/FarZoomIcons.ts` (which re-exports it) and the selection-HUD world
 * tag's compact switch (S10, `hud/worldTag.ts`), so both flip at the same
 * on-screen size with the same hysteresis.
 *
 * Thresholds, in CSS px of the TRUE sprite's on-screen diameter.
 *  - `sizePx`: the icon's constant on-screen size.
 *  - `fadeStartPx`: the icon starts to fade in below this.
 *  - `solidPx`: the icon is fully opaque at and below this, and the sprite
 *    stops rendering (it would be no bigger than the icon covering it).
 *  - `hysteresis`: the sprite comes back only above `solidPx × hysteresis`.
 */
export const FAR_ICON = { sizePx: 10, fadeStartPx: 14, solidPx: 8, hysteresis: 1.25 } as const;

/** Sprite hidden (icon only), with hysteresis: enter below `solidPx`, leave
 *  above `solidPx × hysteresis`. Pure. */
export function isIconOnly(screenDiamPx: number, wasIconOnly: boolean): boolean {
  return wasIconOnly
    ? screenDiamPx < FAR_ICON.solidPx * FAR_ICON.hysteresis
    : screenDiamPx < FAR_ICON.solidPx;
}
