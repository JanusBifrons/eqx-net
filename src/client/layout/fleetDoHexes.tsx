/**
 * The do-hexes for Command with own ships selected (selection-HUD S2b): built
 * from the fleet builder's action data (`useFleetStripItems`, the same list the
 * left strip draws), so every order still goes through
 * `resolveFleetCommands` / the map pick exactly as the strip sends it.
 *
 * Owner-approved set: Stance, Attack, Move / More, Patrol, Stop.
 * - Move: the builder's `move` button (arms the one-point move pick); the main
 *   action, thumb-nearest, lit while armed.
 * - Attack: the builder's Order fly-out picking Hunt (the order that attacks
 *   enemies today); lit while the fleet is hunting.
 * - Patrol: the Order fly-out picking Patrol (starts the route pick); lit while
 *   patrolling.
 * - Stop: the builder's `stop` button.
 * - Stance: opens the stance choices IN the honeycomb (`stance` sub-set:
 *   each stance plus Back in the far corner); a pick sends the builder's stance
 *   order and returns.
 * - More: opens the Orders panel (every order, speed), the strip's ⚙ panel.
 *
 * Pure: unit-tested; `DoHexesHost` owns the sub-set state.
 */
import { EqxIcon } from '../../ui/index.js';
import type { DoHex } from './doHexLayout.js';
import type { StripAction, StripButtonAction, StripFlyoutAction } from './stripActions.js';

/** Which hex set is showing: the orders, or the stance choices. */
export type FleetHexSub = 'stance' | null;

export interface FleetDoHexOptions {
  sub: FleetHexSub;
  setSub: (sub: FleetHexSub) => void;
  /** Opens the Orders panel (More). */
  openMore: () => void;
}

function button(actions: readonly StripAction[], key: string): StripButtonAction | null {
  const a = actions.find((x) => x.key === key);
  return a !== undefined && a.kind === 'button' ? a : null;
}

function flyout(actions: readonly StripAction[], key: string): StripFlyoutAction | null {
  const a = actions.find((x) => x.key === key);
  return a !== undefined && a.kind === 'flyout' ? a : null;
}

/** The stance choices: one hex per stance (current lit) plus Back. */
function stanceHexes(stance: StripFlyoutAction, setSub: (s: FleetHexSub) => void): DoHex[] {
  const out: DoHex[] = stance.options.map((o) => ({
    key: `stance-${o.id}`,
    testId: `do-hex-stance-${o.id}`,
    icon: o.icon,
    word: o.tooltip,
    tooltip: `Stance: ${o.tooltip}`,
    tone: o.tone === 'danger' ? 'danger' : 'neutral',
    lit: o.id === stance.value,
    onPress: () => { setSub(null); stance.onPick(o.id); },
  }));
  out.push({
    key: 'back', testId: 'do-hex-back', icon: <EqxIcon name="back" />, word: 'Back', tooltip: 'Back to orders',
    tone: 'neutral', role: 'cancel', onPress: () => setSub(null),
  });
  return out;
}

/** The do-hexes for the fleet builder's `actions`; [] when it has none (not Command, no own ships). */
export function fleetDoHexes(actions: readonly StripAction[], opts: FleetDoHexOptions): DoHex[] {
  if (actions.length === 0) return [];
  const order = flyout(actions, 'order');
  const stance = flyout(actions, 'stance');
  const move = button(actions, 'move');
  const stop = button(actions, 'stop');
  if (opts.sub === 'stance' && stance !== null) return stanceHexes(stance, opts.setSub);

  // Nearness order (doHexLayout): Move under the thumb, then Attack, Stop,
  // Stance, Patrol, More, so the rows read "Stance Attack Move / More Patrol Stop".
  const out: DoHex[] = [];
  if (move !== null) {
    out.push({
      key: 'move', testId: 'do-hex-move', icon: <EqxIcon name={move.icon} />, word: 'Move', tooltip: move.tooltip,
      tone: 'good', lit: move.active === true, role: 'main', onPress: move.onPress,
      state: move.active === true ? 'armed' : 'idle',
    });
  }
  if (order !== null && order.options.some((o) => o.id === 'hunt')) {
    out.push({
      key: 'attack', testId: 'do-hex-attack', icon: <EqxIcon name="hunt" />, word: 'Attack',
      tooltip: 'Attack: hunt enemies nearby', tone: 'danger', lit: order.value === 'hunt',
      onPress: () => order.onPick('hunt'),
    });
  }
  if (stop !== null) {
    out.push({
      key: 'stop', testId: 'do-hex-stop', icon: <EqxIcon name={stop.icon} />, word: 'Stop', tooltip: stop.tooltip,
      tone: 'neutral', onPress: stop.onPress,
    });
  }
  if (stance !== null) {
    const current = stance.options.find((o) => o.id === stance.value);
    out.push({
      key: 'stance', testId: 'do-hex-stance', icon: current?.icon ?? stance.emptyIcon, word: 'Stance',
      tooltip: stance.tooltip, tone: 'neutral', onPress: () => opts.setSub('stance'),
    });
  }
  if (order !== null && order.options.some((o) => o.id === 'patrol')) {
    out.push({
      key: 'patrol', testId: 'do-hex-patrol', icon: <EqxIcon name="patrol" />, word: 'Patrol',
      tooltip: 'Patrol: tap points for a route', tone: 'patrol', lit: order.value === 'patrol',
      onPress: () => order.onPick('patrol'),
    });
  }
  out.push({
    key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="orders" />, word: 'More', tooltip: 'More orders',
    tone: 'primary', onPress: opts.openMore,
  });
  return out;
}
