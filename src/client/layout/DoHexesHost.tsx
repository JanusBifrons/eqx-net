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
 * - Placing a structure, a route / target pick, and Build with your own
 *   structure selected (S4, `buildDoHexes.tsx`): the placing / route tools
 *   (Place or Done under the thumb, Cancel in the far corner) and the
 *   building's Upgrade, Demolish, Power, More. Every device, like Command.
 * - Command, own ships selected plus a tapped target that is not mine (S8,
 *   `targetDoHexes.tsx`): Follow (escort; dimmed off ships), Move to, Attack,
 *   More (its Details), Clear (keeps the ships, drops the target). A tapped
 *   scrap / wreck piece (S11) swaps Follow and Attack out: Salvage (the fleet
 *   salvage order; dimmed when no selected hull has a salvage tool), Move to,
 *   More, Clear.
 * - Hidden while a right panel is open (`selectRightPanelOpen`): the panel docks
 *   over the right edge. A held Boost lets go then (HoldButton on unmount).
 * - Hex boxes overlap in their corner triangles (a honeycomb), so each cell
 *   passes pointer events through and only the (hex-clipped) button takes them;
 *   a tap on a neighbour's corner never lands on a dead box.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getPlacementPlanCount, subscribePlacementPlan } from '../structures/placementPlan.js';
import { EqxIconButton, HEX_CLIP } from '../../ui/index.js';
import { HUD } from '../hud/tokens.js';
import { HoldButton } from '../hud/widgets.js';
import type { TouchInput } from '../input/TouchInput.js';
import { getGameClient } from '../net/clientSingleton.js';
import { useSelectionPanelData } from '../components/selectionPanelData.js';
import { useShouldRenderHud, useUIStore } from '../state/store.js';
import { selectRightPanelOpen } from '../state/rightPanel.js';
import type { FcGroupSummary, UIStore } from '../state/storeTypes.js';
import { Slot } from './Slot.js';
import { doHexLayout, type DoHex } from './doHexLayout.js';
import { fleetDoHexes, type FleetHexSub } from './fleetDoHexes.js';
import { flyDoHexes, type FlyFireMode, type FlyHexSub } from './flyDoHexes.js';
import { useFleetStripItems } from './fleetStripItems.js';
import { useSelectionStripItems } from './selectionStripItems.js';
import { usePlacingStripItems } from './placingStripItems.js';
import { useRouteStripItems } from './routeStripItems.js';
import { useBuildingStripItems } from './buildingStripItems.js';
import {
  fleetCanSalvage, followTarget, salvageDoHexes, salvageTarget, salvageTargetSelected,
  targetDoHexes, targetFollowable, targetSelected,
} from './targetDoHexes.js';
import { resolveFleetCommands } from '../fleet/useFleetSelectionView.js';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { fleetLockApplies, lockFocus } from '../components/targetLock.js';
import { resolveSelectable, type SelectableTarget } from '../render/SelectionBracket.js';
import { sendMoveOrder } from '../app/fleetOrderSends.js';
import { buildingDoHexes, buildingHexesShow, placingDoHexes, routeDoHexes } from './buildDoHexes.js';
import { canManageBuildings } from '../structures/buildingManagement.js';
import { sendStructureAction, sendUpgradeStructure } from '../structures/structureActionsClient.js';
import { DECONSTRUCT_HOLD_MS, useManageData } from '../components/StructureManageActions.js';
import { useHoldPress } from '../components/useHoldPress.js';

const CELL_CLASS = 'eqx-do-hex-cell';
/** Only the clipped hex button takes a touch, never its cell's square box. */
const CELL_CSS = `.${CELL_CLASS} button { pointer-events: auto; }`;

interface Props {
  /** Present on touch devices only (the Fly hexes need it for Boost). */
  touchInput?: Pick<TouchInput, 'setBoostHeld'> | null;
  /** The renderer (it owns the selection): the target hexes' Attack and Clear. */
  rendererRef?: { readonly current: Pick<IFleetView, 'selectFleetShips' | 'attackFocus'> | null };
}

/** Which do-hex set this state draws (pure; unit-tested): the placing tools
 *  while a structure is being placed and the route tools while a route /
 *  target pick runs (every device, like the fleet set); the Fly set when flying
 *  on touch, none when flying on desktop; the Build set in Build (empty
 *  without your own structure selected); the target set with own ships and a
 *  tapped target that is not mine; else the fleet set (empty without own
 *  ships in Command). Placing also covers a place-once kind that ended with
 *  buildings still planned (`planned` > 0: Build and Cancel). The left strip
 *  reads it too, so an action shows in exactly one place (`LeftStripHost`). */
export type DoHexSet = 'fly' | 'fleet' | 'target' | 'placing' | 'route' | 'build' | null;
export function doHexSet(
  s: Pick<UIStore, 'pilotMode' | 'isDead' | 'buildMode'> & Partial<Pick<UIStore, 'placementKind' | 'fleetPick' | 'selection'>>,
  touch: boolean,
  planned = 0,
): DoHexSet {
  if (s.placementKind != null || (planned > 0 && s.buildMode)) return 'placing';
  if (s.fleetPick != null && s.fleetPick.kind !== 'move') return 'route';
  const flying = s.pilotMode !== 'spectator' && !s.isDead && !s.buildMode;
  if (flying) return touch ? 'fly' : null;
  if (s.buildMode) return 'build';
  if (s.selection !== undefined && targetSelected(s.selection)) return 'target';
  return 'fleet';
}

