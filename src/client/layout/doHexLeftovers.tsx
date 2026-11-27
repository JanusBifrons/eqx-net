/**
 * The selection's actions a do-hex set's own builder does not draw (the
 * "leftovers"): what the slim left strip used to carry. On touch they are
 * do-hexes too (the strip is retired there, owner 2026-11-27); on desktop the
 * strip still draws them (`LeftStripHost`, a later desktop tranche).
 *
 * - `leftoverActions` (pure) is the ONE filter: the section builders' actions
 *   (`useFleetStripItems`, `useBuildingStripItems`, `useSelectionStripItems`,
 *   plus Details for a focus-only pick) minus what the set's hexes carry
 *   (`FLEET_HEX_KEYS`, `flyHexCovers`, `targetHexCovers`, `buildHexCovers`).
 * - `useLeftoverActions` runs the builders once for a host (the strip, or one
 *   do-hex set) and returns the leftovers, the selection builder's own items
 *   (the Fly set draws from them) and its loot window.
 * - `withLeftovers` puts them in the honeycomb: in the free cells while they
 *   fit (before More), else behind More: More then opens a More sub-set IN the
 *   honeycomb (the Stance sub-set's pattern): the set's old More action (its
 *   panel), each leftover, and Back in the far corner. With no hexes of its
 *   own (a focus-only pick, Build with something that is not your own
 *   structure) the leftovers are the whole set; Details is its More.
 *
 * Every hex calls the builder's own handler and keeps the builder's test id
 * (`ship-action-pilot`, `cargo-open-toggle`, `pod-open`, `fc-target`); Details
 * becomes `do-hex-more`, Power `do-hex-power`.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { IFleetView } from '@core/contracts/render/IFleetView';
import { EqxIcon } from '../../ui/index.js';
import { useUIStore } from '../state/store.js';
import { useSelectionPanelData } from '../components/selectionPanelData.js';
import { fleetLockApplies, lockFocus } from '../components/targetLock.js';
import { canManageBuildings } from '../structures/buildingManagement.js';
import { useFleetStripItems } from './fleetStripItems.js';
import { useBuildingStripItems } from './buildingStripItems.js';
import { useSelectionStripItems } from './selectionStripItems.js';
import { FLEET_HEX_KEYS } from './fleetDoHexes.js';
import { flyHexCovers } from './flyDoHexes.js';
import { targetHexCovers } from './targetDoHexes.js';
import { buildHexCovers, buildingHexesShow, powerHex } from './buildDoHexes.js';
import { DO_HEX_MAX, type DoHex } from './doHexLayout.js';
import type { StripAction } from './stripActions.js';

/** The do-hex set (`DoHexSet`, `DoHexesHost.tsx`; a plain string here so this helper never imports its host). */
type LeftoverSet = string | null;

export interface LeftoverParts {
  /** The fleet builder's actions. */
  fleet: readonly StripAction[];
  /** The building builder's actions (Power). */
  building: readonly StripAction[];
  /** The selection builder's actions plus Details (focus-only pick). */
  quick: readonly StripAction[];
  /** The T2 fleet Lock is in `quick` (`fleetLockApplies`). */
  fleetLock: boolean;
  /** The own-structure Build hexes draw (`buildingHexesShow`). */
  buildingShown: boolean;
}

/** What the `set`'s own hexes leave over (pure; the one filter). */
export function leftoverActions(set: LeftoverSet, p: LeftoverParts): StripAction[] {
  const fleetLeft = set === 'fleet' || set === 'target'
    ? p.fleet.filter((a) => a.kind === 'separator' || !FLEET_HEX_KEYS.has(a.key)) : p.fleet;
  const quickLeft = set === 'fly' ? p.quick.filter((a) => !flyHexCovers(a))
    : set === 'target' ? p.quick.filter((a) => !targetHexCovers(a, p.fleetLock)) : p.quick;
  const shown = set === 'build' && p.buildingShown;
  const keep = (a: StripAction): boolean => !shown || !buildHexCovers('build', a, true);
  return [...fleetLeft, ...p.building.filter(keep), ...quickLeft.filter(keep)];
}

export interface DoHexLeftovers {
  /** What the set's own hexes leave over. */
  extras: StripAction[];
  /** The selection builder's items (the Fly set's Lock, Salvage, Cargo). */
  items: StripAction[];
  /** The selection builder's loot window (render it once, beside the hexes). */
  loot: ReactElement | null;
}

type LockRenderer = { readonly current: Pick<IFleetView, 'attackFocus'> | null };

/** The builders, run once, filtered for `set`. In Fly the Lock is always the
 *  pilot's own (the Fly hexes' Lock), never the T2 fleet Lock. */
