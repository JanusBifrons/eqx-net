import { getSector } from '../../core/galaxy/galaxy';
import type { SectorLiveState } from '../../shared-types/galaxySnapshot.js';
import { factionDisplayName } from '../../shared-types/factions.js';
import { SECTOR_PLAYABLE_HALF_EXTENT } from '../../shared-types/sectorBounds.js';
import { factionColor } from '../render/galaxy/galaxyTerritories';
import type { RosterEntry, UIStore } from '../state/storeTypes';
import { buildSectorTooltip } from './galaxyTooltip';
import { cssHex } from './sectorPanelParts';

/**
 * Pure content of the join loading screen's "sector briefing" (WarpScreen,
 * Idea A). Everything here comes from data the client ALREADY holds before
 * the room joins: the static galaxy graph, the last `/galaxy/snapshot` poll
 * (`galaxyStats`, via the shared `buildSectorTooltip`) and the roster poll
 * (`shipRoster`). No new endpoint, no per-frame work: called on render only,
 * which happens on store changes (gate flips, poll replies).
 */

/** The join gates WarpScreen waits on, in order. The progress bar fills one
 *  step per gate DONE — never a timer. Mirrors `computeGameReadyFromState`. */
export const JOIN_GATE_COUNT = 9;

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
>;

export type JoinStepId = 'connect' | 'ship' | 'sector' | 'draw' | 'place' | 'arrive';

/** The loading steps the screen lists, in order: a playful headline `name`
 *  and a plain-English `detail` of what is really happening. Pure data. */
export const JOIN_STEP_TEXT: readonly { id: JoinStepId; name: string; detail: string }[] = [
  { id: 'connect', name: 'Tuning the subspace antenna', detail: 'Connecting to the sector server' },
  { id: 'ship', name: 'Rummaging for your ship keys', detail: 'Looking up the ship you are flying' },
  { id: 'sector', name: 'Unpacking the sector', detail: 'Downloading the ships, rocks and structures around you' },
  { id: 'draw', name: 'Texturizing the void', detail: 'Drawing the world on your screen' },
  { id: 'place', name: 'Parallel-parking in orbit', detail: 'Putting your ship where the server says it is' },
  { id: 'arrive', name: 'Calibrating warp ballast', detail: 'Agreeing the exact moment you arrive with the server' },
];

/** One loading step over one or more of the {@link JOIN_GATE_COUNT} join
 *  gates. `done` = every gate in it is done. */
export interface JoinGateStep {
  id: JoinStepId;
  name: string;
  detail: string;
  /** Gates this step covers. */
  gates: number;
  /** Of those, how many are done. */
  gatesDone: number;
  done: boolean;
}

/** The join gates grouped into the ordered steps the loading screen lists.
 *  The ONLY place the gate checks live: {@link joinGatesDone} counts from
 *  this, so the list and the bar can never disagree. The minimum-display
 *  floor (`joinMinimumElapsed`) folds into "draw" so it never reads as a
 *  step of its own. A spectator joining with no ship never gets a ship id or
 *  pose, so those count as done for them (as `computeBootstrapReadyFromState`
 *  treats them). */
export function joinGateSteps(s: JoinGateState): JoinGateStep[] {
  const shiplessSpectator = s.pilotMode === 'spectator' && s.localShipInstanceId === null;
  const checks: Record<JoinStepId, readonly boolean[]> = {
    connect: [s.connectionStatus === 'connected'],
    ship: [s.localShipInstanceId !== null || shiplessSpectator],
    sector: [s.firstSnapshotApplied],
    draw: [s.rendererFirstFrameRendered, s.joinMinimumElapsed],
    place: [s.localPoseResolved || shiplessSpectator, s.clientReadySent],
    arrive: [s.arrivalTickFromServer !== null, s.arrivalAcked],
  };
  return JOIN_STEP_TEXT.map(({ id, name, detail }) => {
    const c = checks[id];
    let n = 0;
    for (const ok of c) if (ok) n++;
    return { id, name, detail, gates: c.length, gatesDone: n, done: n === c.length };
  });
}

/** How many of the {@link JOIN_GATE_COUNT} join gates are done (0..9),
 *  counted from {@link joinGateSteps}. */
export function joinGatesDone(s: JoinGateState): number {
  let n = 0;
  for (const st of joinGateSteps(s)) n += st.gatesDone;
  return n;
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

/** A radar blip in the 100×100 radar viewBox (centre 50,50, rim radius 46). */
export interface BriefingBlip {
  id: string;
  cx: number;
  cy: number;
}

export interface SectorBriefing {
  name: string;
  /** "Held by Sol Dominion", "Held by Sol Dominion · contested", "Unclaimed". */
  ownerLine: string;
  /** CSS colour of the holder's sigil dot (the neutral grey when unclaimed). */
  ownerColor: string;
  held: boolean;
  facts: readonly BriefingFact[];
  blips: readonly BriefingBlip[];
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

/** Radar blips: the player's own roster hulls in this sector (their last
 *  roster position), scaled to the playable extent and clamped to the rim.
 *  Game Y is up, SVG Y is down. */
function rosterBlips(roster: readonly RosterEntry[], sectorKey: string): BriefingBlip[] {
  const out: BriefingBlip[] = [];
  const scale = 46 / SECTOR_PLAYABLE_HALF_EXTENT;
  for (const ship of roster) {
    if (ship.sectorKey !== sectorKey) continue;
    let dx = ship.x * scale;
    let dy = -ship.y * scale;
    const r = Math.hypot(dx, dy);
    if (r > 44) {
      dx = (dx / r) * 44;
      dy = (dy / r) * 44;
    }
    out.push({ id: ship.shipId, cx: 50 + dx, cy: 50 + dy });
  }
  return out;
}

/** The briefing for `sectorKey`, or null for an unknown / absent key. */
export function buildSectorBriefing(
  sectorKey: string | null,
  stats: readonly SectorLiveState[],
  roster: readonly RosterEntry[],
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
    blips: rosterBlips(roster, sectorKey),
  };
}
