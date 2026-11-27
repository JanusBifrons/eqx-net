/**
 * The left strip's placing tools (UI language plan A5 / U3-7): while a
 * building is being placed (`placementKind` set) the strip shows, as icons
 * only: the building (its portrait), ✓ Place, Rotate, Mirror, then ✕ Cancel.
 * A fence post or gate on a deck adds Gate (edge feel P3): it switches
 * `placementKind` between the two and the fence run stays open (`fenceRun.ts`).
 * It replaces the old bottom-middle placing bar and the Build panel's folded
 * picked-building strip; desktop and touch alike (the desktop R / F keys and
 * click-to-place keep working beside it).
 *
 * Every tool calls the existing path, never a second one:
 * - the building icon reopens the Build panel (`rightPanel='build'`); the strip
 *   hides while it is open (LeftStripHost) and a new pick folds back here;
 * - ✓ Place → `commitPlacement` (the one commit path the desktop click uses
 *   too): placing continues until ✕, except a place-once kind or the last crate;
 *   disabled while the ghost is rejected or held on the spot just sent;
 * - Rotate / Mirror → `cyclePlacementRotation` / `togglePlacementMirror` (the
 *   R / F keys' functions; module state the renderer reads);
 * - Build (plan then Build; only while buildings are planned, "Build (n)") →
 *   `buildPlacementPlan`: Place only PLANS a building, Build sends them all;
 * - ✕ → `cancelPlacement` (the ghost and the plan go, Build mode stays).
 *
 * Returned as data (`StripAction`, `stripActions.tsx`); the strip draws it with
 * `renderStripActions`.
 */
import { useState, useSyncExternalStore, type ReactElement } from 'react';
import type { StructureKindId } from '@shared-types/structureKinds';
import { getStructureKind } from '@shared-types/structureKinds';
import { EqxIcon } from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { cyclePlacementRotation, getPlacementMirror, togglePlacementMirror } from '../structures/structurePlacementClient.js';
import {
  getPlacementHeld, getPlacementOnPlanned, getPlacementRejection, subscribePlacementHeld, subscribePlacementOnPlanned, subscribePlacementRejection,
} from '../structures/placementChosen.js';
import { buildPlacementPlan, cancelPlacement, commitPlacement } from '../structures/placementCancel.js';
import { getPlacementPlanCount, subscribePlacementPlan } from '../structures/placementPlan.js';
import { isFenceRunKind } from '../structures/fenceRun.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../core/structures/deckLinks.js';
import { structurePortraitUrl } from '../render/art/shipPortraits.js';
import type { StripAction } from './stripActions.js';

/** The building's round identity icon: its baked portrait, or the structure icon. */
function KindIcon({ kind }: { kind: StructureKindId }): ReactElement {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const url = failedFor === kind ? null : structurePortraitUrl(kind);
  if (url === null) return <EqxIcon name="structure" />;
  return <img src={url} alt="" draggable={false} onError={() => setFailedFor(kind)} />;
}

/** The placing tools, or [] while nothing is being placed. */
export function usePlacingStripItems(): StripAction[] {
  const kind = useUIStore((s) => s.placementKind);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  const deck = useUIStore((s) => s.deck);
  // The mirror choice is module state; this only re-renders the pressed look.
  const [, bumpMirror] = useState(0);
  // Blocked ghost (the server's own placement rule) or held on the spot just sent: no Place.
  const rejected = useSyncExternalStore(subscribePlacementRejection, getPlacementRejection) !== null;
  const held = useSyncExternalStore(subscribePlacementHeld, getPlacementHeld);
  // On a planned building Place removes it (red there, still enabled).
  const onPlanned = useSyncExternalStore(subscribePlacementOnPlanned, getPlacementOnPlanned);
  const planned = useSyncExternalStore(subscribePlacementPlan, getPlacementPlanCount);
  const cancel: StripAction = { kind: 'button', key: 'cancel', tone: 'danger', icon: 'close', tooltip: 'Stop placing',
    onPress: cancelPlacement, testId: 'placement-cancel' };
  const build: StripAction[] = planned > 0 ? [{ kind: 'button', key: 'build', tone: 'primary', icon: 'build', tooltip: `Build (${planned})`, state: String(planned),
    onPress: () => { buildPlacementPlan(); }, testId: 'placement-build' }] : [];
  // A place-once kind ends placing with its building still planned: Build and ✕ stay.
  if (kind === null) return planned > 0 ? [...build, { kind: 'separator', key: 'sep' }, cancel] : [];
  const mirrored = getPlacementMirror();
  const name = getStructureKind(kind).displayName;
  return [
    { kind: 'identity', key: 'kind', icon: <KindIcon kind={kind} />, tooltip: `${name}: open the Build menu`, health: 'ok',
      onPress: () => setRightPanel('build'), state: kind, testId: 'placement-kind' },
    { kind: 'button', key: 'place', tone: 'primary', icon: 'confirm', tooltip: 'Place',
      disabled: (rejected && !onPlanned) || held, onPress: () => { commitPlacement(kind); }, testId: 'placement-confirm' },
    { kind: 'button', key: 'rotate', icon: 'rotate', tooltip: 'Rotate',
      onPress: () => { cyclePlacementRotation(); }, testId: 'placement-rotate' },
    { kind: 'button', key: 'mirror', icon: 'mirror', tooltip: 'Mirror', active: mirrored,
      onPress: () => { togglePlacementMirror(); bumpMirror((n) => n + 1); }, testId: 'placement-mirror' },
    ...(isFenceRunKind(kind, deck) ? [
      { kind: 'button', key: 'gate', icon: 'gate', tooltip: 'Gate', active: kind === DECK_FENCE_GATE_KIND,
        onPress: () => { setPlacementKind(kind === DECK_FENCE_GATE_KIND ? DECK_FENCE_POST_KIND : DECK_FENCE_GATE_KIND); },
        testId: 'placement-gate' } satisfies StripAction,
    ] : []),
    ...build,
    { kind: 'separator', key: 'sep' },
    cancel,
  ];
}
