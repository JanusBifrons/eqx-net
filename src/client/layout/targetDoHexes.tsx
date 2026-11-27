/**
 * The do-hexes for Command with own ships selected AND a tapped target that is
 * not one of them (selection-HUD S8): what to do to that target. Every order is
 * an existing fleet order; nothing new goes on the wire.
 *
 * - Follow (cell 0): dimmed and blocked. The only follow order is Escort, and
 *   the server takes an escort only of your OWN ship; with ships selected the
 *   tapped target is never yours (`focusSurvives`), so there is no sender.
 * - Move to: the move order (`sendMoveOrder`, the right-click / Move-pick send)
 *   to the target's position at tap time.
 * - Attack: the T2 fleet Lock (`lockFocus` -> the renderer's `attackFocus`, the
 *   right-click attack order). Blocked for a rock or a pod (not attackable).
 * - More: the target's Details panel (what Fly's More and the focus-only
 *   strip's Details open for a tapped thing).
 * - Clear (far corner): drops the target and keeps the ships (the renderer's
 *   `selectFleetShips`), back to the plain fleet set.
 *
 * Pure: unit-tested; `DoHexesHost` wires the actions.
 */
import { EqxIcon } from '../../ui/index.js';
import type { UISelection } from '../state/storeTypes.js';
import type { DoHex } from './doHexLayout.js';
import type { StripAction } from './stripActions.js';

export interface TargetDoHexOptions {
  /** The fleet can be told to attack the target (`fleetLockApplies`). */
  attackable: boolean;
  moveTo: () => void;
  attack: () => void;
  openMore: () => void;
  clear: () => void;
}

/** Own ships selected plus a focus that is not one of them (pure; `doHexSet`). */
export function targetSelected(sel: UISelection): boolean {
  return sel.ids.length > 0 && sel.focusId !== null && !sel.ids.includes(sel.focusId);
}

/** The strip actions the target hexes carry: the fleet Lock (key `target`,
 *  `selectionStripItems`) is Attack while the target is attackable. */
export function targetHexCovers(a: StripAction, attackable: boolean): boolean {
  return attackable && a.kind === 'button' && a.key === 'target';
}

export function targetDoHexes(opts: TargetDoHexOptions): DoHex[] {
  return [
    {
      key: 'follow', testId: 'do-hex-follow', icon: <EqxIcon name="escort" />, word: 'Follow',
      tooltip: 'Follow: only your own ships can be followed', tone: 'neutral', role: 'main',
      dim: true, disabled: true, state: 'unavailable', onPress: () => {},
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
