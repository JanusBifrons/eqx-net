/**
 * Desktop keys for the Build sidebar (BuildSidebar.tsx), the one build surface.
 * While it is open: 1–9 pick the Nth kind tile of the open category (the same
 * action as clicking that tile), Q / E step to the previous / next category.
 * These moved here from the old bottom build hotbar (BottomControlPanel), whose
 * number keys picked the Nth building of a flattened palette.
 *
 * The sidebar's open flag is BuildSidebarHost's local React state (presentation,
 * never Zustand); the sidebar mirrors it here so the fire-control keys
 * (MouseLock.ts `installFcKeys`) stand down while it is open and 1–9 do not
 * also switch weapon groups.
 */

let open = false;

/** BuildSidebar sets this while it is open (cleared on close / unmount). */
export function setBuildMenuKeysOpen(v: boolean): void {
  open = v;
}

/** Is the Build sidebar open (its keys own 1–9 / Q / E)? */
export function buildMenuKeysOpen(): boolean {
  return open;
}

export type BuildMenuKeyAction = { kind: 'pick'; index: number } | { kind: 'step'; delta: -1 | 1 };

/** Pure: key event → Build sidebar key action (null = not ours). */
export function buildMenuKeyAction(key: string, code: string): BuildMenuKeyAction | null {
  const m = /^Digit([1-9])$/.exec(code);
  if (m) return { kind: 'pick', index: Number(m[1]) - 1 };
  const k = key.toLowerCase();
  if (k === 'q') return { kind: 'step', delta: -1 };
  if (k === 'e') return { kind: 'step', delta: 1 };
  return null;
}

/** Pure: the category `delta` steps from `current`, wrapping at both ends. */
export function stepCategory<T>(ids: readonly T[], current: T, delta: -1 | 1): T {
  const n = ids.length;
  const i = ids.indexOf(current);
  return ids[(((i < 0 ? 0 : i) + delta) % n + n) % n]!;
}
