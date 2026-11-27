/**
 * The do-hexes host (selection-HUD redesign S2b, S3b): the bottom-right
 * honeycomb of action hexes (icon + word), where the touch targeting stick and
 * BOOST were.
 *
 * - Draws in the existing `bottom-right` slot. The anchor is a flex row, so the
 *   honeycomb is its own relative box sized by `doHexLayout`, with each hex
 *   absolutely placed inside it (offsets from the box's bottom-right corner).
 * - Command, own ships selected: the fleet builder's action data
 *   (`useFleetStripItems` → `fleetDoHexes`).
 * - Fly, touch: the piloted ship's actions (`flyDoHexes`: Boost under the
 *   thumb, Lock, Cargo, Stance, Salvage, More), from the selection builder
 *   (`useSelectionStripItems`) and the boost input (`TouchInput.setBoostHeld`).
 *   Desktop Fly has none (RMB boost, T lock, the rail's Hold).
 * - Build and Command targets come in later slices (S4, S8).
 * - Hidden while a right panel is open (`selectRightPanelOpen`): the panel docks
 *   over the right edge. A held Boost lets go then (HoldButton on unmount).
 * - Hex boxes overlap in their corner triangles (a honeycomb), so each cell
 *   passes pointer events through and only the (hex-clipped) button takes them;
 *   a tap on a neighbour's corner never lands on a dead box.
 */
import { useEffect, useState } from 'react';
import { EqxIconButton, HEX_CLIP } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';
import { HoldButton } from '../hud/widgets.js';
import type { TouchInput } from '../input/TouchInput.js';
import { getGameClient } from '../net/clientSingleton.js';
import { useSelectionPanelData } from '../components/selectionPanelData.js';
import { useShouldRenderHud, useUIStore } from '../state/store.js';
import { selectRightPanelOpen } from '../state/rightPanel.js';
import type { FcGroupSummary } from '../state/storeTypes.js';
import { Slot } from './Slot.js';
import { doHexLayout, type DoHex } from './doHexLayout.js';
import { fleetDoHexes, type FleetHexSub } from './fleetDoHexes.js';
import { flyDoHexes, type FlyFireMode, type FlyHexSub } from './flyDoHexes.js';
import { useFleetStripItems } from './fleetStripItems.js';
import { useSelectionStripItems } from './selectionStripItems.js';

const CELL_CLASS = 'eqx-do-hex-cell';
/** Only the clipped hex button takes a touch, never its cell's square box. */
const CELL_CSS = `.${CELL_CLASS} button { pointer-events: auto; }`;

interface Props {
  /** Present on touch devices only (the Fly hexes need it for Boost). */
  touchInput?: Pick<TouchInput, 'setBoostHeld'> | null;
}

export function DoHexesHost({ touchInput = null }: Props): JSX.Element | null {
  const shown = useShouldRenderHud();
  const panelOpen = useUIStore(selectRightPanelOpen);
  const flying = useUIStore((s) => s.pilotMode !== 'spectator' && !s.isDead && !s.buildMode);
  if (!shown || panelOpen) return null;
  if (flying) return touchInput !== null ? <FlyHexes touchInput={touchInput} /> : null;
  return <FleetHexes />;
}

/** Command, own ships selected. */
function FleetHexes(): JSX.Element | null {
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const fleet = useFleetStripItems();
  const [sub, setSub] = useState<FleetHexSub>(null);
  const none = fleet.length === 0;
  // The stance choices close when the selection (or Command) goes away.
  useEffect(() => { if (none) setSub(null); }, [none]);
  const hexes = fleetDoHexes(fleet, { sub, setSub, openMore: () => setRightPanel('orders') });
  return <DoHexGrid hexes={hexes} label={sub === 'stance' ? 'Stance' : 'Orders'} set={sub ?? 'orders'} />;
}

