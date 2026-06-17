#!/usr/bin/env node
/**
 * Query the gameplay audit log (durable NDJSON written by
 * `src/server/audit/GameplayAuditLog.ts` via pino-roll). This is the tool to
 * run when answering "what happened to my base?" — it reads the FULL on-disk
 * history (the `/dev/audit` endpoint is the live/recent convenience; this
 * works offline with the server down).
 *
 * It reads every `*.ndjson` under `audit-logs/` (override with
 * `EQX_AUDIT_DIR` or `--dir=`), filters, and prints a sorted human-readable
 * timeline (or raw JSON with `--json`).
 *
 * Filter semantics mirror `src/server/audit/auditQuery.ts` (kept aligned;
 * this is plain JS and cannot import the TS helper).
 *
 * Usage:
 *   node scripts/query-audit.mjs [--sector=sol-prime] [--owner=<id>]
 *     [--player=<id>] [--event=structure_destroyed,base_destroyed]
 *     [--since=24h] [--until=<iso|epoch>] [--limit=200] [--json] [--dir=path]
 *
 *   --since accepts epoch ms, an ISO date, or a relative duration
 *   (30m / 2h / 7d / 1w).
 *   --player matches events INVOLVING the id (owner/playerId/attacker/victim).
 *
 * Read-only.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── arg parsing ─────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] ?? true;
}
if (args.help || args.h) {
  console.log('Usage: node scripts/query-audit.mjs [--sector=] [--owner=] [--player=] [--event=a,b] [--since=24h] [--until=] [--limit=] [--json] [--dir=]');
  process.exit(0);
}

const dir = resolve(args.dir || process.env.EQX_AUDIT_DIR || 'audit-logs');

// ── time arg → epoch ms ──────────────────────────────────────────────────
function parseTime(raw) {
  if (raw === undefined || raw === true) return undefined;
  const rel = /^(\d+)([smhdw])$/.exec(String(raw).trim());
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]] ?? 0;
    return Date.now() - Number(rel[1]) * unit;
  }
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(String(raw));
  return Number.isNaN(d) ? undefined : d;
}

// ── load NDJSON ───────────────────────────────────────────────────────────
function loadEvents() {
  if (!existsSync(dir)) {
    console.error(`audit dir not found: ${dir}`);
    return [];
  }
  // pino-roll writes `audit.<date>.<n>.log`; the fallback writes `audit.ndjson`.
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson') || f.endsWith('.log')).sort();
  const out = [];
  for (const f of files) {
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && typeof rec.event === 'string' && typeof rec.ts === 'number') out.push(rec);
      } catch { /* skip */ }
    }
  }
  return out;
}

// ── filter ─────────────────────────────────────────────────────────────────
function identities(e) {
  const ids = [];
  for (const k of ['owner', 'playerId', 'attackerId', 'victim', 'killer', 'entityId', 'shipInstanceId']) {
    if (typeof e[k] === 'string' && e[k]) ids.push(e[k]);
  }
  return ids;
}

const since = parseTime(args.since);
const until = parseTime(args.until);
const eventTypes = typeof args.event === 'string'
  ? new Set(args.event.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

let events = loadEvents().filter((e) => {
  if (args.sector && e.sector !== args.sector) return false;
  if (eventTypes && !eventTypes.has(e.event)) return false;
  if (since !== undefined && e.ts < since) return false;
  if (until !== undefined && e.ts > until) return false;
  if (args.owner && e.owner !== args.owner) return false;
  if (args.player && !identities(e).includes(args.player)) return false;
  return true;
});

events.sort((a, b) => a.ts - b.ts);
const limit = args.limit !== undefined ? Number(args.limit) : undefined;
if (limit !== undefined && limit >= 0 && events.length > limit) {
  events = events.slice(events.length - limit);
}

// ── format ───────────────────────────────────────────────────────────────
function line(e) {
  const where = e.sector ? ` [${e.sector}]` : '';
  const head = `${e.iso}${where} ${e.event}`;
  switch (e.event) {
    case 'wave_dispatched': return `${head}: wave of ${e.squadSize} → ${e.targetSector} (owner=${e.owner}, squad=${e.squadId})`;
    case 'wave_incoming': return `${head}: ${e.count} ${e.label ?? 'ships'} inbound (${e.disposition})`;
    case 'base_ready': return `${head}: owner=${e.owner}`;
    case 'wave_repelled': return `${head}: owner=${e.owner}`;
    case 'structure_placed': return `${head}: ${e.kind} owner=${e.owner} @(${Math.round(e.x)},${Math.round(e.y)})`;
    case 'structure_removed': return `${head}: ${e.kind} owner=${e.owner}`;
    case 'structure_built': return `${head}: ${e.kind} owner=${e.owner}`;
    case 'structure_attacked': return `${head}: ${e.kind} owner=${e.owner} by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'structure_destroyed': return `${head}: ${e.kind} owner=${e.owner} destroyed by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'base_destroyed': return `${head}: CAPITAL owner=${e.owner} destroyed by ${e.attackerId ?? '?'}`;
    case 'ship_destroyed': return `${head}: player=${e.playerId} by ${e.attackerId ?? '?'}${e.attackerKind ? ` (${e.attackerKind})` : ''}`;
    case 'drone_destroyed': return `${head}: by ${e.attackerId ?? '?'}`;
    case 'player_killed': return `${head}: ${e.victim} killed by ${e.killer}`;
    case 'shield_broken': return `${head}: ${e.entityId}${e.owner ? ` owner=${e.owner}` : ''}`;
    case 'player_joined':
    case 'player_left': return `${head}: player=${e.playerId}`;
    case 'transit_started': return `${head}: player=${e.playerId} ${e.from ?? '?'} → ${e.to}`;
    case 'transit_arrived': return `${head}: player=${e.playerId} → ${e.to}`;
    case 'ship_lingered':
    case 'ship_abandoned': return `${head}: player=${e.playerId ?? '?'} ship=${e.shipInstanceId}`;
    default: return `${head}: ${JSON.stringify(e)}`;
  }
}

if (args.json) {
  console.log(JSON.stringify(events, null, 2));
} else {
  for (const e of events) console.log(line(e));
  console.error(`\n${events.length} event(s) from ${dir}`);
}
