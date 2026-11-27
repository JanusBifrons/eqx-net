/**
 * Selection HUD S6b: mounts the floating world tag (`EqxWorldTag`) over the
 * focus. React supplies only the text, at the panel poll rate
 * (`useSelectionPanelData`); `hud/worldTag.ts` moves the wrapper per frame
 * from `gameRafLoop` by direct style writes. Fullscreen slot, no pointer
 * events. Nothing focused, or a right panel open ⇒ nothing mounted.
 */
import { useCallback } from 'react';
import { getShipKind } from '@shared-types/shipKinds';
import { EqxWorldTag } from '../../ui/index.js';
import { Slot } from '../layout/Slot';
import { useSelectionPanelData } from '../components/selectionPanelData.js';
import { getGameClient } from '../net/clientSingleton';
import { useUIStore } from '../state/store';
import { selectRightPanelOpen } from '../state/rightPanel';
import { setWorldTagElement, worldTagText } from './worldTag.js';

/** The wrapper the per-frame writer moves: top-left origin, translated. */
const WRAP_STYLE = { position: 'absolute', left: 0, top: 0, visibility: 'hidden', willChange: 'transform' } as const;

/** Hull type for a ship focus (its name is the pilot's); none otherwise. */
function focusTypeName(focusId: string | null, focusKind: string | null): string | undefined {
  if (focusId === null || focusKind !== 'ship') return undefined;
  const ship = getGameClient()?.mirror.ships.get(focusId);
  return ship === undefined ? undefined : getShipKind(ship.kind)?.displayName;
}

export function WorldTagHost() {
  const data = useSelectionPanelData();
  const focusId = useUIStore((s) => s.selection.focusId);
  const focusKind = useUIStore((s) => s.selection.focusKind);
  // A right panel docks over the world: no tag drawing over it (like LockCluster).
  const panelOpen = useUIStore(selectRightPanelOpen);
  const ref = useCallback((el: HTMLDivElement | null) => setWorldTagElement(el), []);
  if (data === null || panelOpen) return null;
  const tag = worldTagText(data, focusTypeName(focusId, focusKind));
  return (
    <Slot anchor="fullscreen" pointerEvents="none">
      <div ref={ref} style={WRAP_STYLE} data-testid="world-tag" data-focus-id={focusId ?? undefined}>
        <EqxWorldTag title={tag.title} owner={tag.owner} ownerColor={tag.ownerColor} hullPct={tag.hullPct} />
      </div>
    </Slot>
  );
}
