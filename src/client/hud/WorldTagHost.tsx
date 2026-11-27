/**
 * Selection HUD S6b: mounts the floating world tag (`EqxWorldTag`) over the
 * focus. React supplies only the text, at the panel poll rate
 * (`useSelectionPanelData`); `hud/worldTag.ts` moves the wrapper per frame
 * from `gameRafLoop` by direct style writes. Fullscreen slot, no pointer
 * events. Nothing focused, or a right panel open ⇒ nothing mounted.
 * S7: 2+ own ships selected (the focus one of them or none) ⇒ ONE group tag
 * over the selection centroid instead (`groupWorldTag.ts`).
 * S9: an off-screen anchor sticks the tag to the screen edge; a tap there
 * glides the camera to it (`worldTag.ts`).
 */
import { useCallback, useEffect } from 'react';
import { getShipKind } from '@shared-types/shipKinds';
import { EqxWorldTag } from '../../ui/index.js';
import { Slot } from '../layout/Slot';
import { useSelectionPanelData } from '../components/selectionPanelData.js';
import { getGameClient } from '../net/clientSingleton';
import { useUIStore } from '../state/store';
import { selectRightPanelOpen } from '../state/rightPanel';
import { useFleetSelectionView } from '../fleet/useFleetSelectionView.js';
import { requestWorldTagGlide, setWorldTagAnchor, setWorldTagElement, worldTagText, type WorldTagText } from './worldTag.js';
import { useTouchClickActivate } from '../components/touchClickActivate.js';
import { groupTagText, worldTagMode } from './groupWorldTag.js';

/** The wrapper the per-frame writer moves: top-left origin, translated. */
const WRAP_STYLE = { position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' } as const;

/** Hull type for a ship focus (its name is the pilot's); none otherwise. */
function focusTypeName(focusId: string | null, focusKind: string | null): string | undefined {
  if (focusId === null || focusKind !== 'ship') return undefined;
  const ship = getGameClient()?.mirror.ships.get(focusId);
  return ship === undefined ? undefined : getShipKind(ship.kind)?.displayName;
}

/** The largest bounding radius (game units) among the selected ships, the
 *  far-zoom icon rule's measure (`FarZoomIcons`); 0 when none is mirrored. */
function largestHullRadius(ids: readonly string[]): number {
  const ships = getGameClient()?.mirror.ships;
  let r = 0;
  for (const id of ids) {
    const ship = ships?.get(id);
    if (ship !== undefined) r = Math.max(r, getShipKind(ship.kind ?? null).radius);
  }
  return r;
}

export function WorldTagHost() {
  const data = useSelectionPanelData();
  const focusId = useUIStore((s) => s.selection.focusId);
  const focusKind = useUIStore((s) => s.selection.focusKind);
  // A right panel docks over the world: no tag drawing over it (like LockCluster).
  const panelOpen = useUIStore(selectRightPanelOpen);
  const fleet = useFleetSelectionView();
  const group = worldTagMode(fleet.active ? fleet.ids : [], focusId) === 'group';
  // S10: the group's compact switch judges its biggest hull (no per-group diameter).
  const groupRadiusU = group ? largestHullRadius(fleet.ids) : 0;
  useEffect(() => setWorldTagAnchor(group ? 'centroid' : 'focus', focusId, groupRadiusU), [group, focusId, groupRadiusU]);
  // S9: edge-stuck, the tag takes taps (the writer turns pointer events on
  // only then) and glides the camera to what it points at.
  const { touchActivate, clickActivate } = useTouchClickActivate();
  const ref = useCallback((el: HTMLDivElement | null) => setWorldTagElement(el), []);
  if (panelOpen || (!group && data === null)) return null;
  const tag: WorldTagText = group
    ? groupTagText(fleet.ships, fleet.mode, fleet.stance)
    : worldTagText(data!, focusTypeName(focusId, focusKind));
  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <div ref={ref} style={WRAP_STYLE} data-testid="world-tag" data-focus-id={focusId ?? undefined} data-tag-mode={group ? 'group' : 'single'}
        onTouchStart={touchActivate(requestWorldTagGlide)} onClick={clickActivate(requestWorldTagGlide)}>
        <EqxWorldTag title={tag.title} owner={tag.owner} ownerColor={tag.ownerColor} hullPct={tag.hullPct}
          compactTitle={tag.compactTitle} />
      </div>
    </Slot>
  );
}