/** Every group's mode as one shared value (null when mixed or none). Pure. */
export function sharedFireMode(groups: readonly Pick<FcGroupSummary, 'mode'>[]): FlyFireMode {
  const first = groups[0];
  if (first === undefined) return null;
  return groups.every((g) => g.mode === first.mode) ? first.mode : null;
}

/** Fly (touch): the piloted ship's hexes. */
function FlyHexes({ touchInput }: { touchInput: Pick<TouchInput, 'setBoostHeld'> }): JSX.Element | null {
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const groups = useUIStore((s) => s.fcGroups);
  const data = useSelectionPanelData();
  const { items, loot } = useSelectionStripItems(data, null);
  const [sub, setSub] = useState<FlyHexSub>(null);
  const [boostHeld, setHeld] = useState(false);
  const hexes = flyDoHexes({
    sub, setSub, selection: items,
    fireMode: sharedFireMode(groups), hasGroups: groups.length > 0,
    setFireMode: (mode) => {
      const c = getGameClient();
      for (const g of useUIStore.getState().fcGroups) if (g.mode !== mode) c?.setGroupMode(g.id, mode);
    },
    boostHeld,
    setBoostHeld: (down) => { touchInput.setBoostHeld(down); setHeld(down); },
    openCargo: () => setRightPanel('hold'),
    openMore: () => setRightPanel(useUIStore.getState().selection.focusId !== null ? 'details' : 'contacts'),
  });
  return (
    <>
      <DoHexGrid hexes={hexes} label={sub === 'stance' ? 'Stance' : 'Ship'} set={sub ?? 'fly'} />
      {loot}
    </>
  );
}

/** The honeycomb itself, in the bottom-right slot. */
function DoHexGrid({ hexes, label, set }: { hexes: readonly DoHex[]; label: string; set: string }): JSX.Element | null {
  if (hexes.length === 0) return null;
  const layout = doHexLayout(hexes);
  return (
    <Slot anchor="bottom-right" order={0}>
      <style>{CELL_CSS}</style>
      <div
        role="group"
        aria-label={label}
        data-testid="do-hexes"
        data-set={set}
        style={{ position: 'relative', width: layout.width, height: layout.height }}
      >
        {layout.cells.map(({ hex, cell, right, bottom }) => (
          <div
            key={hex.key}
            className={CELL_CLASS}
            data-cell={cell}
            style={{ position: 'absolute', right, bottom, width: HUD.hex.w, height: HUD.hex.h, pointerEvents: 'none' }}
          >
            {hex.onHold !== undefined ? <HoldHex hex={hex} onHold={hex.onHold} /> : <HexButton hex={hex} />}
          </div>
        ))}
      </div>
    </Slot>
  );
}

function HexButton({ hex, testId = hex.testId }: { hex: DoHex; testId?: string }): JSX.Element {
  return (
    <EqxIconButton
      variant="hex"
      icon={hex.icon}
      word={hex.word}
      tooltip={hex.tooltip}
      tone={hex.tone}
      lit={hex.lit === true}
      dim={hex.dim === true}
      onClick={hex.onPress}
      data-testid={testId}
      {...(hex.state !== undefined ? { 'data-state': hex.state } : {})}
    />
  );
}

/** A HOLD hex (Boost): the existing `HoldButton` (pointer down / up, works as a
 *  second finger, lets go on unmount), clipped to the hexagon so its corners
 *  never take a neighbour's touch, with the hex look inside. */
function HoldHex({ hex, onHold }: { hex: DoHex; onHold: (down: boolean) => void }): JSX.Element {
  return (
    <HoldButton
      testId={hex.testId}
      size={HUD.hex.w}
      color="transparent"
      title={hex.tooltip}
      {...(hex.state !== undefined ? { dataState: hex.state } : {})}
      onHold={onHold}
      style={{
        width: HUD.hex.w, height: HUD.hex.h, borderRadius: 0, border: 'none',
        background: 'transparent', boxShadow: 'none', clipPath: HEX_CLIP,
      }}
    >
      <HexButton hex={hex} testId={`${hex.testId}-face`} />
    </HoldButton>
  );
}
