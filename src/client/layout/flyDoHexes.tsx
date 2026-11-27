/**
 * The do-hexes in Fly (selection-HUD S3b): the piloted ship's actions in the
 * bottom-right honeycomb, where BOOST and the old targeting stick were.
 *
 * Owner-approved set: Stance, Lock, Boost / More, Salvage, Cargo.
 * - Boost: the main action, thumb-nearest (cell 0), a HOLD (the host wraps it
 *   in `HoldButton`, which lets go on unmount); lit while held. Same input as
 *   the old BOOST button (`TouchInput.setBoostHeld`).
 * - Lock: the selection builder's Target (`selectionStripItems.tsx`, from
 *   `components/targetLock.ts`): lock / cancel / unlock the tapped thing with
 *   the active weapon group; lit while a lock is building or held; dim with
 *   nothing lockable tapped.
 * - Cargo: with a ship with a readable hold tapped, the selection builder's
 *   cargo Open (that ship's cargo, the same handler the strip had); else
 *   opens your hold (the `hold` rail panel).
 * - Stance: your weapons' fire mode, the one engage setting a piloted ship has
 *   (the fleet stance is for AI-flown ships): opens the choices IN the
 *   honeycomb, Auto fire / Hold fire (every group `auto` / `manual`) plus
 *   Back in the far corner.
 * - Salvage: the selection builder's pod Open; lit while the tapped pod is in
 *   reach (`withinLootOpenReach`, the server's rule), dim otherwise.
 * - More: the Details panel for what is tapped, else Contacts.
 *
 * Pure: unit-tested; `DoHexesHost` owns the state and the hooks.
 */
import { EqxIcon } from '../../ui/index.js';
import type { DoHex } from './doHexLayout.js';
import type { StripAction, StripButtonAction } from './stripActions.js';

/** Which hex set is showing: the actions, or the fire-mode (stance) choices. */
export type FlyHexSub = 'stance' | null;

/** Every weapon group's mode: one shared value, null when mixed or no groups. */
export type FlyFireMode = 'auto' | 'manual' | null;

export interface FlyDoHexOptions {
  sub: FlyHexSub;
  setSub: (sub: FlyHexSub) => void;
  /** The selection builder's actions (`useSelectionStripItems(...).items`). */
  selection: readonly StripAction[];
  fireMode: FlyFireMode;
  /** The ship has weapon groups (Stance has something to set). */
  hasGroups: boolean;
  setFireMode: (mode: 'auto' | 'manual') => void;
  boostHeld: boolean;
  setBoostHeld: (down: boolean) => void;
  openCargo: () => void;
  openMore: () => void;
}

const noop = (): void => {};

/** The strip actions the Fly hexes carry, so the left strip leaves them out
 *  while these hexes draw: Target -> Lock, the pod Open -> Salvage, the tapped
 *  ship's cargo -> Cargo, and the strip's Details (shown only with something
 *  tapped, when More opens Details) -> More. */
const FLY_LOCK = { key: 'target', testId: 'fc-target' } as const;
const FLY_SALVAGE = { key: 'loot', testId: 'pod-open' } as const;
const FLY_CARGO = { key: 'loot', testId: 'cargo-open-toggle' } as const;
const FLY_DETAILS = { key: 'details', testId: 'left-strip-details' } as const;
const FLY_COVERED = [FLY_LOCK, FLY_SALVAGE, FLY_CARGO, FLY_DETAILS] as const;

/** Is `a` carried by the Fly hexes (pure)? */
export function flyHexCovers(a: StripAction): boolean {
  if (a.kind === 'separator') return false;
  return FLY_COVERED.some((c) => c.key === a.key && c.testId === a.testId);
}

function button(actions: readonly StripAction[], key: string, testId?: string): StripButtonAction | null {
  const a = actions.find((x) => x.key === key && (testId === undefined || (x.kind !== 'separator' && x.testId === testId)));
  return a !== undefined && a.kind === 'button' ? a : null;
}

