/**
 * Living World P4c — the Contracts board (`GET /galaxy/contracts`).
 *
 * A pure builder over the live elites + the running world event, plus a
 * nullable process singleton (the `galaxyStatsProvider` pattern) that the
 * route reads. Null (Living World disabled / before boot) ⇒ an empty board.
 * Off the 60 Hz tick — a polled HTTP read, no netgate.
 */
import {
  ELITE_BOUNTY_CREDITS,
  MOTHERSHIP_BOUNTY_CREDITS,
  type Contract,
  type ContractsResponse,
} from '../../shared-types/contracts.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { WorldEventKind } from '../../shared-types/worldEvents.js';
import type { EliteSummary } from './EliteDirector.js';

export interface ContractSources {
  elites(): readonly EliteSummary[];
  activeEvent(): { kind: WorldEventKind; title: string; endsAtMs: number; sectorKey: string } | null;
}

const EVENT_DETAIL: Readonly<Record<WorldEventKind, string>> = {
  incursion: 'Destroy every raider — a reward cache drops',
  mothership: 'Destroy the carrier — its escorts flee',
  salvage: 'Rich loot pods, free to whoever gets there first',
};

/** Build the board (newest-first is irrelevant: elites, then the event). */
export function buildContracts(src: ContractSources | null): ContractsResponse {
  if (src === null) return { contracts: [] };
  const contracts: Contract[] = [];
  for (const e of src.elites()) {
    contracts.push({
      id: `elite:${e.id}`,
      kind: 'elite',
      title: e.name,
      detail: `${getShipKind(e.kind).displayName} elite`,
      sectorKey: e.sectorKey,
      rewardCredits: ELITE_BOUNTY_CREDITS,
      endsAtMs: null,
    });
  }
  const ev = src.activeEvent();
  if (ev !== null) {
    contracts.push({
      id: `event:${ev.kind}:${ev.sectorKey}`,
      kind: 'event',
      title: ev.title,
      detail: EVENT_DETAIL[ev.kind],
      sectorKey: ev.sectorKey,
      rewardCredits: ev.kind === 'mothership' ? MOTHERSHIP_BOUNTY_CREDITS : null,
      endsAtMs: ev.endsAtMs,
    });
  }
  return { contracts };
}

let provider: ContractSources | null = null;

export function setContractsProvider(p: ContractSources | null): void {
  provider = p;
}

export function getContractsProvider(): ContractSources | null {
  return provider;
}
