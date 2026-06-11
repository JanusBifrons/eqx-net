import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  resolveCorsPolicy,
  corsMiddleware,
  securityHeadersMiddleware,
} from './httpCors.js';

/** Minimal Response double that records `header()` writes. */
function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    header(name: string, value: string) {
      headers[name] = value;
      return res;
    },
  } as unknown as Response;
  return { res, headers };
}

function makeReq(origin?: string): Request {
  return {
    headers: origin === undefined ? {} : { origin },
  } as unknown as Request;
}

function run(
  mw: (req: Request, res: Response, next: () => void) => void,
  origin?: string,
) {
  const { res, headers } = makeRes();
  let nextCalled = false;
  mw(makeReq(origin), res, () => {
    nextCalled = true;
  });
  return { headers, nextCalled };
}

describe('resolveCorsPolicy', () => {
  it('parses a comma-separated ALLOWED_ORIGINS list, trimming blanks (no reflect)', () => {
    const p = resolveCorsPolicy({
      ALLOWED_ORIGINS: 'https://a.example , https://b.example ,',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(p.reflectAny).toBe(false);
    expect([...p.allowed].sort()).toEqual(['https://a.example', 'https://b.example']);
  });

  it('reflects ANY origin in non-production when unset (dev/LAN/netgate ergonomics)', () => {
    const p = resolveCorsPolicy({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(p.reflectAny).toBe(true);
  });

  it('is closed in production when no list is configured (no reflect, empty allowlist)', () => {
    const p = resolveCorsPolicy({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(p.reflectAny).toBe(false);
    expect(p.allowed.size).toBe(0);
  });

  it('an explicit ALLOWED_ORIGINS disables reflect even in non-production', () => {
    const p = resolveCorsPolicy({
      ALLOWED_ORIGINS: 'https://staging.example',
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(p.reflectAny).toBe(false);
    expect([...p.allowed]).toEqual(['https://staging.example']);
  });
});

describe('corsMiddleware', () => {
  const allowlist = { reflectAny: false, allowed: new Set(['https://app.example']) };
  const reflectAny = { reflectAny: true, allowed: new Set<string>() };

  it('echoes an allowed Origin with Vary + ACA-Headers/Methods', () => {
    const { headers, nextCalled } = run(corsMiddleware(allowlist), 'https://app.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(headers['Vary']).toBe('Origin');
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
    expect(nextCalled).toBe(true);
  });

  it('emits no ACAO for a disallowed Origin under an allowlist (browser blocks the read)', () => {
    const { headers, nextCalled } = run(corsMiddleware(allowlist), 'https://evil.example');
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('reflect-any echoes whatever origin is sent (dev) — e.g. a LAN IP / alt port', () => {
    const { headers } = run(corsMiddleware(reflectAny), 'http://192.168.1.5:5274');
    expect(headers['Access-Control-Allow-Origin']).toBe('http://192.168.1.5:5274');
    expect(headers['Vary']).toBe('Origin');
  });

  it('passes through requests with no Origin header (same-origin / non-browser)', () => {
    const { headers, nextCalled } = run(corsMiddleware(allowlist));
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('never echoes a literal wildcard, even when reflecting', () => {
    const { headers } = run(corsMiddleware(reflectAny), 'https://app.example');
    expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
  });
});

describe('securityHeadersMiddleware', () => {
  it('sets nosniff / DENY / no-referrer in every environment', () => {
    const { headers } = run(
      securityHeadersMiddleware({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    );
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('omits HSTS in non-production (no https pinning over dev HTTP)', () => {
    const { headers } = run(
      securityHeadersMiddleware({ NODE_ENV: 'development' } as NodeJS.ProcessEnv),
    );
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('emits HSTS only in production', () => {
    const { headers } = run(
      securityHeadersMiddleware({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    );
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });
});
