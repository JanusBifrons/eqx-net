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

/** How many of the {@link JOIN_GATE_COUNT} join gates are done (0..9). A
 *  spectator joining with no ship never gets a ship id or pose, so those two
 *  count as done for them (as `computeBootstrapReadyFromState` treats them). */
export function joinGatesDone(s: JoinGateState): number {
  const shiplessSpectator = s.pilotMode === 'spectator' && s.localShipInstanceId === null;
  let n = 0;
  if (s.connectionStatus === 'connected') n++;
  if (s.localShipInstanceId !== null || shiplessSpectator) n++;
  if (s.rendererFirstFrameRendered) n++;
  if (s.firstSnapshotApplied) n++;
  if (s.joinMinimumElapsed) n++;
  if (s.localPoseResolved || shiplessSpectator) n++;
  if (s.clientReadySent) n++;
  if (s.arrivalTickFromServer !== null) n++;
  if (s.arrivalAcked) n++;
  return n;
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
