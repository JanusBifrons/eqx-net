import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { type StructureKindId } from '@shared-types/structureKinds';
import { onGameWindowOpen } from './GameWindow';
import { BuildPanel } from '../panels/BuildPanel';
import { cancelPlacement } from '../structures/placementCancel';

/**
 * Mounts the Build panel (panels/BuildPanel.tsx: a category rail and kind
 * tiles) and drives it from the store's one panel flag (UI language plan U2-1):
 * the full list is open while `rightPanel === 'build'`. The rail's Build item
 * and a Build tap on the mode switch while in Build (`requestBuildPanel`) set
 * it; ✕, Esc, a second rail tap or another rail panel clear it. Entering Build
 * opens nothing (no auto-open); leaving Build clears it (store `setBuildMode`).
 *
 * Picking a kind sets `placementKind` and closes the full list, folding it to
 * the placing strip (BuildPlacingStrip.tsx) so it never covers the ghost; the
 * strip shows while placing with no right panel open. Confirm keeps placing the
 * same building (placementCancel.ts) with it folded; the strip's portrait
 * reopens the full list (placement stays live) and its ✕ folds back; Cancel (the
 * strip's ✕ too: the ghost goes, Build stays) and a place-once place bring the
 * full list back for the next structure. A game window opening closes both
 * (one right panel at a time). The strip mode stays until U3-7.
 *
 * `stripHidden` is presentation only (a game window put the strip away), never
 * Zustand (invariant #2); the open state is the store flag, nothing else.
 */
export function BuildSidebarHost(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const open = useUIStore((s) => s.rightPanel === 'build' && s.buildMode);
  const noPanel = useUIStore((s) => s.rightPanel === null);
  const [stripHidden, setStripHidden] = useState(false);

  useEffect(() => onGameWindowOpen(() => {
    if (useUIStore.getState().rightPanel === 'build') setRightPanel(null);
    setStripHidden(true);
  }), [setRightPanel]);
  useEffect(() => { if (open) setStripHidden(false); }, [open]);

  // Every placement end in Build (Cancel, or a place-once kind placed: the
  // ghost goes, Build stays) brings the full list back for the next structure,
  // unless another panel is up. A Confirm keeps placing, so it stays folded.
  const placing = useUIStore((s) => s.placementKind !== null);
  const wasPlacing = useRef(placing);
  useEffect(() => {
    const s = useUIStore.getState();
    if (wasPlacing.current && !placing && s.buildMode && s.rightPanel === null) s.setRightPanel('build');
    wasPlacing.current = placing;
  }, [placing]);

  const closeBuild = useCallback(() => setRightPanel(null), [setRightPanel]);
  const expandBuild = useCallback(() => setRightPanel('build'), [setRightPanel]);

  // Pick a kind to place: raise the placement ghost and fold the panel to the
  // strip, so it never covers the ghost (build mode, stills review 2026-11-20).
  // Cancel brings it back on the same category (the R2.6 repeat-build need).
  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
      setRightPanel(null);
      setStripHidden(false);
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [setPlacementKind, setRightPanel],
  );

  if (!shouldRender || isDead) return null;
  return (
    <BuildPanel open={open} strip={noPanel && !stripHidden} onClose={closeBuild}
      onPick={handlePickBuild} onExpand={expandBuild} onCancel={cancelPlacement} />
  );
}
