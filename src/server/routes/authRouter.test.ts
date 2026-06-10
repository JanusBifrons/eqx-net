import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mock the service layer so the ROUTES are tested in isolation (no bcrypt, no
// SQLite, no DB worker) — the A0 route-level lock. AuthService/jwt behaviour is
// locked separately in jwt.test.ts. This pattern mirrors diagRouter.test.ts.
const authServiceMock = {
  register: vi.fn(async (email: string) => ({ token: 'tok-reg', user: { id: 'u1', email, displayName: null } })),
  login: vi.fn(async (email: string) => ({ token: 'tok-login', user: { id: 'u1', email, displayName: null } })),
  validateToken: vi.fn(async (token: string) => (token === 'good' ? 'u1' : null)),
  getUser: vi.fn((id: string) => ({ id, email: 'u@test.local', displayName: null })),
  updateDisplayName: vi.fn((id: string, displayName: string) => ({ id, email: 'u@test.local', displayName })),
  findOrCreateGoogleUser: vi.fn(async () => ({ token: 'tok-google', user: { id: 'g1', email: 'g@test.local', displayName: 'G' } })),
  findOrCreateTestUser: vi.fn(async (email: string) => ({ token: 'tok-test', user: { id: 't1', email, displayName: 'E2E Tester' } })),
};
vi.mock('../auth/AuthService.js', () => authServiceMock);
vi.mock('../auth/GoogleOAuth.js', () => ({
  authorizationUrl: (state: string) => `https://accounts.example/o?state=${encodeURIComponent(state)}`,
  exchangeCode: async () => ({ id: 'g1', email: 'g@test.local', name: 'G' }),
}));
vi.mock('../stats/StatsService.js', () => ({ recordLoginEvent: vi.fn() }));

let app: Express;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const mod = await import('./authRouter.js');
  app = express();
  app.use(express.json());
  app.use('/auth', mod.authRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Each test uses a distinct forwarded IP so the per-IP rate limiter (shared at
 *  module scope across routes) never couples one test's budget to another's. */
function post(path: string, body: unknown, ip = `10.0.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('authRouter — register/login (A0 lock)', () => {
  it('POST /auth/register with a valid body returns 200 { token, user }', async () => {
    const res = await post('/auth/register', {
      email: 'new@test.local',
      password: 'longenough',
      confirmPassword: 'longenough',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; user: { email: string } };
    expect(body.token).toBe('tok-reg');
    expect(body.user.email).toBe('new@test.local');
  });

  it('POST /auth/register with a malformed body returns 400', async () => {
    const res = await post('/auth/register', { email: 'not-an-email', password: 'x' });
    expect(res.status).toBe(400);
  });

  it('POST /auth/login with valid creds returns 200 { token, user }', async () => {
    const res = await post('/auth/login', { email: 'u@test.local', password: 'pw' });
    expect(res.status).toBe(200);
    expect((await res.json() as { token: string }).token).toBe('tok-login');
  });

  it('POST /auth/login with bad creds returns 401', async () => {
    authServiceMock.login.mockRejectedValueOnce(new Error('INVALID_CREDENTIALS'));
    const res = await post('/auth/login', { email: 'u@test.local', password: 'wrong' });
    expect(res.status).toBe(401);
  });
});

describe('authRouter — /me (A0 lock)', () => {
  it('GET /auth/me without a bearer token returns 401', async () => {
    const res = await fetch(`${baseUrl}/auth/me`);
    expect(res.status).toBe(401);
  });

  it('GET /auth/me with a valid token returns the user', async () => {
    const res = await fetch(`${baseUrl}/auth/me`, { headers: { authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    expect((await res.json() as { user: { id: string } }).user.id).toBe('u1');
  });
});

describe('authRouter — OAuth callback redirect shape (A0 lock; A3 changes this)', () => {
  it('GET /auth/google/callback puts the JWT in the redirect URL as ?token=', async () => {
    // Seed CSRF state via /auth/google, then extract it from the redirect.
    const googleRes = await fetch(`${baseUrl}/auth/google`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '10.50.50.50' },
    });
    const location = googleRes.headers.get('location')!;
    const state = new URL(location).searchParams.get('state')!;

    const cbRes = await fetch(
      `${baseUrl}/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { 'x-forwarded-for': '10.50.50.50' } },
    );
    expect(cbRes.status).toBe(302);
    const cbLocation = cbRes.headers.get('location')!;
    // CURRENT behaviour (S3): token in the URL. A3 will flip this to ?authCode=.
    expect(cbLocation).toMatch(/^\/\?token=/);
    expect(cbLocation).toContain('tok-google');
  });

  it('GET /auth/google/callback with an unknown state is rejected (400)', async () => {
    const res = await fetch(
      `${baseUrl}/auth/google/callback?code=abc&state=never-issued`,
      { redirect: 'manual', headers: { 'x-forwarded-for': '10.51.51.51' } },
    );
    expect(res.status).toBe(400);
  });
});

describe('authRouter — rate limiting (A2)', () => {
  it('429s after the login budget is exceeded for one IP', async () => {
    const ip = '203.0.113.7';
    let saw429 = false;
    let retryAfter: string | null = null;
    // AUTH_WRITE_MAX is 10/min; 12 hits from one IP guarantees a 429.
    for (let i = 0; i < 12; i++) {
      const res = await post('/auth/login', { email: 'u@test.local', password: 'pw' }, ip);
      if (res.status === 429) {
        saw429 = true;
        retryAfter = res.headers.get('retry-after');
        break;
      }
    }
    expect(saw429).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('a different IP is unaffected by another IP hitting its limit', async () => {
    const res = await post('/auth/login', { email: 'u@test.local', password: 'pw' }, '198.51.100.9');
    expect(res.status).toBe(200);
  });
});
