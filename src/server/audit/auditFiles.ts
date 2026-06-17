/**
 * Read the durable audit NDJSON files back into `AuditEvent[]`. Used by the
 * `/dev/audit` endpoint when `?source=files|all` (full history beyond the
 * in-memory ring). The standalone `scripts/query-audit.mjs` does the
 * equivalent read in plain JS.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEvent } from './GameplayAuditLog.js';

/** Parse every `*.ndjson` file under `dir` into events (bad lines skipped). */
export async function loadAuditFromDisk(dir: string): Promise<AuditEvent[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort();
  } catch {
    return []; // dir doesn't exist yet
  }
  const out: AuditEvent[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as AuditEvent;
        if (rec && typeof rec.event === 'string' && typeof rec.ts === 'number') out.push(rec);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}