/** {@link doHexSet} for the live store. */
export function useDoHexSet(touch: boolean): DoHexSet {
  const planned = useSyncExternalStore(subscribePlacementPlan, getPlacementPlanCount);
  return useUIStore((s) => doHexSet(s, touch, planned));
}

export function DoHexesHost({ touchInput = null, rendererRef = NO_RENDERER }: Props): JSX.Element | null {
  const shown = useShouldRenderHud();
  const panelOpen = useUIStore(selectRightPanelOpen);
  const set = useDoHexSet(touchInput !== null);
  if (!shown || panelOpen || set === null) return null;
  if (set === 'fly') return touchInput !== null ? <FlyHexes touchInput={touchInput} /> : null;
  if (set === 'placing') return <PlacingHexes />;
  if (set === 'route') return <RouteHexes />;
  if (set === 'build') return <BuildingHexes />;
  if (set === 'target') return <TargetHexes rendererRef={rendererRef} />;
  return <FleetHexes />;
}

/** Placing a structure: the placing builder's tools. */
function PlacingHexes(): JSX.Element | null {
  return <DoHexGrid hexes={placingDoHexes(usePlacingStripItems())} label="Placing" set="placing" />;
}

/** A route / target pick: the route builder's tools. */
function RouteHexes(): JSX.Element | null {
  return <DoHexGrid hexes={routeDoHexes(useRouteStripItems())} label="Picking on the map" set="route" />;
}

/** The Manage page's cadence (4 Hz). */
const MANAGE_POLL_MS = 250;

/** Build, your own structure selected. */
function BuildingHexes(): JSX.Element | null {
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const manage = useUIStore(canManageBuildings);
  const data = useSelectionPanelData();
  const building = useBuildingStripItems(data);
  const show = buildingHexesShow(data, manage);
  const entityId = show && data?.entityId !== undefined ? data.entityId : null;
  const manageData = useManageData(entityId, MANAGE_POLL_MS);
  const demolish = useHoldPress(DECONSTRUCT_HOLD_MS, () => {
    if (entityId !== null) sendStructureAction(entityId, 'toggle_deconstruct');
  });
  if (entityId === null) return null;
  const hexes = buildingDoHexes({
    building, manage: manageData,
    upgrade: () => { sendUpgradeStructure(entityId); },
    demolishHold: (down) => { if (down) demolish.handlers.onPointerDown(); else demolish.handlers.onPointerUp(); },
    demolishHolding: demolish.holding,
    stopDemolish: () => { sendStructureAction(entityId, 'toggle_deconstruct'); },
    openMore: () => setRightPanel('details'),
  });
  return <DoHexGrid hexes={hexes} label="Building" set="build" />;
}

const NO_RENDERER = { current: null };
/** Move to's pose read (one tap at a time). */
const targetPose: SelectableTarget = { x: 0, y: 0, r: 0, hw: 0, hh: 0 };

/** Command, own ships selected plus a tapped target that is not mine (S8). */
function TargetHexes({ rendererRef }: { rendererRef: NonNullable<Props['rendererRef']> }): JSX.Element | null {
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const attackable = useUIStore((s) => fleetLockApplies(s.selection));
  const followable = useUIStore((s) => targetFollowable(s.selection));
  const salvageFocus = useUIStore((s) => salvageTargetSelected(s.selection));
  // Ship kinds never change under an id: read on render (selection changes).
  const ids = useUIStore((s) => s.selection.ids);
  const mirror = getGameClient()?.mirror;
  const canSalvage = salvageFocus && mirror != null && fleetCanSalvage(ids, mirror);
  // The fleet builder decides when fleet orders apply at all (Command, own ships).
  const fleet = useFleetStripItems();
  if (fleet.length === 0) return null;
  const moveTo = (): void => {
    const sel = useUIStore.getState().selection;
    const m = getGameClient()?.mirror;
    if (sel.focusId === null || m == null || !resolveSelectable(m, sel.focusId, targetPose)) return;
    sendMoveOrder(sel.ids, targetPose.x, targetPose.y);
  };
  const openMore = (): void => setRightPanel('details');
  const clear = (): void => { rendererRef.current?.selectFleetShips(useUIStore.getState().selection.ids); };
  const hexes = salvageFocus
    ? salvageDoHexes({
      canSalvage,
      salvage: () => { salvageTarget(useUIStore.getState().selection, resolveFleetCommands()); },
      moveTo, openMore, clear,
    })
    : targetDoHexes({
      attackable,
      followable,
      follow: () => { followTarget(useUIStore.getState().selection, resolveFleetCommands()); },
      moveTo,
      attack: () => { lockFocus(useUIStore.getState().selection, rendererRef.current, () => false); },
      openMore, clear,
    });
  return <DoHexGrid hexes={hexes} label="Target" set="target" />;
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
  // A badged hex paints last, so its corner badge draws over the neighbouring hex.
  const cells = layout.cells.some((c) => c.hex.badge)
    ? [...layout.cells.filter((c) => !c.hex.badge), ...layout.cells.filter((c) => c.hex.badge)]
    : layout.cells;
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
        {cells.map(({ hex, cell, right, bottom }) => (
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
      disabled={hex.disabled === true}
      onClick={hex.onPress}
      data-testid={testId}
      {...(hex.badge !== undefined ? { badge: hex.badge } : {})}
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
