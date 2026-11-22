/**
 * Desktop keys for the Build panel (panels/BuildPanel.tsx), the one build surface.
 * While it is open: 1–9 pick the Nth kind tile of the open category (the same
 * action as clicking that tile), Q / E step to the previous / next category.
 * These moved here from the old bottom build hotbar (BottomControlPanel), whose
 * number keys picked the Nth building of a flattened palette.
 *
 * The panel is open while the store's one panel flag is `rightPanel === 'build'`
 * (UI language plan U2-1); the fire-control keys (MouseLock.ts `installFcKeys`)
 * read it here and stand down meanwhile, so 1–9 do not also switch weapon groups.
 */
import { useUIStore } from '../state/store';

/** Is the Build panel open (its keys own 1–9 / Q / E)? */
export function buildMenuKeysOpen(): boolean {
  return useUIStore.getState().rightPanel === 'build';
}

export type BuildMenuKeyAction = { kind: 'pick'; index: number } | { kind: 'step'; delta: -1 | 1 };

/** Pure: key event → Build panel key action (null = not ours). */
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