/** The fire-mode choices: Auto fire, Hold fire (current lit) plus Back. */
function stanceHexes(o: FlyDoHexOptions): DoHex[] {
  const pick = (m: 'auto' | 'manual') => (): void => { o.setSub(null); o.setFireMode(m); };
  return [
    {
      key: 'fire-auto', testId: 'do-hex-fire-auto', icon: <EqxIcon name="aggressive" />, word: 'Auto fire',
      tooltip: 'Stance: auto fire (weapons fire at their locks)', tone: 'danger', lit: o.fireMode === 'auto',
      onPress: pick('auto'),
    },
    {
      key: 'fire-manual', testId: 'do-hex-fire-manual', icon: <EqxIcon name="holdFire" />, word: 'Hold fire',
      tooltip: 'Stance: hold fire (weapons stay quiet)', tone: 'neutral', lit: o.fireMode === 'manual',
      onPress: pick('manual'),
    },
    {
      key: 'back', testId: 'do-hex-back', icon: <EqxIcon name="back" />, word: 'Back', tooltip: 'Back',
      tone: 'neutral', role: 'cancel', onPress: () => o.setSub(null),
    },
  ];
}

/** The Fly do-hexes. Nearness order (doHexLayout): Boost under the thumb, then
 *  Lock, Cargo, Stance, Salvage, More, so the rows read
 *  "Stance Lock Boost / More Salvage Cargo". */
export function flyDoHexes(o: FlyDoHexOptions): DoHex[] {
  if (o.sub === 'stance') return stanceHexes(o);
  const lock = button(o.selection, FLY_LOCK.key, FLY_LOCK.testId);
  const pod = button(o.selection, FLY_SALVAGE.key, FLY_SALVAGE.testId);
  const theirCargo = button(o.selection, FLY_CARGO.key, FLY_CARGO.testId);
  const locking = lock?.active === true;
  return [
    {
      key: 'boost', testId: 'do-hex-boost', icon: <EqxIcon name="boost" />, word: 'Boost', tooltip: 'Boost (hold)',
      tone: 'primary', role: 'main', lit: o.boostHeld, onPress: noop, onHold: o.setBoostHeld,
      state: o.boostHeld ? 'held' : 'idle',
    },
    {
      key: 'lock', testId: 'do-hex-lock', icon: <EqxIcon name="target" />, word: 'Lock',
      tooltip: lock?.tooltip ?? 'Lock: tap a target first', tone: 'danger', lit: locking, dim: lock === null,
      onPress: lock?.onPress ?? noop, state: lock?.state ?? 'none',
    },
    {
      key: 'cargo', testId: 'do-hex-cargo', icon: <EqxIcon name="hold" />, word: 'Cargo',
      tooltip: theirCargo !== null ? theirCargo.tooltip : 'Your hold', tone: 'neutral',
      lit: theirCargo?.active === true, onPress: theirCargo?.onPress ?? o.openCargo,
      state: theirCargo !== null ? 'theirs' : 'yours',
    },
    {
      key: 'stance', testId: 'do-hex-stance',
      icon: <EqxIcon name={o.fireMode === 'manual' ? 'holdFire' : o.fireMode === 'auto' ? 'aggressive' : 'mixed'} />,
      word: 'Stance',
      tooltip: `Stance: ${o.fireMode === 'manual' ? 'hold fire' : o.fireMode === 'auto' ? 'auto fire' : 'mixed'}`,
      tone: 'neutral', dim: !o.hasGroups, onPress: o.hasGroups ? () => o.setSub('stance') : noop,
      state: o.fireMode ?? 'mixed',
    },
    {
      key: 'salvage', testId: 'do-hex-salvage', icon: <EqxIcon name="pod" />, word: 'Salvage',
      tooltip: pod !== null ? 'Salvage: open the pod' : 'Salvage: nothing in reach', tone: 'warn',
      lit: pod !== null, dim: pod === null, onPress: pod?.onPress ?? noop, state: pod !== null ? 'in-reach' : 'none',
    },
    {
      key: 'more', testId: 'do-hex-more', icon: <EqxIcon name="details" />, word: 'More', tooltip: 'More',
      tone: 'primary', onPress: o.openMore,
    },
  ];
}
