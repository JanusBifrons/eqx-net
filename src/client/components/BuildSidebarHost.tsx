import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { type StructureKindId } from '@shared-types/structureKinds';
import { onGameWindowOpen } from './GameWindow';
import { BuildPanel } from '../panels/BuildPanel';
import { getPlacementPlanCount, subscribePlacementPlan } from '../structures/placementPlan';

/**
 * Mounts the Build panel (panels/BuildPanel.tsx: a category rail and kind
 * tiles) and drives it from the store's one panel flag (UI language plan U2-1):
 * the full list is open while `rightPanel === 'build'`. The rail's Build item
 * and a Build tap on the mode switch while in Build (`requestBuildPanel`) set
 * it; ✕, Esc, a second rail tap or another rail panel clear it. Entering Build
 * opens nothing (no auto-open); leaving Build clears it (store `setBuildMode`).
 *
 * Picking a kind sets `placementKind` and closes the panel, so the left strip's
 * placing tools show (layout/placingStripItems.tsx, U3-7) and nothing covers
 * the ghost. Place keeps placing the same building (placementCancel.ts); the
 * strip's building icon reopens the panel (placement stays live) and its ✕
 * stops placing. Every placement end in Build (✕, or a place-once place)
 * brings the panel back for the next structure, once no plan waits for Build:
 * a place-once kind leaves its building planned and the placing hexes keep
 * Build and ✕ up, which the panel would cover. A game window opening closes
 * it (one right panel at a time).
 */
export function BuildSidebarHost(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const open = useUIStore((s) => s.rightPanel === 'build' && s.buildMode);

  useEffect(() => onGameWindowOpen(() => {
    if (useUIStore.getState().rightPanel === 'build') setRightPanel(null);
  }), [setRightPanel]);

  // Every placement end in Build (Cancel, or a place-once kind placed: the
  // ghost goes, Build stays) brings the full list back for the next structure,
  // unless another panel is up. A Place keeps placing, so it stays closed; a
  // plan waiting for Build counts as placing (the placing hexes stay up).
  const kindUp = useUIStore((s) => s.placementKind !== null);
  const planned = useSyncExternalStore(subscribePlacementPlan, getPlacementPlanCount);
  const placing = kindUp || planned > 0;
  const wasPlacing = useRef(placing);
  useEffect(() => {
    const s = useUIStore.getState();
    if (wasPlacing.current && !placing && s.buildMode && s.rightPanel === null) s.setRightPanel('build');
    wasPlacing.current = placing;
  }, [placing]);

  const closeBuild = useCallback(() => setRightPanel(null), [setRightPanel]);

  // Pick a kind to place: raise the placement ghost and close the panel, so the
  // left strip's placing tools show and nothing covers the ghost.
  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
      setRightPanel(null);
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [setPlacementKind, setRightPanel],
  );

  if (!shouldRender || isDead) return null;
  return <BuildPanel open={open} onClose={closeBuild} onPick={handlePickBuild} />;
}
