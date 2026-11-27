/**
 * The do-hexes in Build and while a map pick runs (selection-HUD S4). Built
 * from the existing builders' action data, so every tool keeps its handler:
 *
 * - **Placing a structure** (`placingStripItems.tsx`): Place under the thumb
 *   (cell 0; `commitPlacement`, disabled while the ghost is rejected or held),
 *   Rotate, the building (a hex like the rest: its picture at icon size, its
 *   short name as the word; reopens the Build menu), Mirror, Gate (fence runs on
 *   a deck), and Cancel in the far corner. Rows read
 *   "Mirror Rotate Place / Cancel Build" (with Gate: "Cancel Gate Build").
 * - **Route / target pick** (`routeStripItems.tsx`: Patrol, Escort, Retreat):
 *   Done (Patrol) or Back to post (Retreat) under the thumb, Undo, the pick
 *   itself (its hint as the tooltip, the patrol's point count in the word), and
 *   Cancel in the far corner.
 * - **Own structure selected in Build** (owner-approved set: Upgrade, Demolish,
 *   Move / More, Rotate, Repair; only what exists today): Upgrade under the
 *   thumb (`sendUpgradeStructure`, the Manage page's button), Demolish (the
 *   Manage page's hold-to-deconstruct, `useHoldPress`; a running one stops with
 *   a tap), Power (the building builder's on / off, one tap flips it), More
 *   (the Details panel). Moving, rotating or repairing a placed structure has no
 *   path today, so those hexes are not drawn.
 *
 * While these draw, the left strip leaves out what they carry
 * (`buildHexCovers`): every placing / route tool, and the building's Power and
 * Details. Pure: unit-tested; `DoHexesHost` owns the hooks.
 */
import type { ReactElement } from 'react';
import { getStructureKind, isStructureKindId } from '@shared-types/structureKinds';
import { EqxIcon, type EqxIconName } from '../../ui/index.js';
import type { ManageActionData } from '../components/StructureManageActions.js';
import type { PanelData } from '../components/selectionPanelData.js';
import type { DoHex } from './doHexLayout.js';
import type { StripAction, StripButtonAction, StripFlyoutAction, StripIdentityAction } from './stripActions.js';

const noop = (): void => {};

function find<K extends StripAction['kind']>(actions: readonly StripAction[], key: string, kind: K): Extract<StripAction, { kind: K }> | null {
  const a = actions.find((x) => x.key === key);
  return a !== undefined && a.kind === kind ? a as Extract<StripAction, { kind: K }> : null;
}

function iconOf(icon: EqxIconName | ReactElement): ReactElement {
  return typeof icon === 'string' ? <EqxIcon name={icon} /> : icon;
}

/** A builder button as a hex (same handler, same test id). */
function buttonHex(a: StripButtonAction, word: string, extra: Partial<DoHex> = {}): DoHex {
  return {
    key: a.key, testId: a.testId, icon: <EqxIcon name={a.icon} />, word, tooltip: a.tooltip,
    tone: 'neutral', lit: a.active === true, onPress: a.onPress,
    ...(a.disabled === true ? { disabled: true } : {}),
    ...(a.state !== undefined ? { state: a.state } : {}),
    ...extra,
  };
}

/** A builder identity icon as a hex (the building being placed, the pick). */
function identityHex(a: StripIdentityAction, word: string, testId: string, tone: DoHex['tone']): DoHex {
  return {
    key: a.key, testId, icon: iconOf(a.icon), word, tooltip: a.tooltip, tone,
    onPress: a.onPress ?? noop, ...(a.state !== undefined ? { state: a.state } : {}),
  };
}

/** The longest word that fits under a hex icon (`HUD.hex.wordFont` in a `HUD.hex.w` hex). */
const HEX_WORD_MAX = 8;

/** The building hex's word: the kind's short name ("Capital", "Solar"; its
 *  first word), or "Build" when that will not fit or the kind is unknown. */
export function kindWord(kindId: string | undefined): string {
  if (kindId === undefined || !isStructureKindId(kindId)) return 'Build';
  const first = getStructureKind(kindId).displayName.split(' ')[0] ?? '';
  return first !== '' && first.length <= HEX_WORD_MAX ? first : 'Build';
}

/** The placing hexes for the placing builder's `actions`; [] while not placing. */
export function placingDoHexes(actions: readonly StripAction[]): DoHex[] {
  if (actions.length === 0) return [];
  const place = find(actions, 'place', 'button');
  const rotate = find(actions, 'rotate', 'button');
  const kind = find(actions, 'kind', 'identity');
  const mirror = find(actions, 'mirror', 'button');
  const gate = find(actions, 'gate', 'button');
  const cancel = find(actions, 'cancel', 'button');
  const out: DoHex[] = [];
  if (place !== null) out.push(buttonHex(place, 'Place', { tone: 'good', role: 'main' }));
  if (rotate !== null) out.push(buttonHex(rotate, 'Rotate'));
  if (kind !== null) out.push(identityHex(kind, kindWord(kind.state), kind.testId, 'neutral'));
  if (mirror !== null) out.push(buttonHex(mirror, 'Mirror'));
  if (gate !== null) out.push(buttonHex(gate, 'Gate'));
  if (cancel !== null) out.push(buttonHex(cancel, 'Cancel', { tone: 'danger', role: 'cancel' }));
  return out;
}

const PICK_WORD: Readonly<Record<string, string>> = { patrol: 'Route', escort: 'Escort', retreat: 'Retreat' };

