import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Stub the read-only Database connection — diagRouter imports it for the
// /dev/stats endpoint. vite 5.4.21 doesn't recognise `node:sqlite` as a
// builtin (Node 22.5+ feature) and fails to load the module transitively.
// The capture endpoint tests don't exercise stats, so a no-op `db` is fine.
vi.mock('../db/Database.js', () => ({
  db: { prepare: () => ({ get: () => null, run: () => ({}), all: () => [] }), exec: () => {} },
}));

let tempDir: string;
let originalCwd: string;
let app: Express;
let server: Server;
let baseUrl: string;
let captureDir: string;

beforeAll(async () => {
  // CAPTURE_DIR is resolved at module load from process.cwd(); chdir before
  // first import so the router writes into our temp dir.
  tempDir = await mkdtemp(join(tmpdir(), 'eqx-diag-test-'));
  originalCwd = process.cwd();
  process.chdir(tempDir);

  const mod = await import('./diagRouter.js');
  captureDir = mod.captureDir;

  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/diag', mod.diagRouter);

  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.chdir(originalCwd);
  await rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe any captures from prior tests so file-count assertions stand alone.
  await rm(captureDir, { recursive: true, force: true });
});

interface SummaryShape {
  capturedAt: string;
  dirName: string;
  note: string | null;
  userAgent: string | null;
  viewport: { w: number; h: number } | null;
  clientEpochMs: number | null;
  serverReceivedAtMs: number;
  timing: {
    note: string;
    client: { firstTs: number | null; lastTs: number | null; durationMs: number | null };
    server: { firstTs: number | null; lastTs: number | null; durationMs: number | null };
  };
  counts: {
    total: number;
    buckets: Record<string, number>;
    tags: Record<string, number>;
  };
  highlights: {
    topTickHitches: unknown[];
    topTickBudgets: unknown[];
    gcPauses: unknown[];
    topCorrections: unknown[];
    firstError: unknown;
  };
  stats: Record<string, unknown> | null;
  files: string[];
}

describe('diagRouter', () => {
  it('writes a directory with summary + bucketed NDJSON siblings', async () => {
    const res = await fetch(`${baseUrl}/diag/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: 'corr feels bad',
        userAgent: 'Mozilla/5.0 (Pixel 7) Mobile',
        viewport: { w: 412, h: 915 },
        clientEpochMs: 1_700_000_000_000,
        stats: { rttMs: 32, rollingCorrRate: 0.45 },
        logs: [
          { ts: 1000, tag: 'snapshot', data: { serverTick: 100, ackedTick: 95 } },
          { ts: 1050, tag: 'rafTick', data: { elapsedMs: 33, deficitBefore: 2 } },
          { ts: 1100, tag: 'correction', data: { driftUnits: 12.5, angleDriftRad: 0.01 } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; dir: string; filename: string };
    expect(body.ok).toBe(true);
    expect(typeof body.dir).toBe('string');
    expect(body.filename).toBe(body.dir);

    const dirs = await readdir(captureDir);
    expect(dirs).toHaveLength(1);
    const dirPath = join(captureDir, dirs[0]!);

    const files = await readdir(dirPath);
    expect(files).toContain('summary.json');
    expect(files).toContain('snapshots.ndjson');
    expect(files).toContain('raf.ndjson');
    expect(files).toContain('corrections.ndjson');

    // Empty buckets are skipped to keep the directory scannable.
    expect(files).not.toContain('combat.ndjson');
    expect(files).not.toContain('lifecycle.ndjson');
    expect(files).not.toContain('other.ndjson');

    const summary = JSON.parse(await readFile(join(dirPath, 'summary.json'), 'utf8')) as SummaryShape;
    expect(summary.note).toBe('corr feels bad');
    expect(summary.userAgent).toContain('Pixel 7');
    expect(summary.clientEpochMs).toBe(1_700_000_000_000);
    expect(summary.stats?.['rollingCorrRate']).toBe(0.45);
    expect(summary.counts.buckets['snapshots']).toBe(1);
    expect(summary.counts.buckets['raf']).toBe(1);
    expect(summary.counts.buckets['corrections']).toBe(1);
    expect(summary.counts.tags['client/snapshot']).toBe(1);
    expect(summary.files).toEqual(expect.arrayContaining(['snapshots.ndjson', 'raf.ndjson', 'corrections.ndjson']));

    // The correction we sent should be visible in the highlights since it's the only one.
    expect(Array.isArray(summary.highlights.topCorrections)).toBe(true);
    expect(summary.highlights.topCorrections).toHaveLength(1);

    // NDJSON sibling routes the right entry.
    const snapshotsNd = await readFile(join(dirPath, 'snapshots.ndjson'), 'utf8');
    const lines = snapshotsNd.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { source: string; tag: string; data: { serverTick: number } };
    expect(entry.source).toBe('client');
    expect(entry.tag).toBe('snapshot');
    expect(entry.data.serverTick).toBe(100);
  });

  it('rejects malformed payloads with 400', async () => {
    const res = await fetch(`${baseUrl}/diag/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: 'not an array' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects payloads above the 2 MB ceiling with 413', async () => {
    // Each entry ~120 bytes serialised; 25 000 entries → ~3 MB.
    const logs = Array.from({ length: 25_000 }, (_, i) => ({
      ts: i,
      tag: 'snapshot',
      data: { padding: 'x'.repeat(100) },
    }));
    const res = await fetch(`${baseUrl}/diag/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs }),
    });
    expect(res.status).toBe(413);
  });
});