export function useLeftoverActions(set: LeftoverSet, rendererRef: LockRenderer): DoHexLeftovers {
  const selection = useUIStore((s) => s.selection);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  const manage = useUIStore(canManageBuildings);
  const fleet = useFleetStripItems();
  const data = useSelectionPanelData();
  const building = useBuildingStripItems(data);
  const fleetLock = set !== 'fly' && fleetLockApplies(selection)
    ? (): void => { lockFocus(useUIStore.getState().selection, rendererRef.current, () => false); }
    : null;
  const { items, loot } = useSelectionStripItems(data, fleetLock);
  // A focus-only pick keeps one way to its readout (the do-hexes' More, or the desktop strip's Details).
  const details: StripAction[] = selection.ids.length === 0 && selection.focusId !== null
    ? [{ kind: 'button', key: 'details', testId: 'left-strip-details', icon: 'details',
        tooltip: data !== null && data.name !== '' ? `${data.name}: details` : 'Details',
        onPress: () => setRightPanel('details') }]
    : [];
  const extras = leftoverActions(set, {
    fleet, building, quick: [...items, ...details], fleetLock: fleetLock !== null,
    buildingShown: buildingHexesShow(data, manage),
  });
  return { extras, items, loot };
}

const noop = (): void => {};

/** Short words for the builders' buttons. */
const WORD: Readonly<Record<string, string>> = { target: 'Lock', pilot: 'Pilot' };
const TONE: Readonly<Record<string, DoHex['tone']>> = { target: 'danger', pilot: 'primary', loot: 'neutral' };

/** One leftover as a hex (same handler, same test id); null for a kind with no hex (identity, separator). */
export function leftoverHex(a: StripAction): DoHex | null {
  if (a.kind === 'button') {
    if (a.key === 'details') {
      return {
        key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="details" />, word: 'More', tooltip: a.tooltip,
        tone: 'primary', onPress: a.onPress,
      };
    }
    const pod = a.testId === 'pod-open';
    const word = a.key === 'loot' ? (pod ? 'Open' : 'Cargo') : WORD[a.key] ?? (a.tooltip.split(/[\s:]/)[0] ?? a.key);
    return {
      key: `extra-${a.key}`, testId: a.testId, icon: <EqxIcon name={a.icon} />, word, tooltip: a.tooltip,
      tone: pod ? 'warn' : TONE[a.key] ?? 'neutral', lit: a.active === true, onPress: a.onPress,
      ...(a.disabled === true ? { disabled: true } : {}),
      ...(a.state !== undefined ? { state: a.state } : {}),
    };
  }
  if (a.kind === 'flyout') {
    if (a.key === 'power') return powerHex(a);
    // Any other pick-one status: one tap steps to the next choice.
    const i = a.options.findIndex((o) => o.id === a.value);
    const next = a.options[(i + 1) % a.options.length];
    return {
      key: `extra-${a.key}`, testId: `do-hex-${a.key}`, icon: a.options[i]?.icon ?? a.emptyIcon ?? null,
      word: a.tooltip.split(':')[0] ?? a.key, tooltip: a.tooltip, tone: 'neutral',
      onPress: next !== undefined ? () => a.onPick(next.id) : noop, state: a.value ?? 'mixed',
    };
  }
  return null;
}

/** The More sub-set's open state; shuts when the focus changes. */
export interface MoreMenu {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function useMoreMenu(): MoreMenu {
  const focusId = useUIStore((s) => s.selection.focusId);
  const ids = useUIStore((s) => s.selection.ids);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [focusId, ids]);
  return { open, setOpen };
}

/** `hexes` with the `extras` added: free cells first (before More), else
 *  behind More as a sub-set (the old More as `panelWord`, the extras, Back).
 *  Pure. */
export function withLeftovers(hexes: readonly DoHex[], extras: readonly StripAction[], more: MoreMenu, panelWord: string): DoHex[] {
  const xs = extras.map(leftoverHex).filter((h): h is DoHex => h !== null);
  if (xs.length === 0) return [...hexes];
  const mi = hexes.findIndex((h) => h.key === 'more');
  if (hexes.length + xs.length <= DO_HEX_MAX || mi < 0) {
    return mi < 0 ? [...hexes, ...xs] : [...hexes.slice(0, mi), ...xs, ...hexes.slice(mi)];
  }
  const moreHex = hexes[mi]!;
  if (!more.open) {
    return hexes.map((h, i) => (i === mi
      ? { ...h, tooltip: 'More actions', onPress: () => more.setOpen(true), state: 'menu' }
      : h));
  }
  const close = (fn: () => void) => (): void => { more.setOpen(false); fn(); };
  return [
    { ...moreHex, key: 'more-panel', testId: 'do-hex-more-panel', word: panelWord, onPress: close(moreHex.onPress) },
    ...xs.slice(0, DO_HEX_MAX - 2).map((h) => ({ ...h, onPress: close(h.onPress) })),
    {
      key: 'back', testId: 'do-hex-back', icon: <EqxIcon name="back" />, word: 'Back', tooltip: 'Back',
      tone: 'neutral', role: 'cancel', onPress: () => more.setOpen(false),
    },
  ];
}
