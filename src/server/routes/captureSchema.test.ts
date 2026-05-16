import { describe, it, expect } from 'vitest';
import { captureSchema, DIAG_CAPTURE_MAX_LOG_ENTRIES } from './captureSchema.js';

/**
 * Pure unit coverage for the `/diag/capture` body schema. No server, no
 * `node:sqlite` (that's why the schema is its own module). Locks the
 * 2026-05-16 regression: the client diag ring was raised 2000 -> 30000
 * for the warp-out transit timeline but this cap was left at 2000, so
 * every >2000-entry capture 400'd ("invalid capture") and wasted
 * on-device smoke tests.
 */
describe('captureSchema (unit)', () => {
  const mkLogs = (n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => ({ ts: i, tag: 'snapshot', data: {} }));

  it(`cap is ${DIAG_CAPTURE_MAX_LOG_ENTRIES} and MUST match ClientLogger.DIAG_MAX_ENTRIES`, () => {
    // Cross-zone sync is by hand (server cannot import the client const).
    // If this changes, change DIAG_MAX_ENTRIES in
    // src/client/debug/ClientLogger.ts in the same commit.
    expect(DIAG_CAPTURE_MAX_LOG_ENTRIES).toBe(30000);
  });

  it('accepts exactly DIAG_CAPTURE_MAX_LOG_ENTRIES entries', () => {
    expect(captureSchema.safeParse({ logs: mkLogs(DIAG_CAPTURE_MAX_LOG_ENTRIES) }).success).toBe(true);
  });

  it('rejects one entry over the cap', () => {
    expect(captureSchema.safeParse({ logs: mkLogs(DIAG_CAPTURE_MAX_LOG_ENTRIES + 1) }).success).toBe(false);
  });

  it('accepts > the old 2000 cap (the exact regression that 400d on device)', () => {
    expect(captureSchema.safeParse({ logs: mkLogs(2500) }).success).toBe(true);
  });

  it('accepts realistic warp-out marker entries (nested object/array data)', () => {
    const r = captureSchema.safeParse({
      note: 'warp-out',
      userAgent: 'Mozilla/5.0 (Linux; Android 10) Mobile',
      viewport: { w: 411, h: 809 },
      clientEpochMs: 1_700_000_000_000,
      logs: [
        { ts: 1, tag: 'transit_mark', data: { phase: 'curtain_down', sinceEngageMs: 6451, stepMs: 2473 } },
        { ts: 2, tag: 'transit_frame', data: { idx: 0, sinceCurtainMs: 1, elapsedMs: 11, spriteCount: 19 } },
        { ts: 3, tag: 'renderer_update', data: { totalMs: 1.7, spriteCount: 19 } },
        { ts: 4, tag: 'longtask', data: { durationMs: 51, attribution: [{ containerType: 'window' }] } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects logs that are not an array (the malformed-400 path)', () => {
    expect(captureSchema.safeParse({ logs: 'not an array' }).success).toBe(false);
  });

  it('is strict — rejects an unknown top-level key', () => {
    expect(captureSchema.safeParse({ logs: [], bogus: 1 }).success).toBe(false);
  });
});
