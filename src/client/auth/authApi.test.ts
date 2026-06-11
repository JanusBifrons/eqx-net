import { describe, it, expect, vi, afterEach } from 'vitest';
import { exchangeAuthCode } from './authApi.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeAuthCode (S3 client half)', () => {
  it('POSTs the code to /auth/exchange and returns { token, user }', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ token: 'jwt', user: { id: 'u1', email: 'e', displayName: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await exchangeAuthCode('the-code');
    expect(res.token).toBe('jwt');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/auth/exchange');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ code: 'the-code' });
  });

  it('throws on a non-OK response (expired / replayed code)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Invalid or expired code' }), { status: 401 }),
    ));
    await expect(exchangeAuthCode('bad')).rejects.toThrow(/Invalid or expired code/);
  });
});
