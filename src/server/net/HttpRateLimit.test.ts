import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { createRateLimiter, clientIp } from './HttpRateLimit.js';

function makeReq(ip: string, forwarded?: string): Request {
  return {
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
    socket: { remoteAddress: ip },
  } as unknown as Request;
}

interface RunResult {
  status: number | null;
  retryAfter: string | null;
  nextCalled: boolean;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let status: number | null = null;
  const res = {
    header(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  } as unknown as Response;
  return { res, headers, getStatus: () => status };
}

function fire(
  mw: ReturnType<typeof createRateLimiter>,
  req: Request,
): RunResult {
  const { res, headers, getStatus } = makeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  return { status: getStatus(), retryAfter: headers['Retry-After'] ?? null, nextCalled };
}

describe('clientIp', () => {
  it('prefers the first x-forwarded-for hop', () => {
    expect(clientIp(makeReq('10.0.0.1', '1.2.3.4, 5.6.7.8'))).toBe('1.2.3.4');
  });
  it('falls back to the socket address', () => {
    expect(clientIp(makeReq('10.0.0.1'))).toBe('10.0.0.1');
  });
});

describe('createRateLimiter', () => {
  it('allows up to max requests then 429s with Retry-After', () => {
    let t = 1_000_000;
    const mw = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
    const req = makeReq('1.1.1.1');
    expect(fire(mw, req).nextCalled).toBe(true);
    expect(fire(mw, req).nextCalled).toBe(true);
    expect(fire(mw, req).nextCalled).toBe(true);
    const fourth = fire(mw, req);
    expect(fourth.nextCalled).toBe(false);
    expect(fourth.status).toBe(429);
    expect(Number(fourth.retryAfter)).toBeGreaterThan(0);
  });

  it('isolates budgets per key (IP)', () => {
    let t = 1_000_000;
    const mw = createRateLimiter({ windowMs: 60_000, max: 1, now: () => t });
    expect(fire(mw, makeReq('1.1.1.1')).nextCalled).toBe(true);
    expect(fire(mw, makeReq('1.1.1.1')).nextCalled).toBe(false); // over
    expect(fire(mw, makeReq('2.2.2.2')).nextCalled).toBe(true); // different IP, fresh
  });

  it('rolls over the window after windowMs', () => {
    let t = 1_000_000;
    const mw = createRateLimiter({ windowMs: 60_000, max: 1, now: () => t });
    const req = makeReq('1.1.1.1');
    expect(fire(mw, req).nextCalled).toBe(true);
    expect(fire(mw, req).nextCalled).toBe(false);
    t += 60_001; // window elapsed
    expect(fire(mw, req).nextCalled).toBe(true);
  });

  it('bounds the key map, evicting the soonest-resetting bucket on overflow', () => {
    let t = 1_000_000;
    const mw = createRateLimiter({ windowMs: 60_000, max: 5, now: () => t, maxKeys: 2 });
    fire(mw, makeReq('1.1.1.1')); // bucket resets at t+60000
    t += 10;
    fire(mw, makeReq('2.2.2.2')); // resets later
    t += 10;
    fire(mw, makeReq('3.3.3.3')); // overflow → evicts soonest-resetting (1.1.1.1)
    // 1.1.1.1 was evicted, so it starts a fresh budget and is allowed again.
    expect(fire(mw, makeReq('1.1.1.1')).nextCalled).toBe(true);
  });
});
