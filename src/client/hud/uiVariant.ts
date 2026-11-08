/**
 * HUD experiment switch (exp/hud-mobile-first). `?ui=a|b|c` picks one of the
 * three experimental piloting HUDs; `?ui=legacy` (or no param and nothing
 * stored) keeps today's HUD untouched so every existing test sees the old UI.
 *
 * The choice is remembered in localStorage so a phone tester only has to add
 * the param once. Read ONCE at module load — switching needs a reload, which
 * keeps the variant out of React state and out of the per-frame loops.
 *
 *  - a: "Corner Clusters"   — floating move stick, big always-on FIRE.
 *  - b: "Twin-Stick"        — floating move + aim sticks, status arcs on ship.
 *  - c: "Smart Attack"      — floating move stick, tap/drag attack button.
 *  - d: "Fire Control"      — weapon groups that fire at LOCKED targets
 *                              (exp/fire-control): weapon strip, smart-aim lock.
 */
export type UiVariant = 'legacy' | 'a' | 'b' | 'c' | 'd';

const KEY = 'eqxHudVariant';
const VARIANTS: readonly UiVariant[] = ['legacy', 'a', 'b', 'c', 'd'];

export function isUiVariant(v: unknown): v is UiVariant {
  return typeof v === 'string' && (VARIANTS as readonly string[]).includes(v);
}

/** Pure resolver (unit-tested): URL param wins, then the stored value. */
export function resolveUiVariant(search: string, stored: string | null): UiVariant {
  const p = new URLSearchParams(search).get('ui');
  if (isUiVariant(p)) return p;
  if (isUiVariant(stored)) return stored;
  return 'legacy';
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function computeInitial(): UiVariant {
  if (typeof window === 'undefined') return 'legacy';
  const v = resolveUiVariant(window.location.search, readStored());
  // Persist only an explicit URL choice, so a stray stored value never
  // changes the UI for someone who didn't ask for it.
  const fromUrl = new URLSearchParams(window.location.search).get('ui');
  if (isUiVariant(fromUrl)) {
    try {
      window.localStorage.setItem(KEY, fromUrl);
    } catch {
      /* private mode — fine, the URL still applies this session */
    }
  }
  return v;
}

const current: UiVariant = computeInitial();

/** The active HUD variant for this page load. */
export function getUiVariant(): UiVariant {
  return current;
}

/** True for any of the experimental HUDs (a/b/c). */
export function isExperimentalHud(): boolean {
  return current !== 'legacy';
}

/** Persist a new choice and reload (Settings picker). */
export function switchUiVariant(v: UiVariant): void {
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('ui', v);
  window.location.href = url.toString();
}

/** Fire control (exp/fire-control): weapon groups fire only at locked targets. */
export function isFireControlHud(): boolean {
  return current === 'd';
}
