/**
 * Cinematic HUD mode — how much of the DOM HUD is visible over the canvas.
 *
 *  - `full`    normal play (default).
 *  - `clean`   the full interactive HUD (speed-dial, inspector, banners) minus
 *              debug-ish chrome: the sector-info panel (shows raw engineering
 *              room names), the pilot/spectate toggle and the idle
 *              "Nothing incoming" chip — the look for UI-driven footage.
 *  - `minimal` `clean`, and also keeps only the top status bars (shield/hull, energy, grid power) and
 *              the transit overlay; hides the header, thumb controls, speed-dial
 *              and drawer — the look for gameplay footage.
 *  - `none`    a clean frame: only the canvas (plus the transit/warp overlay,
 *              which IS the effect being filmed).
 *
 * Implemented as one class on `<html>` (`eqx-hud-<mode>`) styled in
 * `index.html`. No store field, no React re-render — the capture pipeline flips
 * it mid-take via `__eqxCinema.setHud`. Pure helpers below are unit-locked.
 */
export type HudMode = 'full' | 'clean' | 'minimal' | 'none';

const HUD_MODES: readonly HudMode[] = ['full', 'clean', 'minimal', 'none'];

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

/**
 * Fire-control lock visuals in the WORLD (Pixi): lock rings, brackets and
 * firing lines on your targets, threat arcs and pulsing diamonds on ships
 * locking you, the hover outline, and structure turret range rings and aim
 * lines. They are HUD, not scenery, so only `full` shows them (the `fc-*`
 * showcase shots film fire control with `hud=full`). The DOM lock banner
 * (`fc-lock-band`) follows the same rule through the `<html>` class
 * (`index.html`). The renderer gets this via `IRenderer.setHudOverlays`.
 */
export function lockOverlaysVisible(mode: HudMode): boolean {
  return mode === 'full';
}

/**
 * The off-screen edge radar. Hidden with the rest of the HUD below `full`,
 * except that `?radar=1` keeps it (the radar showcase shot films it in
 * `minimal`).
 */
export function radarVisible(mode: HudMode, search: string): boolean {
  return mode === 'full' || /[?&]radar=1(?:&|$)/.test(search);
}

/** Push the HUD mode's world-overlay switches to the renderer (both paths). */
export function applyHudOverlays(
  renderer: { setHudOverlays(lockMarks: boolean, radar: boolean): void } | null | undefined,
  mode: HudMode,
  search: string,
): void {
  renderer?.setHudOverlays(lockOverlaysVisible(mode), radarVisible(mode, search));
}
