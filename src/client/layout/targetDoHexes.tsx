/**
 * The do-hexes for Command with own ships selected AND a tapped target that is
 * not one of them (selection-HUD S8): what to do to that target. Every order is
 * an existing fleet order; nothing new goes on the wire.
 *
 * - Follow (cell 0): the escort order (`setMode` escort, `escortId` = the
 *   target) on any ship: a player's, an AI-flown hull, an NPC (drone) ship.
 *   Dimmed and blocked for a rock, a pod or a structure (scrap is never
 *   selectable). A foreign escort needs the server to accept it.
 * - Move to: the move order (`sendMoveOrder`, the right-click / Move-pick send)
 *   to the target's position at tap time.
 * - Attack: the T2 fleet Lock (`lockFocus` -> the renderer's `attackFocus`, the
 *   right-click attack order). Blocked for a rock or a pod (not attackable).
 * - More: the target's Details panel (what Fly's More and the focus-only
 *   strip's Details open for a tapped thing).
 * - Clear (far corner): drops the target and keeps the ships (the renderer's
 *   `selectFleetShips`), back to the plain fleet set.
 *
 * A salvage target (a tapped scrap / wreck piece, S11) gets its own set
 * instead (`salvageDoHexes`): Salvage (the fleet salvage order), Move to,
 * More, Clear.
 *
 * Pure: unit-tested; `DoHexesHost` wires the actions.
 */
import { EqxIcon } from '../../ui/index.js';
import { getShipKind } from '@shared-types/shipKinds';
import { hasMiningTool } from '@core/combat/salvageTargeting';
import type { SelectionFocusKind, UISelection } from '../state/storeTypes.js';
import type { FleetCommands } from '../fleet/fleetCommands.js';
import type { DoHex } from './doHexLayout.js';
import type { StripAction } from './stripActions.js';

export interface TargetDoHexOptions {
  /** The fleet can be told to attack the target (`fleetLockApplies`). */
  attackable: boolean;
  /** The target is a ship the selection can follow (`targetFollowable`). */
  followable: boolean;
  follow: () => void;
  moveTo: () => void;
  attack: () => void;
  openMore: () => void;
  clear: () => void;
}

/** Own ships selected plus a focus that is not one of them (pure; `doHexSet`). */
export function targetSelected(sel: UISelection): boolean {
  return sel.ids.length > 0 && sel.focusId !== null && !sel.ids.includes(sel.focusId);
}

/** Focus kinds that are ships (Follow): never rocks, pods or structures. */
const FOLLOWABLE: ReadonlySet<SelectionFocusKind> = new Set<SelectionFocusKind>(['ship', 'lingering', 'drone']);

/** A target ship the selected ships can follow (pure). */
export function targetFollowable(sel: UISelection): boolean {
  return targetSelected(sel) && sel.focusKind !== null && FOLLOWABLE.has(sel.focusKind);
}

/** Follow: the existing escort order, the selected ships escorting the target.
 *  False (nothing sent) when the target is not a ship. */
export function followTarget(sel: UISelection, cmds: Pick<FleetCommands, 'setMode'>): boolean {
  if (!targetFollowable(sel) || sel.focusId === null) return false;
  cmds.setMode(sel.ids, 'escort', { escortId: sel.focusId });
  return true;
}

/** The strip actions the target hexes carry: the fleet Lock (key `target`,
 *  `selectionStripItems`) is Attack while the target is attackable. */
export function targetHexCovers(a: StripAction, attackable: boolean): boolean {
  return attackable && a.kind === 'button' && a.key === 'target';
}

// ── Salvage target (S11): a tapped scrap / wreck piece (focus kind 'salvage',
// picked in Command only). Salvage under the thumb, Move to, More, Clear; no
// Follow (not a ship) and no Attack (salvaged, not shot). ──

export interface SalvageDoHexOptions {
  /** Some selected AI-flown hull carries a salvage tool (`fleetCanSalvage`). */
  canSalvage: boolean;
  salvage: () => void;
  moveTo: () => void;
  openMore: () => void;
  clear: () => void;
}

