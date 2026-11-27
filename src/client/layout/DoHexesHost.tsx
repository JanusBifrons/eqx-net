/**
 * The do-hexes host (selection-HUD redesign S2b): the bottom-right honeycomb
 * of action hexes (icon + word), where the touch targeting stick was.
 *
 * - Draws in the existing `bottom-right` slot. The anchor is a flex row, so the
 *   honeycomb is its own relative box sized by `doHexLayout`, with each hex
 *   absolutely placed inside it (offsets from the box's bottom-right corner).
 * - This slice: Command with own ships selected, fed from the fleet builder's
 *   action data (`useFleetStripItems` → `fleetDoHexes`). Other contexts come in
 *   later slices (Fly S3b, Build S4, target S8).
 * - Hidden while a right panel is open (`selectRightPanelOpen`, the rule the
 *   right-thumb cluster uses): the panel docks over the right edge.
 * - Hex boxes overlap in their corner triangles (a honeycomb), so each cell
 *   passes pointer events through and only the (hex-clipped) button takes them;
 *   a tap on a neighbour's corner never lands on a dead box.
 */
import { useEffect, useState } from 'react';
import { EqxIconButton } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';
import { useShouldRenderHud, useUIStore } from '../state/store.js';
import { selectRightPanelOpen } from '../state/rightPanel.js';
import { Slot } from './Slot.js';
import { doHexLayout } from './doHexLayout.js';
import { fleetDoHexes, type FleetHexSub } from './fleetDoHexes.js';
import { useFleetStripItems } from './fleetStripItems.js';

const CELL_CLASS = 'eqx-do-hex-cell';
/** Only the clipped hex button takes a touch, never its cell's square box. */
const CELL_CSS = `.${CELL_CLASS} button { pointer-events: auto; }`;

export function DoHexesHost(): JSX.Element | null {
  const shown = useShouldRenderHud();
  const panelOpen = useUIStore(selectRightPanelOpen);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const fleet = useFleetStripItems();
  const [sub, setSub] = useState<FleetHexSub>(null);
  const none = fleet.length === 0;
  // The stance choices close when the selection (or Command) goes away.
  useEffect(() => { if (none) setSub(null); }, [none]);

  const hexes = fleetDoHexes(fleet, { sub, setSub, openMore: () => setRightPanel('orders') });
  if (!shown || panelOpen || hexes.length === 0) return null;
  const layout = doHexLayout(hexes);
  return (
    <Slot anchor="bottom-right" order={0}>
      <style>{CELL_CSS}</style>
      <div
        role="group"
        aria-label={sub === 'stance' ? 'Stance' : 'Orders'}
        data-testid="do-hexes"
        data-set={sub ?? 'orders'}
        style={{ position: 'relative', width: layout.width, height: layout.height }}
      >
        {layout.cells.map(({ hex, cell, right, bottom }) => (
          <div
            key={hex.key}
            className={CELL_CLASS}
            data-cell={cell}
            style={{ position: 'absolute', right, bottom, width: HUD.hex.w, height: HUD.hex.h, pointerEvents: 'none' }}
          >
            <EqxIconButton
              variant="hex"
              icon={hex.icon}
              word={hex.word}
              tooltip={hex.tooltip}
              tone={hex.tone}
              lit={hex.lit === true}
              onClick={hex.onPress}
              data-testid={hex.testId}
              {...(hex.state !== undefined ? { 'data-state': hex.state } : {})}
            />
          </div>
        ))}
      </div>
    </Slot>
  );
}
