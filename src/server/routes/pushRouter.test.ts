import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Isolate the ROUTES: mock the auth + push service layers so we test routing,
// validation, and the bearer-auth gate only (mirrors authRouter.test.ts).
vi.mock('../auth/AuthService.js', () => ({
  validateToken: vi.fn(async (token: string) => (token === 'good' ? 'u1' : null)),
}));
const putSubscription = vi.fn();
const deleteSubscriptionByEndpoint = vi.fn();
vi.mock('../push/pushSubscriptions.js', () => ({
  putSubscription: (...args: unknown[]) => putSubscription(...args),
  deleteSubscriptionByEndpoint: (...args: unknown[]) => deleteSubscriptionByEndpoint(...args),
}));
vi.mock('../push/webPush.js', () => ({ vapidPublicKey: 'PUBKEY', pushEnabled: true }));

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const mod = await import('./pushRouter.js');
  app = express();
  app.use(express.json());
  app.use('/push', mod.pushRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const VALID_SUB = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('pushRouter', () => {
  it('GET /push/vapid-public-key returns the key + enabled flag', async () => {
    const res = await fetch(`${baseUrl}/push/vapid-public-key`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'PUBKEY', enabled: true });
  });

  it('POST /push/subscribe without a token returns 401', async () => {
    const res = await post('/push/subscribe', VALID_SUB);
    expect(res.status).toBe(401);
    expect(putSubscription).not.toHaveBeenCalled();
  });

  it('POST /push/subscribe with an invalid token returns 401', async () => {
    const res = await post('/push/subscribe', VALID_SUB, 'bad');
    expect(res.status).toBe(401);
  });

  it('POST /push/subscribe with a malformed body returns 400', async () => {
    const res = await post('/push/subscribe', { endpoint: 'not-a-url' }, 'good');
    expect(res.status).toBe(400);
    expect(putSubscription).not.toHaveBeenCalled();
  });

  it('POST /push/subscribe with a valid body persists the subscription', async () => {
    const res = await post('/push/subscribe', VALID_SUB, 'good');
    expect(res.status).toBe(200);
    expect(putSubscription).toHaveBeenCalledWith('u1', VALID_SUB.endpoint, 'p256dh-key', 'auth-key');
  });

  it('POST /push/unsubscribe with a valid body deletes by endpoint', async () => {
    const res = await post('/push/unsubscribe', { endpoint: VALID_SUB.endpoint }, 'good');
    expect(res.status).toBe(200);
    expect(deleteSubscriptionByEndpoint).toHaveBeenCalledWith(VALID_SUB.endpoint);
  });
});
