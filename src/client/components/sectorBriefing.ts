import { getSector } from '../../core/galaxy/galaxy';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import { factionDisplayName } from '../../shared-types/factions.js';
import { factionColor } from '../render/galaxy/galaxyTerritories';
import type { UIStore } from '../state/storeTypes';
import { buildSectorTooltip } from './galaxyTooltip';
import { cssHex } from './sectorPanelParts';

/**
 * Pure content of the join loading screen's "sector briefing" (WarpScreen,
 * Idea A). Everything here comes from data the client ALREADY holds before
 * the room joins: the static galaxy graph, the last `/galaxy/snapshot` poll
 * (`galaxyStats`, via the shared `buildSectorTooltip`). No new endpoint, no per-frame work: called on render only,
 * which happens on store changes (gate flips, poll replies).
 */

/** The join gates WarpScreen waits on, in order: `computeGameReadyFromState`'s
 *  plus the art bake that holds `client_ready`. Never a timer. */
export const JOIN_GATE_COUNT = 10;

export type JoinGateState = Pick<
  UIStore,
  | 'connectionStatus'
  | 'localShipInstanceId'
  | 'rendererFirstFrameRendered'
  | 'firstSnapshotApplied'
  | 'joinMinimumElapsed'
  | 'localPoseResolved'
  | 'clientReadySent'
  | 'arrivalTickFromServer'
  | 'arrivalAcked'
  | 'pilotMode'
  | 'artBakeReady'
  | 'artBakePct'
>;

export type JoinStepId = 'connect' | 'ship' | 'sector' | 'draw' | 'bake' | 'place' | 'arrive';

/** The loading steps the screen lists, in order, each named for what the
 *  game is really doing at that moment. Pure data. */
export const JOIN_STEP_TEXT: readonly { id: JoinStepId; name: string }[] = [
  { id: 'connect', name: 'Connecting to the sector server' },
  { id: 'ship', name: 'Finding your ship' },
  { id: 'sector', name: 'Downloading ships, rocks and structures' },
  { id: 'draw', name: 'Drawing the first frame' },
  { id: 'bake', name: 'Baking ship textures' },
  { id: 'place', name: 'Placing your ship' },
  { id: 'arrive', name: 'Syncing your arrival with the server' },
];

/** The fun lines the loading screen cycles through in one fixed spot, so
 *  something always moves (proof it has not frozen). Says nothing about real
 *  progress: the step list does that. */
export const LOADING_QUIPS: readonly string[] = [
  'Shimmering the shields',
  'Percolating the plasma',
  'Tuning the subspace antenna',
  'Rummaging for your ship keys',
  'Texturizing the void',
  'Parallel-parking in orbit',
  'Calibrating warp ballast',
  'Polishing the hull rivets',
];

/** One loading step over one or more of the {@link JOIN_GATE_COUNT} join
 *  gates. `done` = every gate in it is done. */
export interface JoinGateStep {
  id: JoinStepId;
  name: string;
  /** Gates this step covers. */
  gates: number;
  /** Of those, how many are done. */
  gatesDone: number;
  done: boolean;
  /** 0..100: the real share of the bake for "bake", else the share of its gates. */
  pct: number;
}

/** The join gates grouped into the ordered steps the loading screen lists.
 *  The ONLY place the gate checks live: the bar ({@link joinOverallPct}) is
 *  derived from these steps, so the list and the bar can never disagree. The minimum-display
 *  floor (`joinMinimumElapsed`) holds `client_ready`, so it folds into
 *  "place". A spectator joining with no ship never gets a ship id or pose, so
 *  those count as done for them (as `computeBootstrapReadyFromState` treats
 *  them). */
