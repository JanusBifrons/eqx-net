/**
 * The left strip's route doing-tools (UI language plan A5 / U3-3): while a
 * fleet order waits for a target on the map (Zustand `fleetPick`: Patrol,
 * Escort, Retreat), the strip swaps the selection for what you are doing.
 * Icons only; tooltips carry the words.
 *
 * - The top icon says what is being picked (route / escort / retreat); its
 *   tooltip is the plain pick hint (`fleetPickHint`), its badge the patrol's
 *   point count.
 * - Patrol: ✓ (`requestFleetPickDone`, needs 2+ points; also Enter or a mouse
 *   right-click) and undo (`requestFleetPickUndo`: the renderer drops the last
 *   point).
 * - Retreat: ✓ = back to post (retreat with no point through the fleet command
 *   seam, `resolveFleetCommands().setMode(ids, 'retreat')`); a map tap sends it
 *   to that point instead.
 * - ✕ cancels the pick (`setFleetPick(null)`; Esc does the same, App keydown).
 * - The Move pick (tap rule T3) is not a doing mode: the fleet section's Move
 *   button shows it pressed, and a second tap disarms it.
 * - Returned as data (`StripAction`, `stripActions.tsx`); the strip draws it
 *   with `renderStripActions`.
 */
import type { EqxIconName } from '../../ui/index.js';
import type { StripAction } from './stripActions.js';
import { useUIStore } from '../state/store.js';
import { isTouchDevice } from '../input/TouchInput.js';
import { canFinishFleetPick, fleetPickHint, type FleetPickKind } from '../fleet/fleetPickView.js';
import { resolveFleetCommands } from '../fleet/useFleetSelectionView.js';

type RoutePickKind = Exclude<FleetPickKind, 'move'>;

const PICK_ICON: Readonly<Record<RoutePickKind, EqxIconName>> = {
  patrol: 'route', escort: 'escort', retreat: 'retreat',
};

/** The route doing-tools, or null when no route / target pick is under way. */
export function useRouteStripItems(): StripAction[] | null {
  const pick = useUIStore((s) => s.fleetPick);
  const setPick = useUIStore((s) => s.setFleetPick);
  const requestDone = useUIStore((s) => s.requestFleetPickDone);
  const requestUndo = useUIStore((s) => s.requestFleetPickUndo);
  if (pick === null || pick.kind === 'move') return null;
  const kind = pick.kind;

  const onBackToPost = (): void => {
    resolveFleetCommands().setMode(useUIStore.getState().selection.ids, 'retreat');
    setPick(null);
  };

  const items: StripAction[] = [
    { kind: 'identity', key: 'route-id', icon: PICK_ICON[kind], health: 'ok',
      tooltip: fleetPickHint(kind, pick.points, isTouchDevice()),
      ...(kind === 'patrol' ? { count: pick.points } : {}),
      state: kind, testId: 'left-strip-route' },
  ];
  if (kind === 'patrol') {
    items.push(
      { kind: 'button', key: 'route-done', tone: 'primary', icon: 'confirm',
        tooltip: 'Done', disabled: !canFinishFleetPick(pick), onPress: requestDone, testId: 'left-strip-route-done' },
      { kind: 'button', key: 'route-undo', icon: 'undo',
        tooltip: 'Undo last point', disabled: pick.points === 0, onPress: requestUndo, testId: 'left-strip-route-undo' },
    );
  }
  if (kind === 'retreat') {
    items.push(
      { kind: 'button', key: 'route-post', tone: 'primary', icon: 'confirm',
        tooltip: 'Back to post', onPress: onBackToPost, testId: 'left-strip-route-post' },
    );
  }
  items.push(
    { kind: 'separator', key: 'route-sep' },
    { kind: 'button', key: 'route-cancel', tone: 'danger', icon: 'close',
      tooltip: 'Cancel', onPress: () => setPick(null), testId: 'left-strip-route-cancel' },
  );
  return items;
}