/** The route-pick hexes for the route builder's `actions`; [] with no pick. */
export function routeDoHexes(actions: readonly StripAction[] | null): DoHex[] {
  if (actions === null || actions.length === 0) return [];
  const done = find(actions, 'route-done', 'button');
  const post = find(actions, 'route-post', 'button');
  const undo = find(actions, 'route-undo', 'button');
  const id = find(actions, 'route-id', 'identity');
  const cancel = find(actions, 'route-cancel', 'button');
  const out: DoHex[] = [];
  if (done !== null) out.push(buttonHex(done, 'Done', { testId: 'do-hex-route-done', tone: 'good', role: 'main' }));
  if (post !== null) out.push(buttonHex(post, 'To post', { testId: 'do-hex-route-post', tone: 'good', role: 'main' }));
  if (undo !== null) out.push(buttonHex(undo, 'Undo', { testId: 'do-hex-route-undo' }));
  if (id !== null) {
    const word = PICK_WORD[id.state ?? ''] ?? 'Pick';
    out.push(identityHex(id, id.count !== undefined ? `${word} ${id.count}` : word, 'do-hex-route', 'patrol'));
  }
  if (cancel !== null) out.push(buttonHex(cancel, 'Cancel', { testId: 'do-hex-route-cancel', tone: 'danger', role: 'cancel' }));
  return out;
}

/** Do the own-structure hexes draw for this selection (pure)? Build mode
 *  (`manage`, `canManageBuildings`) with your own structure selected. */
export function buildingHexesShow(data: PanelData | null, manage: boolean): boolean {
  return manage && data !== null && data.isOwn === true && data.isStructure === true && data.entityId !== undefined;
}

export interface BuildingDoHexOptions {
  /** The building builder's actions (`useBuildingStripItems`: Power). */
  building: readonly StripAction[];
  /** The Manage page's state of the building (`useManageData`); null while unread. */
  manage: ManageActionData | null;
  upgrade: () => void;
  /** Demolish: the hold (press / release) feeding `useHoldPress`. */
  demolishHold: (down: boolean) => void;
  /** The demolish hold is counting (lit while held). */
  demolishHolding: boolean;
  /** Stops a running deconstruction (a tap). */
  stopDemolish: () => void;
  /** The Details panel (More). */
  openMore: () => void;
}

/** The own-structure hexes (only call while `buildingHexesShow`). Nearness
 *  order: Upgrade under the thumb, then Demolish, Power, More. */
export function buildingDoHexes(o: BuildingDoHexOptions): DoHex[] {
  const out: DoHex[] = [];
  const m = o.manage;
  if (m !== null) {
    const up = m.canUpgrade === true;
    const bill = m.upgradeGoods !== undefined ? ` + ${m.upgradeGoods}` : '';
    out.push({
      key: 'upgrade', testId: 'do-hex-upgrade', icon: <EqxIcon name="boost" />, word: 'Upgrade',
      tooltip: up ? `Upgrade to Lv ${(m.level ?? 1) + 1}: ${m.upgradeMinerals ?? 0} minerals${bill}` : 'Upgrade: not now (still building, deconstructing or top level)',
      tone: 'primary', role: 'main', disabled: !up, onPress: up ? o.upgrade : noop,
      state: up ? `lv${m.level ?? 1}` : 'none',
    });
    out.push(m.isDeconstructing === true
      ? {
          key: 'demolish', testId: 'do-hex-demolish', icon: <EqxIcon name="cancel" />, word: 'Stop',
          tooltip: 'Cancel deconstruction', tone: 'danger', lit: true, onPress: o.stopDemolish, state: 'running',
        }
      : {
          key: 'demolish', testId: 'do-hex-demolish', icon: <EqxIcon name="cancel" />,
          word: o.demolishHolding ? 'Hold…' : 'Demolish',
          tooltip: 'Hold to deconstruct (reverse build, returns resources)', tone: 'danger',
          lit: o.demolishHolding, onPress: noop, onHold: o.demolishHold, state: o.demolishHolding ? 'holding' : 'idle',
        });
  }
  const power = find(o.building, 'power', 'flyout') as StripFlyoutAction | null;
  if (power !== null) {
    const on = power.value !== 'off';
    out.push({
      key: 'power', testId: 'do-hex-power', icon: <EqxIcon name={on ? 'power' : 'stop'} />, word: on ? 'Power on' : 'Power off',
      tooltip: on ? 'Power on: tap to switch off' : 'Power off: tap to switch on', tone: on ? 'good' : 'neutral', lit: on,
      onPress: () => power.onPick(on ? 'off' : 'on'), state: on ? 'on' : 'off',
    });
  }
  out.push({
    key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="details" />, word: 'More', tooltip: 'Details and settings',
    tone: 'primary', onPress: o.openMore,
  });
  return out;
}

/** The strip actions the own-structure hexes carry: Power and Details (More). */
const BUILD_COVERED = [
  { key: 'power', testId: 'left-strip-power' },
  { key: 'details', testId: 'left-strip-details' },
] as const;

/** Is `a` carried by the Build hexes in this hex set (pure)? Placing and route
 *  picks carry every tool but Plan then Build's Build (n), which stays on the
 *  left strip (the placing hexes are full at `DO_HEX_MAX` with a fence run's
 *  Gate); the own-structure set carries Power and Details. */
export function buildHexCovers(set: 'placing' | 'route' | 'build', a: StripAction, buildingShown: boolean): boolean {
  if (a.kind === 'separator') return set !== 'build';
  if (set === 'placing') return !(a.key === 'build' && a.testId === 'placement-build');
  if (set !== 'build') return true;
  return buildingShown && BUILD_COVERED.some((c) => c.key === a.key && c.testId === a.testId);
}