export function joinGateSteps(s: JoinGateState): JoinGateStep[] {
  const shiplessSpectator = s.pilotMode === 'spectator' && s.localShipInstanceId === null;
  const checks: Record<JoinStepId, readonly boolean[]> = {
    connect: [s.connectionStatus === 'connected'],
    ship: [s.localShipInstanceId !== null || shiplessSpectator],
    sector: [s.firstSnapshotApplied],
    draw: [s.rendererFirstFrameRendered],
    bake: [s.artBakeReady || s.clientReadySent],
    place: [s.localPoseResolved || shiplessSpectator, s.joinMinimumElapsed, s.clientReadySent],
    arrive: [s.arrivalTickFromServer !== null, s.arrivalAcked],
  };
  return JOIN_STEP_TEXT.map(({ id, name }) => {
    const c = checks[id];
    let n = 0;
    for (const ok of c) if (ok) n++;
    const done = n === c.length;
    const pct = done ? 100 : id === 'bake' ? Math.min(99, s.artBakePct) : Math.floor((n / c.length) * 100);
    return { id, name, gates: c.length, gatesDone: n, done, pct };
  });
}

/** The whole load, 0..100: the mean of the steps' percentages, so the bake's
 *  own progress moves the main bar too. */
export function joinOverallPct(steps: readonly JoinGateStep[]): number {
  if (steps.length === 0) return 100;
  let sum = 0;
  for (const st of steps) sum += st.pct;
  return Math.floor(sum / steps.length);
}

/** Index of the step in progress (the first not done), or -1 when all are. */
export function currentJoinStepIndex(steps: readonly JoinGateStep[]): number {
  return steps.findIndex((st) => !st.done);
}

/** `galaxy-<key>` room name → sector key, else null (`sector`, `galaxy-test`, …). */
export function sectorKeyFromRoomName(roomName: string | undefined | null): string | null {
  if (!roomName || !roomName.startsWith('galaxy-')) return null;
  const key = roomName.slice('galaxy-'.length);
  return getSector(key) ? key : null;
}

export interface BriefingFact {
  id: 'pilots' | 'structures' | 'rocks' | 'threat';
  label: string;
  value: string;
}

export interface SectorBriefing {
  name: string;
  /** "Held by Sol Dominion", "Held by Sol Dominion · contested", "Unclaimed". */
  ownerLine: string;
  /** CSS colour of the holder's sigil dot (the neutral grey when unclaimed). */
  ownerColor: string;
  held: boolean;
  facts: readonly BriefingFact[];
}

/** The holder's readable name. A player-held sector has no NPC faction name
 *  here and the client has no player-name lookup for it, so it reads as a
 *  player faction (never the raw id). */
function holderName(id: string): string {
  if (id === 'robots') return 'Robot Dominion';
  return factionDisplayName(id) ?? 'a player faction';
}

function rocksValue(key: string): string {
  const sector = getSector(key);
  if (!sector) return '—';
  const field = sector.features.includes('asteroid');
  switch (sector.asteroidConfigKey) {
    case 'dense': return field ? 'Dense field' : 'Dense';
    case 'sparse': return field ? 'Field' : 'Scattered';
    default: return field ? 'Field' : 'Clear';
  }
}

function threatValue(live: { enemies: number; capital: string | null; elite: string | null }): string {
  if (live.enemies > 0) return `${live.enemies} hostile`;
  if (live.capital !== null) return 'Flagship';
  if (live.elite !== null) return 'Elite';
  return 'Quiet';
}

/** The briefing for `sectorKey`, or null for an unknown / absent key. */
export function buildSectorBriefing(
  sectorKey: string | null,
  stats: readonly SectorLiveState[],
): SectorBriefing | null {
  if (sectorKey === null) return null;
  const tip = buildSectorTooltip(sectorKey, stats);
  if (!tip) return null;
  const held = tip.holderId !== null;
  const ownerLine = held
    ? `Held by ${holderName(tip.holderId!)}${tip.status === 'Contested' || tip.challenger !== null ? ' · contested' : ''}`
    : 'Unclaimed';
  return {
    name: tip.name,
    ownerLine,
    ownerColor: cssHex(factionColor(tip.holderId ?? '')),
    held,
    facts: [
      { id: 'pilots', label: 'Pilots', value: String(tip.players) },
      { id: 'structures', label: 'Structures', value: String(tip.structures) },
      { id: 'rocks', label: 'Rock field', value: rocksValue(sectorKey) },
      { id: 'threat', label: 'Threat', value: threatValue(tip) },
    ],
  };
}
