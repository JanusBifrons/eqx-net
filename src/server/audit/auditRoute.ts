/**
 * `GET /dev/audit` — query the gameplay audit log from the running server.
 * Dev-gated (mounted in index.ts inside the `NODE_ENV !== 'production'`
 * block), mirroring `/dev/events` / `/dev/population`.
 *
 * Query params (all optional):
 *   player  — events involving this id (owner / playerId / attacker / victim)
 *   owner   — events whose owner == this id
 *   sector  — restrict to one sector key
 *   event   — comma-separated list of event types to include
 *   since   — epoch ms, ISO date, or relative duration (e.g. 30m, 2h, 7d)
 *   until   — epoch ms or ISO date
 *   limit   — keep the most recent N (default 500)
 *   source  — ring | files | all (default all: disk history + live ring tail)
 *   format  — json (default) | text (a rendered timeline)
 */

import type { Request, Response } from 'express';
import { getRecentAudit, auditLogDir, type AuditEvent } from './GameplayAuditLog.js';
import { loadAuditFromDisk } from './auditFiles.js';
import { filterAudit, formatAuditTimeline, type AuditFilter } from './auditQuery.js';

/** epoch ms | ISO | relative (`30m`/`2h`/`7d`/`1w`) → epoch ms (or undefined). */
function parseTimeArg(raw: string | undefined, nowMs: number): number | undefined {
  if (!raw) return undefined;
  const rel = /^(\d+)([smhdw])$/.exec(raw.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[rel[2]!] ?? 0;
    return nowMs - n * unit;
  }
  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;
  const asDate = Date.parse(raw);
  return Number.isNaN(asDate) ? undefined : asDate;
}

function str(q: unknown): string | undefined {
  return typeof q === 'string' && q.length > 0 ? q : undefined;
}

export async function devAuditHandler(req: Request, res: Response): Promise<void> {
  const now = Date.now();
  const source = str(req.query['source']) ?? 'all';
  const ring = getRecentAudit(Number.MAX_SAFE_INTEGER);

  let events: AuditEvent[] = [];
  if (source === 'ring') {
    events = ring;
  } else {
    const disk = await loadAuditFromDisk(auditLogDir());
    if (source === 'files') {
      events = disk;
    } else {
      // all: disk history + the live ring tail not yet flushed to disk.
      const maxDiskTs = disk.length ? disk[disk.length - 1]!.ts : -Infinity;
      events = disk.concat(ring.filter((e) => e.ts > maxDiskTs));
    }
  }

  const eventParam = str(req.query['event']);
  const limitParam = str(req.query['limit']);
  const filter: AuditFilter = {
    player: str(req.query['player']),
    owner: str(req.query['owner']),
    sector: str(req.query['sector']),
    event: eventParam ? eventParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    since: parseTimeArg(str(req.query['since']), now),
    until: parseTimeArg(str(req.query['until']), now),
    limit: limitParam !== undefined ? Number(limitParam) : 500,
  };

  const filtered = filterAudit(events, filter);

  if (str(req.query['format']) === 'text') {
    res.type('text/plain').send(formatAuditTimeline(filtered));
    return;
  }
  res.json({ count: filtered.length, events: filtered });
}