/** Own ships selected plus a tapped salvage piece (pure). */
export function salvageTargetSelected(sel: UISelection): boolean {
  return targetSelected(sel) && sel.focusKind === 'salvage';
}

/** The ship-list read `fleetCanSalvage` needs (a `RenderMirror` fits). */
interface SalvageShipsView {
  readonly localPlayerId: string | null;
  readonly ships: ReadonlyMap<string, { readonly kind?: string }>;
}

/** Can the selection salvage at all? True when ANY selected AI-flown hull has
 *  a mining tool (`hasMiningTool` over its kind's mounts, as the server
 *  checks); the ship I fly never counts. The server orders only the hulls
 *  that can; the rest guard. Pure. */
export function fleetCanSalvage(ids: readonly string[], mirror: SalvageShipsView): boolean {
  for (const id of ids) {
    if (id === mirror.localPlayerId) continue; // the ship I fly
    const ship = mirror.ships.get(id);
    if (ship === undefined) continue;
    const mounts = getShipKind(ship.kind).mounts;
    if (mounts !== undefined && hasMiningTool(mounts)) return true;
  }
  return false;
}

/** Salvage: the fleet salvage order on the tapped piece. False (nothing sent)
 *  when the focus is not a salvage piece. */
export function salvageTarget(sel: UISelection, cmds: Pick<FleetCommands, 'salvage'>): boolean {
  if (!salvageTargetSelected(sel) || sel.focusId === null) return false;
  cmds.salvage(sel.ids, sel.focusId);
  return true;
}

export function salvageDoHexes(opts: SalvageDoHexOptions): DoHex[] {
  return [
    {
      key: 'salvage', testId: 'do-hex-salvage', icon: <EqxIcon name="pod" />, word: 'Salvage',
      tooltip: opts.canSalvage ? 'Salvage the piece' : 'No salvage tools on these ships', tone: 'warn', role: 'main',
      ...(opts.canSalvage ? {} : { dim: true, disabled: true, state: 'unavailable' }), onPress: opts.salvage,
    },
    {
      key: 'move-to', testId: 'do-hex-move-to', icon: <EqxIcon name="move" />, word: 'Move to',
      tooltip: 'Move to the target', tone: 'good', onPress: opts.moveTo,
    },
    {
      key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="details" />, word: 'More',
      tooltip: 'Target details', tone: 'primary', onPress: opts.openMore,
    },
    {
      key: 'clear', testId: 'do-hex-clear', icon: <EqxIcon name="cancel" />, word: 'Clear',
      tooltip: 'Clear the target', tone: 'neutral', role: 'cancel', onPress: opts.clear,
    },
  ];
}

export function targetDoHexes(opts: TargetDoHexOptions): DoHex[] {
  return [
    {
      key: 'follow', testId: 'do-hex-follow', icon: <EqxIcon name="escort" />, word: 'Follow',
      tooltip: opts.followable ? 'Follow the target' : 'Only ships can be followed', tone: 'neutral', role: 'main',
      ...(opts.followable ? {} : { dim: true, disabled: true, state: 'unavailable' }), onPress: opts.follow,
    },
    {
      key: 'move-to', testId: 'do-hex-move-to', icon: <EqxIcon name="move" />, word: 'Move to',
      tooltip: 'Move to the target', tone: 'good', onPress: opts.moveTo,
    },
    {
      key: 'attack', testId: 'do-hex-attack', icon: <EqxIcon name="hunt" />, word: 'Attack',
      tooltip: opts.attackable ? 'Attack the target' : 'Nothing to attack', tone: 'danger',
      ...(opts.attackable ? {} : { dim: true, disabled: true }), onPress: opts.attack,
    },
    {
      key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="details" />, word: 'More',
      tooltip: 'Target details', tone: 'primary', onPress: opts.openMore,
    },
    {
      key: 'clear', testId: 'do-hex-clear', icon: <EqxIcon name="cancel" />, word: 'Clear',
      tooltip: 'Clear the target', tone: 'neutral', role: 'cancel', onPress: opts.clear,
    },
  ];
}
