import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { galaxyRouter } from './galaxyRouter.js';
import { GalaxySnapshotResponseSchema, SectorHistoryResponseSchema } from '../../shared-types/galaxySnapshot.js';
import { DEFAULT_SECTOR_KEY } from '../../core/galaxy/galaxy.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/galaxy', galaxyRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('galaxyRouter — the shared galaxy feed', () => {
  it('/snapshot is public, CDN-cacheable for 10 s, and the same bytes on repeat', async () => {
    const a = await fetch(`${baseUrl}/galaxy/snapshot`);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toBe('public, max-age=10');
    expect(a.headers.get('content-type')).toMatch(/application\/json/);
    const textA = await a.text();
    expect(GalaxySnapshotResponseSchema.safeParse(JSON.parse(textA)).success).toBe(true);
    const textB = await (await fetch(`${baseUrl}/galaxy/snapshot`)).text();
    expect(textB).toBe(textA);
  });

  it('/sector/:key/history answers a known sector and 404s an unknown one', async () => {
    const ok = await fetch(`${baseUrl}/galaxy/sector/${DEFAULT_SECTOR_KEY}/history`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('public, max-age=10');
    const body = SectorHistoryResponseSchema.parse(await ok.json());
    expect(body.key).toBe(DEFAULT_SECTOR_KEY);
    const bad = await fetch(`${baseUrl}/galaxy/sector/${'x'.repeat(80)}/history`);
    expect(bad.status).toBe(404);
    const unknown = await fetch(`${baseUrl}/galaxy/sector/not-a-sector/history`);
    expect(unknown.status).toBe(404);
  });
});
