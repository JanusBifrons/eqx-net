/**
 * Pure filter + format helpers over `AuditEvent[]`. Shared by the
 * `/dev/audit` endpoint (`auditRoute.ts`) and unit-tested directly. Kept
 * PURE (no I/O, no clock) so it is trivially testable and reusable.
 *
 * The standalone `scripts/query-audit.mjs` CLI mirrors this logic in plain
 * JS (it cannot import TS source); keep the two semantically aligned.
 */

import type { AuditEvent } from './GameplayAuditLog.js';

export interface AuditFilter {
  /** Match events INVOLVING this id (owner / playerId / attacker / victim / …). */
  player?: string;
  /** Match events whose `owner` equals this id. */
  owner?: string;
  /** Restrict to one sector. */
  sector?: string;
  /** One event type, or a list of types to include. */
  event?: string | string[];
  /** Inclusive lower bound (epoch ms). */
  since?: number;
  /** Inclusive upper bound (epoch ms). */
  until?: number;
  /** Keep only the most recent N (applied after sort). */
  limit?: number;
}

/** Every player/entity id an event references, for the `player` filter. */
export function eventIdentities(e: AuditEvent): string[] {
  const ids: string[] = [];
  const rec = e as unknown as Record<string, unknown>;
  for (const key of ['owner', 'playerId', 'attackerId', 'victim', 'killer', 'entityId', 'shipInstanceId']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) ids.push(v);
  }
  return ids;
}

/** Apply a filter, returning a NEW array sorted oldest→newest. */
export function filterAudit(events: readonly AuditEvent[], f: AuditFilter = {}): AuditEvent[] {
  const eventTypes = f.event === undefined
    ? null
    : new Set(Array.isArray(f.event) ? f.event : [f.event]);

  let out = events.filter((e) => {
    if (f.sector !== undefined && e.sector !== f.sector) return false;
    if (eventTypes && !eventTypes.has(e.event)) return false;
    if (f.since !== undefined && e.ts < f.since) return false;
    if (f.until !== undefined && e.ts > f.until) return false;
    if (f.owner !== undefined && (e as { owner?: string }).owner !== f.owner) return false;
    if (f.player !== undefined && !eventIdentities(e).includes(f.player)) return false;
    return true;
  });

  out.sort((a, b) => a.ts - b.ts);

  if (f.limit !== undefined && f.limit >= 0 && out.length > f.limit) {
    out = out.slice(out.length - f.limit);
  }
  return out;
}

/** A concise, human-readable one-liner for a single event. */
export function formatAuditLine(e: AuditEvent): string {
  const where = e.sector ? ` [${e.sector}]` : '';
  const head = `${e.iso}${where} ${e.event}`;
  switch (e.event) {
    case 'wave_dispatched':
      return `${head}: wave of ${e.squadSize} → ${e.targetSector} (owner=${e.owner}, squad=${e.squadId})`;
    case 'wave_incoming':
      return `${head}: ${e.count} ${e.label ?? 'ships'} inbound (${e.disposition})`;
    case 'base_ready':
      return `${head}: owner=${e.owner}`;
    case 'wave_repelled':
      return `${head}: owner=${e.owner}${e.reason ? ` (${e.reason})` : ''}`;
    case 'structure_placed':
      return `${head}: ${e.kind} owner=${e.owner} @(${Math.round(e.x)},${Math.round(e.y)})`;
    case 'structure_removed':
      return `${head}: ${e.kind} owner=${e.owner}`;
    case 'structure_built':
      return `${head}: ${e.kind} owner=${e.owner}`;
    case 'structure_attacked':
      return `${head}: ${e.kind} owner=${e.owner} by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'structure_destroyed':
      return `${head}: ${e.kind} owner=${e.owner} destroyed by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'base_destroyed':
      return `${head}: CAPITAL owner=${e.owner} destroyed by ${e.attackerId ?? '?'}`;
    case 'ship_destroyed':
      return `${head}: player=${e.playerId} by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'drone_destroyed':
      return `${head}: by ${e.attackerId ?? '?'}`;
    case 'player_killed':
      return `${head}: ${e.victim} killed by ${e.killer}`;
    case 'shield_broken':
      return `${head}: ${e.entityId}${e.owner ? ` owner=${e.owner}` : ''}`;
    case 'player_joined':
    case 'player_left':
      return `${head}: player=${e.playerId}`;
    case 'transit_started':
      return `${head}: player=${e.playerId} ${e.from ?? '?'} → ${e.to}`;
    case 'transit_arrived':
      return `${head}: player=${e.playerId} → ${e.to}`;
    case 'ship_lingered':
    case 'ship_abandoned':
      return `${head}: player=${(e as { playerId?: string }).playerId ?? '?'} ship=${e.shipInstanceId}`;
    default: {
      // exhaustiveness: any unhandled variant still prints usefully.
      return `${head}: ${JSON.stringify(e)}`;
    }
  }
}

/** A full timeline (one line per event), oldest→newest. */
export function formatAuditTimeline(events: readonly AuditEvent[]): string {
  return events.map(formatAuditLine).join('\n');
}
