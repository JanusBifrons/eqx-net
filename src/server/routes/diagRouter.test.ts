import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

describe('diagRouter', () => {
  it('writes a capture file from a valid POST', async () => {
    const res = await fetch(`${baseUrl}/diag/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: 'corr feels bad',
        userAgent: 'Mozilla/5.0 (Pixel 7) Mobile',
        viewport: { w: 412, h: 915 },
        stats: { rttMs: 32, rollingCorrRate: 0.45 },
        logs: [
          { ts: 1000, tag: 'snapshot', data: { serverTick: 100, ackedTick: 95 } },
          { ts: 1050, tag: 'rafTick', data: { elapsedMs: 33, deficitBefore: 2 } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; filename: string };
    expect(body.ok).toBe(true);
    expect(typeof body.filename).toBe('string');

    const files = await readdir(captureDir);
    expect(files).toHaveLength(1);

    const json = JSON.parse(await readFile(join(captureDir, files[0]!), 'utf8'));
    expect(json.note).toBe('corr feels bad');
    expect(json.userAgent).toContain('Pixel 7');
    expect(json.stats.rollingCorrRate).toBe(0.45);
    expect(json.logs).toHaveLength(2);
    expect(Array.isArray(json.serverEvents)).toBe(true);
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
