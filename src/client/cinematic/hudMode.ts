/**
 * Cinematic HUD mode — how much of the DOM HUD is visible over the canvas.
 *
 *  - `full`    normal play (default).
 *  - `minimal` keeps the top status bars (shield/hull, energy, grid power) and
 *              the transit overlay; hides the header, thumb controls, speed-dial
 *              and drawer — the look for gameplay footage.
 *  - `none`    a clean frame: only the canvas (plus the transit/warp overlay,
 *              which IS the effect being filmed).
 *
 * Implemented as one class on `<html>` (`eqx-hud-<mode>`) styled in
 * `index.html`. No store field, no React re-render — the capture pipeline flips
 * it mid-take via `__eqxCinema.setHud`. Pure helpers below are unit-locked.
 */
export type HudMode = 'full' | 'minimal' | 'none';

const HUD_MODES: readonly HudMode[] = ['full', 'minimal', 'none'];

export function isHudMode(v: unknown): v is HudMode {
  return typeof v === 'string' && (HUD_MODES as readonly string[]).includes(v);
}

/** `?hud=<mode>` wins; `?cinematic=1` alone means `none`; otherwise `full`. */
export function hudModeFromSearch(search: string): HudMode {
  const p = new URLSearchParams(search);
  const hud = p.get('hud');
  if (isHudMode(hud)) return hud;
  return p.get('cinematic') === '1' ? 'none' : 'full';
}

export function hudModeClass(mode: HudMode): string {
  return `eqx-hud-${mode}`;
}

/** Swap the `<html>` class to `mode`. */
export function applyHudMode(mode: HudMode, root: { classList: DOMTokenList } = document.documentElement): void {
  for (const m of HUD_MODES) root.classList.remove(hudModeClass(m));
  root.classList.add(hudModeClass(mode));
}
