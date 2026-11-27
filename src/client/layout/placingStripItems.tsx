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
 * - ✕ → `cancelPlacement` (the ghost goes, Build stays).
 *
 * Returned as a flat element list so EqxStrip sees its allowed children directly.
 */
import { useState, useSyncExternalStore, type ReactElement } from 'react';
import type { StructureKindId } from '@shared-types/structureKinds';
import { getStructureKind } from '@shared-types/structureKinds';
import { EqxIcon, EqxIconButton, EqxStrip, EqxStripIdentity } from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { cyclePlacementRotation, getPlacementMirror, togglePlacementMirror } from '../structures/structurePlacementClient.js';
import { getPlacementHeld, getPlacementRejection, subscribePlacementHeld, subscribePlacementRejection } from '../structures/placementChosen.js';
import { cancelPlacement, commitPlacement } from '../structures/placementCancel.js';
import { isFenceRunKind } from '../structures/fenceRun.js';
import { DECK_FENCE_GATE_KIND, DECK_FENCE_POST_KIND } from '../../core/structures/deckLinks.js';
import { structurePortraitUrl } from '../render/art/shipPortraits.js';

/** The building's round identity icon: its baked portrait, or the structure icon. */
function KindIcon({ kind }: { kind: StructureKindId }): ReactElement {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const url = failedFor === kind ? null : structurePortraitUrl(kind);
  if (url === null) return <EqxIcon name="structure" />;
  return <img src={url} alt="" draggable={false} onError={() => setFailedFor(kind)} />;
}

/** The placing tools, or [] while nothing is being placed. */
export function usePlacingStripItems(): ReactElement[] {
  const kind = useUIStore((s) => s.placementKind);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  const deck = useUIStore((s) => s.deck);
  // The mirror choice is module state; this only re-renders the pressed look.
  const [, bumpMirror] = useState(0);
  // Blocked ghost (the server's own placement rule) or held on the spot just sent: no Place.
  const rejected = useSyncExternalStore(subscribePlacementRejection, getPlacementRejection) !== null;
  const held = useSyncExternalStore(subscribePlacementHeld, getPlacementHeld);
  if (kind === null) return [];
  const mirrored = getPlacementMirror();
  const name = getStructureKind(kind).displayName;
  return [
    <EqxStripIdentity key="kind" icon={<KindIcon kind={kind} />} tooltip={`${name}: open the Build menu`} health="ok"
      onClick={() => setRightPanel('build')} data-state={kind} data-testid="placement-kind" />,
    <EqxIconButton key="place" variant="strip" tone="primary" icon={<EqxIcon name="confirm" />} tooltip="Place"
      disabled={rejected || held} onClick={() => { commitPlacement(kind); }} data-testid="placement-confirm" />,
    <EqxIconButton key="rotate" variant="strip" icon={<EqxIcon name="rotate" />} tooltip="Rotate"
      onClick={() => { cyclePlacementRotation(); }} data-testid="placement-rotate" />,
    <EqxIconButton key="mirror" variant="strip" icon={<EqxIcon name="mirror" />} tooltip="Mirror" active={mirrored}
      onClick={() => { togglePlacementMirror(); bumpMirror((n) => n + 1); }} data-testid="placement-mirror" />,
    ...(isFenceRunKind(kind, deck) ? [
      <EqxIconButton key="gate" variant="strip" icon={<EqxIcon name="gate" />} tooltip="Gate" active={kind === DECK_FENCE_GATE_KIND}
        onClick={() => { setPlacementKind(kind === DECK_FENCE_GATE_KIND ? DECK_FENCE_POST_KIND : DECK_FENCE_GATE_KIND); }}
        data-testid="placement-gate" />,
    ] : []),
    <EqxStrip.Separator key="sep" />,
    <EqxIconButton key="cancel" variant="strip" tone="danger" icon={<EqxIcon name="close" />} tooltip="Stop placing"
      onClick={cancelPlacement} data-testid="placement-cancel" />,
  ];
}
