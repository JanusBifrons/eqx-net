import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore, useShouldRenderHud } from '../state/store';
import { type StructureKindId } from '@shared-types/structureKinds';
import { onGameWindowOpen } from './GameWindow';
import { BuildSidebar, onBuildSidebarRequest } from './BuildSidebar';
import { cancelPlacement } from '../structures/placementCancel';

/** The Build sidebar's view: closed, the full list, or folded to the placing
 *  strip (only shown while a kind is picked). */
type BuildView = 'closed' | 'full' | 'strip';

/**
 * Owns the Build sidebar's open flag and mounts it (BuildSidebar.tsx: a
 * category rail and kind tiles). Split out of the retired speed dial: the
 * right rail replaced the dial and the ☰ drawer button (UI language plan A7,
 * U5-2), and this keeps the Build menu where it was until it moves into
 * `panels/BuildPanel.tsx` (U2-1).
 *
 * Build mode is the only way in: entering it opens the sidebar, and a Build
 * tap while already in Build (the mode switch or the rail's Build item,
 * `requestBuildSidebar`) reopens it after a ✕. Picking a kind sets
 * `placementKind` and folds the sidebar to the placing strip
 * (BuildPlacingStrip.tsx), so it never covers the ghost; Confirm keeps placing
 * the same building (placementCancel.ts) with it folded; the strip's portrait
 * expands it (placement stays live) and the full sidebar's ✕ folds it back;
 * Cancel (the strip's ✕ too: the ghost goes, Build stays) brings the full list
 * back; leaving Build closes it. A game window opening closes it (one right
 * panel at a time).
 *
 * The open flag is local React state: pure presentation, never Zustand
 * (invariant #2).
 */
export function BuildSidebarHost(): JSX.Element | null {
  const shouldRender = useShouldRenderHud();
  const isDead = useUIStore((s) => s.isDead);
  const setPlacementKind = useUIStore((s) => s.setPlacementKind);
  const [buildView, setBuildView] = useState<BuildView>('closed');

  const collapse = useCallback(() => setBuildView('closed'), []);
  useEffect(() => onGameWindowOpen(collapse), [collapse]);

  // Entering Build and every placement end (Cancel, or a place-once kind
  // placed: the ghost goes, Build stays) open the full list for the next
  // structure. A Confirm keeps placing, so it stays folded. Leaving Build
  // closes it.
  const building = useUIStore((s) => s.buildMode);
  const buildListReady = useUIStore((s) => s.buildMode && s.placementKind === null);
  const wasBuilding = useRef(false);
  useEffect(() => {
    if (buildListReady) setBuildView('full');
    else if (!building && wasBuilding.current) collapse();
    wasBuilding.current = building;
  }, [building, buildListReady, collapse]);

  // A Build tap while already in Build brings the sidebar back.
  useEffect(() => onBuildSidebarRequest(() => {
    if (!useUIStore.getState().buildMode) return;
    setBuildView('full');
  }), []);
  // The full sidebar's ✕ / swipe: while placing it folds to the strip.
  const closeBuild = useCallback(() => {
    setBuildView(useUIStore.getState().placementKind !== null ? 'strip' : 'closed');
  }, []);
  const expandBuild = useCallback(() => setBuildView('full'), []);

  // Pick a kind to place: raise the placement ghost and fold the sidebar to the
  // strip, so it never covers the ghost (build mode, stills review 2026-11-20).
  // Cancel brings it back on the same category (the R2.6 repeat-build need).
  const handlePickBuild = useCallback(
    (kind: StructureKindId) => {
      setPlacementKind(kind);
      setBuildView('strip');
      (document.activeElement as HTMLElement | null)?.blur();
    },
    [setPlacementKind],
  );

  if (!shouldRender || isDead) return null;
  return (
    <BuildSidebar open={buildView === 'full'} strip={buildView === 'strip'} onClose={closeBuild}
      onPick={handlePickBuild} onExpand={expandBuild} onCancel={cancelPlacement} />
  );
}
