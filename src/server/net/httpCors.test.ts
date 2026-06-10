import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  resolveAllowedOrigins,
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

describe('resolveAllowedOrigins', () => {
  it('parses a comma-separated ALLOWED_ORIGINS list, trimming blanks', () => {
    const set = resolveAllowedOrigins({
      ALLOWED_ORIGINS: 'https://a.example , https://b.example ,',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect([...set].sort()).toEqual(['https://a.example', 'https://b.example']);
  });

  it('defaults to the Vite dev origin in non-production when unset', () => {
    const set = resolveAllowedOrigins({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect([...set]).toEqual(['http://localhost:5173']);
  });

  it('is EMPTY in production when no list is configured (safe default)', () => {
    const set = resolveAllowedOrigins({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(set.size).toBe(0);
  });

  it('lets an explicit ALLOWED_ORIGINS override the dev default', () => {
    const set = resolveAllowedOrigins({
      ALLOWED_ORIGINS: 'https://staging.example',
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect([...set]).toEqual(['https://staging.example']);
  });
});

describe('corsMiddleware', () => {
  const allow = new Set(['https://app.example']);

  it('echoes an allowed Origin with Vary + ACA-Headers/Methods', () => {
    const { headers, nextCalled } = run(corsMiddleware(allow), 'https://app.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example');
    expect(headers['Vary']).toBe('Origin');
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
    expect(nextCalled).toBe(true);
  });

  it('emits no ACAO for a disallowed Origin (browser blocks the read)', () => {
    const { headers, nextCalled } = run(corsMiddleware(allow), 'https://evil.example');
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('passes through requests with no Origin header (same-origin / non-browser)', () => {
    const { headers, nextCalled } = run(corsMiddleware(allow));
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(nextCalled).toBe(true);
  });

  it('never echoes a wildcard, even with an allowed origin', () => {
    const { headers } = run(corsMiddleware(allow), 'https://app.example');
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
